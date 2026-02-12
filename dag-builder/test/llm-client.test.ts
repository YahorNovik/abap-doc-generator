import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { callLlm, submitBatch, pollBatch, getBatchResults } from "../src/llm-client";
import { LlmConfig, LlmMessage, BatchRequest } from "../src/types";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Suppress stderr output during tests
vi.spyOn(process.stderr, "write").mockImplementation(() => true);

const MESSAGES: LlmMessage[] = [
  { role: "system", content: "You are an assistant." },
  { role: "user", content: "Summarize this code." },
];

function geminiOkResponse(text: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 },
    }),
  };
}

function openaiOkResponse(text: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: text } }],
      usage: { prompt_tokens: 15, completion_tokens: 25 },
    }),
  };
}

function errorResponse(status: number) {
  return {
    ok: false,
    status,
    text: async () => `Error ${status}`,
  };
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe("Gemini provider", () => {
  const config: LlmConfig = {
    provider: "gemini",
    apiKey: "test-key",
    model: "gemini-2.0-flash",
  };

  it("should call Gemini API with correct URL and body", async () => {
    mockFetch.mockResolvedValueOnce(geminiOkResponse("Summary here"));

    const result = await callLlm(config, MESSAGES);

    expect(result.content).toBe("Summary here");
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 20 });

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("generativelanguage.googleapis.com");
    expect(url).toContain("gemini-2.0-flash:generateContent");
    expect(url).toContain("key=test-key");

    const body = JSON.parse(opts.body);
    // System message should be in systemInstruction, not contents
    expect(body.systemInstruction.parts[0].text).toBe("You are an assistant.");
    // Only non-system messages in contents
    expect(body.contents).toHaveLength(1);
    expect(body.contents[0].role).toBe("user");
    expect(body.contents[0].parts[0].text).toBe("Summarize this code.");
  });

  it("should map assistant role to model", async () => {
    mockFetch.mockResolvedValueOnce(geminiOkResponse("ok"));

    await callLlm(config, [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "bye" },
    ]);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.contents[1].role).toBe("model");
  });
});

describe("OpenAI provider", () => {
  const config: LlmConfig = {
    provider: "openai",
    apiKey: "sk-test-key",
    model: "gpt-4o",
  };

  it("should call OpenAI API with correct URL and body", async () => {
    mockFetch.mockResolvedValueOnce(openaiOkResponse("Doc here"));

    const result = await callLlm(config, MESSAGES);

    expect(result.content).toBe("Doc here");
    expect(result.usage).toEqual({ promptTokens: 15, completionTokens: 25 });

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(opts.headers["Authorization"]).toBe("Bearer sk-test-key");

    const body = JSON.parse(opts.body);
    expect(body.model).toBe("gpt-4o");
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1].role).toBe("user");
  });
});

describe("OpenAI-compatible provider", () => {
  const config: LlmConfig = {
    provider: "openai-compatible",
    apiKey: "local-key",
    model: "llama3",
    baseUrl: "http://localhost:11434/v1",
  };

  it("should call custom base URL", async () => {
    mockFetch.mockResolvedValueOnce(openaiOkResponse("Local result"));

    const result = await callLlm(config, MESSAGES);

    expect(result.content).toBe("Local result");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("http://localhost:11434/v1/chat/completions");
  });

  it("should error if baseUrl is missing", async () => {
    const badConfig: LlmConfig = {
      provider: "openai-compatible",
      apiKey: "key",
      model: "model",
    };

    await expect(callLlm(badConfig, MESSAGES)).rejects.toThrow("baseUrl is required");
  });
});

