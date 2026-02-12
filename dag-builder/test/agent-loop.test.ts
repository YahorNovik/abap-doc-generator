import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { callLlmAgentLoop } from "../src/llm-client";
import { LlmConfig, LlmMessage, ToolDefinition, ToolCall } from "../src/types";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);
vi.spyOn(process.stderr, "write").mockImplementation(() => true);

const TOOLS: ToolDefinition[] = [
  {
    name: "get_source",
    description: "Fetch ABAP source code.",
    parameters: {
      type: "object",
      properties: {
        object_name: { type: "string", description: "Object name" },
      },
      required: ["object_name"],
    },
  },
];

const MESSAGES: LlmMessage[] = [
  { role: "system", content: "You are an ABAP documentation expert." },
  { role: "user", content: "Document ZCL_ROOT." },
];

const mockToolExecutor = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  mockToolExecutor.mockReset();
});

// ─── OpenAI helpers ───

function openaiTextResponse(text: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    }),
  };
}

function openaiToolCallResponse(toolCalls: Array<{ id: string; name: string; args: any }>) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{
        message: {
          content: null,
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: JSON.stringify(tc.args) },
          })),
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    }),
  };
}

// ─── Gemini helpers ───

function geminiTextResponse(text: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text }] } }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
    }),
  };
}

function geminiToolCallResponse(calls: Array<{ name: string; args: any }>) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{
        content: {
          parts: calls.map((c) => ({ functionCall: { name: c.name, args: c.args } })),
        },
      }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
    }),
  };
}

// ─── OpenAI Tests ───

describe("OpenAI agent loop", () => {
  const config: LlmConfig = {
    provider: "openai",
    apiKey: "sk-test",
    model: "gpt-4o",
  };

  it("should return text response when no tools are used", async () => {
    mockFetch.mockResolvedValueOnce(openaiTextResponse("# Documentation\nFull doc here."));

    const result = await callLlmAgentLoop(config, MESSAGES, TOOLS, mockToolExecutor);

    expect(result.content).toBe("# Documentation\nFull doc here.");
    expect(result.usage.promptTokens).toBe(100);
    expect(result.usage.completionTokens).toBe(50);
    expect(mockToolExecutor).not.toHaveBeenCalled();

    // Verify tools were sent in request body
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].type).toBe("function");
    expect(body.tools[0].function.name).toBe("get_source");
  });

  it("should handle one tool call iteration", async () => {
    mockFetch
      .mockResolvedValueOnce(openaiToolCallResponse([
        { id: "call_1", name: "get_source", args: { object_name: "ZCL_HELPER" } },
      ]))
      .mockResolvedValueOnce(openaiTextResponse("Documentation with helper source."));

    mockToolExecutor.mockResolvedValueOnce("CLASS zcl_helper DEFINITION. ENDCLASS.");

    const result = await callLlmAgentLoop(config, MESSAGES, TOOLS, mockToolExecutor);

    expect(result.content).toBe("Documentation with helper source.");
    expect(mockToolExecutor).toHaveBeenCalledOnce();
    expect(mockToolExecutor).toHaveBeenCalledWith(
      expect.objectContaining({ name: "get_source", arguments: { object_name: "ZCL_HELPER" } }),
    );
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Verify second call includes assistant + tool messages
    const body2 = JSON.parse(mockFetch.mock.calls[1][1].body);
    const messages2 = body2.messages;
    const assistantMsg = messages2.find((m: any) => m.role === "assistant" && m.tool_calls);
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg.tool_calls[0].id).toBe("call_1");
    const toolMsg = messages2.find((m: any) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg.tool_call_id).toBe("call_1");
    expect(toolMsg.content).toBe("CLASS zcl_helper DEFINITION. ENDCLASS.");

    // Tokens accumulated from both calls
    expect(result.usage.promptTokens).toBe(200);
    expect(result.usage.completionTokens).toBe(100);
  });

  it("should handle multiple simultaneous tool calls", async () => {
    mockFetch
      .mockResolvedValueOnce(openaiToolCallResponse([
        { id: "call_1", name: "get_source", args: { object_name: "ZCL_A" } },
        { id: "call_2", name: "get_source", args: { object_name: "ZCL_B" } },
      ]))
      .mockResolvedValueOnce(openaiTextResponse("Doc with both sources."));

    mockToolExecutor
      .mockResolvedValueOnce("SOURCE A")
      .mockResolvedValueOnce("SOURCE B");

    const result = await callLlmAgentLoop(config, MESSAGES, TOOLS, mockToolExecutor);

    expect(result.content).toBe("Doc with both sources.");
    expect(mockToolExecutor).toHaveBeenCalledTimes(2);
  });

  it("should stop at max iterations and force final response", async () => {
    // Always return tool calls
    mockFetch.mockResolvedValue(openaiToolCallResponse([
      { id: "call_n", name: "get_source", args: { object_name: "ZCL_LOOP" } },
    ]));
    mockToolExecutor.mockResolvedValue("source code");

    // Override the last call to be a text response (this is the fallback callLlm)
    const callCount = { n: 0 };
    mockFetch.mockImplementation(async () => {
      callCount.n++;
      // After 3 iterations (maxIterations=3) + 1 final forced call
      if (callCount.n > 3) {
        return openaiTextResponse("Forced final doc.");
      }
      return openaiToolCallResponse([
        { id: `call_${callCount.n}`, name: "get_source", args: { object_name: "ZCL_LOOP" } },
      ]);
    });

    const result = await callLlmAgentLoop(config, MESSAGES, TOOLS, mockToolExecutor, 3);

    expect(result.content).toBe("Forced final doc.");
    expect(mockToolExecutor).toHaveBeenCalledTimes(3);
  });

  it("should handle tool executor errors gracefully", async () => {
    mockFetch
      .mockResolvedValueOnce(openaiToolCallResponse([
        { id: "call_1", name: "get_source", args: { object_name: "ZCL_MISSING" } },
      ]))
      .mockResolvedValueOnce(openaiTextResponse("Doc noting the missing source."));

    mockToolExecutor.mockRejectedValueOnce(new Error("Object ZCL_MISSING not found"));

    const result = await callLlmAgentLoop(config, MESSAGES, TOOLS, mockToolExecutor);

    expect(result.content).toBe("Doc noting the missing source.");

    // Verify error was sent as tool result
    const body2 = JSON.parse(mockFetch.mock.calls[1][1].body);
    const toolMsg = body2.messages.find((m: any) => m.role === "tool");
    expect(toolMsg.content).toContain("Error: Object ZCL_MISSING not found");
  });
});

// ─── Gemini Tests ───

describe("Gemini agent loop", () => {
  const config: LlmConfig = {
    provider: "gemini",
    apiKey: "gemini-key",
    model: "gemini-2.5-pro",
  };

  it("should return text response when no tools are used", async () => {
    mockFetch.mockResolvedValueOnce(geminiTextResponse("Gemini documentation."));

    const result = await callLlmAgentLoop(config, MESSAGES, TOOLS, mockToolExecutor);

    expect(result.content).toBe("Gemini documentation.");
    expect(mockToolExecutor).not.toHaveBeenCalled();

    // Verify tools in Gemini format
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.tools[0].functionDeclarations).toHaveLength(1);
    expect(body.tools[0].functionDeclarations[0].name).toBe("get_source");
    expect(body.tools[0].functionDeclarations[0].parameters.type).toBe("OBJECT");
  });

  it("should handle one tool call iteration", async () => {
    mockFetch
      .mockResolvedValueOnce(geminiToolCallResponse([
        { name: "get_source", args: { object_name: "ZCL_HELPER" } },
      ]))
      .mockResolvedValueOnce(geminiTextResponse("Gemini doc with helper."));

    mockToolExecutor.mockResolvedValueOnce("CLASS zcl_helper DEFINITION. ENDCLASS.");

    const result = await callLlmAgentLoop(config, MESSAGES, TOOLS, mockToolExecutor);

    expect(result.content).toBe("Gemini doc with helper.");
    expect(mockToolExecutor).toHaveBeenCalledOnce();
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Verify second call includes functionCall and functionResponse
    const body2 = JSON.parse(mockFetch.mock.calls[1][1].body);
    const contents = body2.contents;

    // Find model message with functionCall
    const modelMsg = contents.find((c: any) =>
      c.role === "model" && c.parts.some((p: any) => p.functionCall),
    );
    expect(modelMsg).toBeDefined();
    expect(modelMsg.parts[0].functionCall.name).toBe("get_source");

    // Find user message with functionResponse
    const responseMsg = contents.find((c: any) =>
      c.parts.some((p: any) => p.functionResponse),
    );
    expect(responseMsg).toBeDefined();
    expect(responseMsg.parts[0].functionResponse.name).toBe("get_source");
    expect(responseMsg.parts[0].functionResponse.response.content).toBe(
      "CLASS zcl_helper DEFINITION. ENDCLASS.",
    );
  });

  it("should group multiple functionResponse parts in a single message", async () => {
    mockFetch
      .mockResolvedValueOnce(geminiToolCallResponse([
        { name: "get_source", args: { object_name: "ZCL_A" } },
        { name: "get_source", args: { object_name: "ZCL_B" } },
      ]))
      .mockResolvedValueOnce(geminiTextResponse("Doc with both."));

    mockToolExecutor
      .mockResolvedValueOnce("SOURCE A")
      .mockResolvedValueOnce("SOURCE B");

    await callLlmAgentLoop(config, MESSAGES, TOOLS, mockToolExecutor);

    // Verify functionResponses are grouped in one user message
    const body2 = JSON.parse(mockFetch.mock.calls[1][1].body);
    const responseMessages = body2.contents.filter((c: any) =>
      c.parts.some((p: any) => p.functionResponse),
    );
    expect(responseMessages).toHaveLength(1);
    expect(responseMessages[0].parts).toHaveLength(2);
    expect(responseMessages[0].parts[0].functionResponse.name).toBe("get_source");
    expect(responseMessages[0].parts[1].functionResponse.name).toBe("get_source");
  });
});

// ─── openai-compatible fallback ───

describe("openai-compatible fallback", () => {
  const config: LlmConfig = {
    provider: "openai-compatible",
    apiKey: "key",
    model: "llama3",
    baseUrl: "http://localhost:11434/v1",
  };

  it("should fall back to single call without tools", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: "Local doc." } }],
        usage: { prompt_tokens: 50, completion_tokens: 30 },
      }),
    });

    const result = await callLlmAgentLoop(config, MESSAGES, TOOLS, mockToolExecutor);

    expect(result.content).toBe("Local doc.");
    expect(mockToolExecutor).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Verify NO tools in request body
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.tools).toBeUndefined();
  });
});

// ─── Retry within agent loop ───

describe("retry in agent loop", () => {
  const config: LlmConfig = {
    provider: "openai",
    apiKey: "sk-test",
    model: "gpt-4o",
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should retry on 429 within agent loop", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => "Rate limited",
      })
      .mockResolvedValueOnce(openaiTextResponse("OK after retry"));

    const promise = callLlmAgentLoop(config, MESSAGES, TOOLS, mockToolExecutor);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(result.content).toBe("OK after retry");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