describe("retry logic", () => {
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

  it("should retry on 429 and succeed", async () => {
    mockFetch
      .mockResolvedValueOnce(errorResponse(429))
      .mockResolvedValueOnce(openaiOkResponse("Retried OK"));

    const promise = callLlm(config, MESSAGES);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;
    expect(result.content).toBe("Retried OK");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("should retry on 500 and succeed", async () => {
    mockFetch
      .mockResolvedValueOnce(errorResponse(500))
      .mockResolvedValueOnce(openaiOkResponse("OK after 500"));

    const promise = callLlm(config, MESSAGES);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;
    expect(result.content).toBe("OK after 500");
  });

  it("should throw on non-retryable errors", async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(401));

    await expect(callLlm(config, MESSAGES)).rejects.toThrow("401");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("should throw after max retries exhausted", async () => {
    mockFetch.mockResolvedValue(errorResponse(429));

    const promise = callLlm(config, MESSAGES).catch((err) => err);
    // Advance through all retry delays: 1000 + 3000 + 8000
    await vi.advanceTimersByTimeAsync(15000);
    const err = await promise;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("429");
    expect(mockFetch).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
  });
});

describe("defaults", () => {
  it("should use default maxTokens and temperature", async () => {
    const config: LlmConfig = {
      provider: "openai",
      apiKey: "sk-test",
      model: "gpt-4o",
    };

    mockFetch.mockResolvedValueOnce(openaiOkResponse("ok"));
    await callLlm(config, [{ role: "user", content: "hi" }]);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.max_tokens).toBe(2048);
    expect(body.temperature).toBe(0.3);
  });

  it("should use custom maxTokens and temperature", async () => {
    const config: LlmConfig = {
      provider: "openai",
      apiKey: "sk-test",
      model: "gpt-4o",
      maxTokens: 4096,
      temperature: 0.7,
    };

    mockFetch.mockResolvedValueOnce(openaiOkResponse("ok"));
    await callLlm(config, [{ role: "user", content: "hi" }]);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.max_tokens).toBe(4096);
    expect(body.temperature).toBe(0.7);
  });
});

// ─── Batch API tests ───

const BATCH_REQUESTS: BatchRequest[] = [
  { id: "ZCL_UTILS", messages: [{ role: "user", content: "Summarize ZCL_UTILS" }] },
  { id: "ZCL_HELPER", messages: [{ role: "user", content: "Summarize ZCL_HELPER" }] },
];

describe("OpenAI batch", () => {
  const config: LlmConfig = {
    provider: "openai",
    apiKey: "sk-batch-test",
    model: "gpt-4o-mini",
  };

  it("should submit batch with JSONL upload and batch creation", async () => {
    // Mock file upload
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ id: "file-abc123" }),
    });
    // Mock batch creation
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ id: "batch-xyz789" }),
    });

    const batchId = await submitBatch(config, BATCH_REQUESTS);
    expect(batchId).toBe("batch-xyz789");

    // Verify file upload call
    const [fileUrl, fileOpts] = mockFetch.mock.calls[0];
    expect(fileUrl).toBe("https://api.openai.com/v1/files");
    expect(fileOpts.headers["Authorization"]).toBe("Bearer sk-batch-test");

    // Verify batch creation call
    const [batchUrl, batchOpts] = mockFetch.mock.calls[1];
    expect(batchUrl).toBe("https://api.openai.com/v1/batches");
    const batchBody = JSON.parse(batchOpts.body);
    expect(batchBody.input_file_id).toBe("file-abc123");
    expect(batchBody.endpoint).toBe("/v1/chat/completions");
    expect(batchBody.completion_window).toBe("24h");
  });

  it("should poll batch status", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        id: "batch-xyz789",
        status: "in_progress",
        request_counts: { total: 2, completed: 1, failed: 0 },
      }),
    });

    const status = await pollBatch(config, "batch-xyz789");
    expect(status.state).toBe("running");
    expect(status.completedCount).toBe(1);
    expect(status.totalCount).toBe(2);
  });

  it("should retrieve batch results from JSONL", async () => {
    // Mock poll to get output_file_id
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        id: "batch-xyz789",
        status: "completed",
        output_file_id: "file-output-123",
        request_counts: { total: 2, completed: 2, failed: 0 },
      }),
    });
    // Mock file download
    const outputJsonl = [
      JSON.stringify({
        custom_id: "ZCL_UTILS",
        response: {
          status_code: 200,
          body: {
            choices: [{ message: { content: "Utils summary" } }],
            usage: { prompt_tokens: 10, completion_tokens: 20 },
          },
        },
      }),
      JSON.stringify({
        custom_id: "ZCL_HELPER",
        response: {
          status_code: 200,
          body: {
            choices: [{ message: { content: "Helper summary" } }],
            usage: { prompt_tokens: 15, completion_tokens: 25 },
          },
        },
      }),
    ].join("\n");

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => outputJsonl,
    });

    const results = await getBatchResults(config, "batch-xyz789");
    expect(results.size).toBe(2);
    expect(results.get("ZCL_UTILS")!.content).toBe("Utils summary");
    expect(results.get("ZCL_HELPER")!.content).toBe("Helper summary");
    expect(results.get("ZCL_UTILS")!.usage).toEqual({ promptTokens: 10, completionTokens: 20 });
  });

  it("should handle batch errors in results", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        status: "completed",
        output_file_id: "file-out",
        request_counts: { total: 1, completed: 0, failed: 1 },
      }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        custom_id: "ZCL_BROKEN",
        error: { code: "invalid_request", message: "Model not found" },
      }),
    });

    const results = await getBatchResults(config, "batch-err");
    expect(results.get("ZCL_BROKEN")!.content).toContain("Batch error");
  });
});

describe("Gemini batch", () => {
  const config: LlmConfig = {
    provider: "gemini",
    apiKey: "gemini-batch-key",
    model: "gemini-2.0-flash",
  };

  it("should submit batch and handle synchronous response", async () => {
    // Gemini may return results directly for small batches
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        responses: [
          {
            candidates: [{ content: { parts: [{ text: "Utils summary" }] } }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 },
          },
          {
            candidates: [{ content: { parts: [{ text: "Helper summary" }] } }],
            usageMetadata: { promptTokenCount: 15, candidatesTokenCount: 25 },
          },
        ],
      }),
    });

    const batchId = await submitBatch(config, BATCH_REQUESTS);
    expect(batchId).toContain("gemini-sync-");

    // Poll should return completed immediately
    const status = await pollBatch(config, batchId);
    expect(status.state).toBe("completed");

    // Get results
    const results = await getBatchResults(config, batchId);
    expect(results.size).toBe(2);
    expect(results.get("ZCL_UTILS")!.content).toBe("Utils summary");
    expect(results.get("ZCL_HELPER")!.content).toBe("Helper summary");
  });

  it("should submit batch with correct Gemini request format", async () => {
    const requests: BatchRequest[] = [
      {
        id: "ZCL_TEST",
        messages: [
          { role: "system", content: "You are an assistant." },
          { role: "user", content: "Summarize this." },
        ],
      },
    ];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        responses: [
          { candidates: [{ content: { parts: [{ text: "ok" }] } }], usageMetadata: {} },
        ],
      }),
    });

    await submitBatch(config, requests);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("batchGenerateContent");
    expect(url).toContain("key=gemini-batch-key");

    const body = JSON.parse(opts.body);
    expect(body.requests).toHaveLength(1);
    expect(body.requests[0].systemInstruction.parts[0].text).toBe("You are an assistant.");
    expect(body.requests[0].contents[0].parts[0].text).toBe("Summarize this.");
  });
});

describe("batch provider validation", () => {
  it("should reject batch for openai-compatible provider", async () => {
    const config: LlmConfig = {
      provider: "openai-compatible",
      apiKey: "key",
      model: "model",
      baseUrl: "http://localhost:11434/v1",
    };

    await expect(submitBatch(config, BATCH_REQUESTS)).rejects.toThrow("not supported");
  });
});
