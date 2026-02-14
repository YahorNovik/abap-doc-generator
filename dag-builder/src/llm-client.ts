import { LlmConfig, LlmMessage, LlmResponse, BatchRequest, BatchStatus, ToolDefinition, ToolCall, ToolExecutor } from "./types";
import { toOpenAITools, toGeminiTools } from "./tools";

const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_TEMPERATURE = 0.3;
const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 3000, 8000];

/**
 * Calls an LLM with the given messages, routing to the correct provider.
 * Retries on 429/500/503 with exponential backoff.
 */
export async function callLlm(config: LlmConfig, messages: LlmMessage[]): Promise<LlmResponse> {
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
  const temperature = config.temperature ?? DEFAULT_TEMPERATURE;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (config.provider === "gemini") {
        return await callGemini(config, messages, maxTokens, temperature);
      } else {
        return await callOpenAI(config, messages, maxTokens, temperature);
      }
    } catch (err: any) {
      const status = err?.status ?? 0;
      const retryable = status === 429 || status === 500 || status === 503;

      if (retryable && attempt < MAX_RETRIES) {
        const delay = RETRY_DELAYS[attempt] ?? 8000;
        process.stderr.write(`[llm-client] ${status} error, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})...\n`);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }

  throw new Error("LLM call failed after max retries");
}

// ─── Gemini ───

async function callGemini(
  config: LlmConfig,
  messages: LlmMessage[],
  maxTokens: number,
  temperature: number,
): Promise<LlmResponse> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${config.apiKey}`;

  const systemMessages = messages.filter((m) => m.role === "system");
  const nonSystemMessages = messages.filter((m) => m.role !== "system");

  const body: Record<string, any> = {
    contents: nonSystemMessages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    })),
    generationConfig: {
      maxOutputTokens: maxTokens,
      temperature,
    },
  };

  if (systemMessages.length > 0) {
    body.systemInstruction = {
      parts: [{ text: systemMessages.map((m) => m.content).join("\n\n") }],
    };
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    const err: any = new Error(`Gemini API error ${res.status}: ${text}`);
    err.status = res.status;
    throw err;
  }

  const json: any = await res.json();
  const content = json.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  const usage = json.usageMetadata ?? {};

  return {
    content,
    usage: {
      promptTokens: usage.promptTokenCount ?? 0,
      completionTokens: usage.candidatesTokenCount ?? 0,
    },
  };
}

// ─── OpenAI / OpenAI-compatible ───

async function callOpenAI(
  config: LlmConfig,
  messages: LlmMessage[],
  maxTokens: number,
  temperature: number,
): Promise<LlmResponse> {
  const baseUrl = config.provider === "openai"
    ? "https://api.openai.com/v1"
    : config.baseUrl;

  if (!baseUrl) {
    throw new Error("baseUrl is required for openai-compatible provider");
  }

  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;

  const body = {
    model: config.model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    max_tokens: maxTokens,
    temperature,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    const err: any = new Error(`OpenAI API error ${res.status}: ${text}`);
    err.status = res.status;
    throw err;
  }

  const json: any = await res.json();
  const content = json.choices?.[0]?.message?.content ?? "";
  const usage = json.usage ?? {};

  return {
    content,
    usage: {
      promptTokens: usage.prompt_tokens ?? 0,
      completionTokens: usage.completion_tokens ?? 0,
    },
  };
}

// ─── Batch API ───

const BATCH_POLL_INTERVAL = 10000; // 10 seconds

/**
 * Submits a batch of requests to the provider's batch API.
 * Returns a batch/operation ID for polling.
 */
export async function submitBatch(
  config: LlmConfig,
  requests: BatchRequest[],
): Promise<string> {
  if (config.provider === "gemini") {
    return submitGeminiBatch(config, requests);
  } else if (config.provider === "openai") {
    return submitOpenAIBatch(config, requests);
  }
  throw new Error(`Batch mode not supported for provider: ${config.provider}`);
}

/**
 * Polls the batch job status.
 */
export async function pollBatch(
  config: LlmConfig,
  batchId: string,
): Promise<BatchStatus> {
  if (config.provider === "gemini") {
    return pollGeminiBatch(config, batchId);
  } else if (config.provider === "openai") {
    return pollOpenAIBatch(config, batchId);
  }
  throw new Error(`Batch mode not supported for provider: ${config.provider}`);
}

/**
 * Retrieves results from a completed batch.
 * Returns a map of request ID → LlmResponse.
 */
export async function getBatchResults(
  config: LlmConfig,
  batchId: string,
): Promise<Map<string, LlmResponse>> {
  if (config.provider === "gemini") {
    return getGeminiBatchResults(config, batchId);
  } else if (config.provider === "openai") {
    return getOpenAIBatchResults(config, batchId);
  }
  throw new Error(`Batch mode not supported for provider: ${config.provider}`);
}

/**
 * Convenience: submits a batch, polls until done, returns results.
 */
export async function runBatch(
  config: LlmConfig,
  requests: BatchRequest[],
): Promise<Map<string, LlmResponse>> {
  if (requests.length === 0) return new Map();

  const batchId = await submitBatch(config, requests);
  log(`Batch submitted: ${batchId} (${requests.length} requests)`);

  // Poll until completed
  while (true) {
    const status = await pollBatch(config, batchId);
    log(`Batch ${batchId}: ${status.state} (${status.completedCount}/${status.totalCount})`);

    if (status.state === "completed") {
      return getBatchResults(config, batchId);
    }
    if (status.state === "failed") {
      throw new Error(`Batch ${batchId} failed`);
    }

    await sleep(BATCH_POLL_INTERVAL);
  }
}

// ─── OpenAI Batch ───

async function submitOpenAIBatch(
  config: LlmConfig,
  requests: BatchRequest[],
): Promise<string> {
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
  const temperature = config.temperature ?? DEFAULT_TEMPERATURE;

  // Build JSONL content
  const jsonl = requests.map((req) => JSON.stringify({
    custom_id: req.id,
    method: "POST",
    url: "/v1/chat/completions",
    body: {
      model: config.model,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      max_tokens: maxTokens,
      temperature,
    },
  })).join("\n");

  // Upload file
  const fileBlob = new Blob([jsonl], { type: "application/jsonl" });
  const formData = new FormData();
  formData.append("purpose", "batch");
  formData.append("file", fileBlob, "batch_input.jsonl");

  const fileRes = await fetch("https://api.openai.com/v1/files", {
    method: "POST",
    headers: { "Authorization": `Bearer ${config.apiKey}` },
    body: formData,
  });

  if (!fileRes.ok) {
    const text = await fileRes.text();
    throw new Error(`OpenAI file upload failed ${fileRes.status}: ${text}`);
  }

  const fileJson: any = await fileRes.json();
  const fileId = fileJson.id;

  // Create batch
  const batchRes = await fetch("https://api.openai.com/v1/batches", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      input_file_id: fileId,
      endpoint: "/v1/chat/completions",
      completion_window: "24h",
    }),
  });

  if (!batchRes.ok) {
    const text = await batchRes.text();
    throw new Error(`OpenAI batch creation failed ${batchRes.status}: ${text}`);
  }

  const batchJson: any = await batchRes.json();
  return batchJson.id;
}

async function pollOpenAIBatch(config: LlmConfig, batchId: string): Promise<BatchStatus> {
  const res = await fetch(`https://api.openai.com/v1/batches/${batchId}`, {
    headers: { "Authorization": `Bearer ${config.apiKey}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI batch poll failed ${res.status}: ${text}`);
  }

  const json: any = await res.json();
  const counts = json.request_counts ?? {};

  const stateMap: Record<string, BatchStatus["state"]> = {
    validating: "pending",
    in_progress: "running",
    finalizing: "running",
    completed: "completed",
    failed: "failed",
    expired: "failed",
    cancelled: "failed",
    cancelling: "running",
  };

  return {
    id: batchId,
    state: stateMap[json.status] ?? "pending",
    completedCount: counts.completed ?? 0,
    totalCount: counts.total ?? 0,
    outputFileId: json.output_file_id,
  };
}

async function getOpenAIBatchResults(
  config: LlmConfig,
  batchId: string,
): Promise<Map<string, LlmResponse>> {
  // First get the output file ID
  const status = await pollOpenAIBatch(config, batchId);
  if (!status.outputFileId) {
    throw new Error(`Batch ${batchId} has no output file`);
  }

  // Download output file
  const res = await fetch(`https://api.openai.com/v1/files/${status.outputFileId}/content`, {
    headers: { "Authorization": `Bearer ${config.apiKey}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI file download failed ${res.status}: ${text}`);
  }

  const text = await res.text();
  const results = new Map<string, LlmResponse>();

  for (const line of text.trim().split("\n")) {
    if (!line) continue;
    const entry: any = JSON.parse(line);
    const customId = entry.custom_id;

    if (entry.error) {
      results.set(customId, {
        content: `[Batch error: ${entry.error.message}]`,
        usage: { promptTokens: 0, completionTokens: 0 },
      });
    } else {
      const body = entry.response?.body ?? {};
      results.set(customId, {
        content: body.choices?.[0]?.message?.content ?? "",
        usage: {
          promptTokens: body.usage?.prompt_tokens ?? 0,
          completionTokens: body.usage?.completion_tokens ?? 0,
        },
      });
    }
  }

  return results;
}

// ─── Gemini Batch ───
//
// Uses the Gemini Batch API (v1beta):
//   POST /v1beta/models/{model}:batchGenerateContent  — create batch job
//   GET  /v1beta/{batchName}                          — poll status
// Results come back as inlinedResponses when the job succeeds.
//

async function submitGeminiBatch(
  config: LlmConfig,
  requests: BatchRequest[],
): Promise<string> {
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
  const temperature = config.temperature ?? DEFAULT_TEMPERATURE;

  // Build inline requests in the format the API expects
  const inlineRequests = requests.map((req) => {
    const systemMessages = req.messages.filter((m) => m.role === "system");
    const nonSystemMessages = req.messages.filter((m) => m.role !== "system");

    const generateContentReq: Record<string, any> = {
      contents: nonSystemMessages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      })),
      generationConfig: { maxOutputTokens: maxTokens, temperature },
    };

    if (systemMessages.length > 0) {
      generateContentReq.systemInstruction = {
        parts: [{ text: systemMessages.map((m) => m.content).join("\n\n") }],
      };
    }

    return {
      request: generateContentReq,
      metadata: { key: req.id },
    };
  });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:batchGenerateContent?key=${config.apiKey}`;

  const body = {
    batch: {
      display_name: `abap-doc-batch-${Date.now()}`,
      input_config: {
        requests: {
          requests: inlineRequests,
        },
      },
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini batch submission failed ${res.status}: ${text}`);
  }

  const json: any = await res.json();

  // The API returns a batch job object with a name like "batches/123456789"
  const batchName = json.name;
  if (!batchName) {
    throw new Error(`Gemini batch response missing 'name': ${JSON.stringify(json)}`);
  }

  // Store request metadata for mapping results back to request IDs
  geminiBatchCache.set(batchName, { requests, responses: null });
  log(`Gemini batch created: ${batchName}`);
  return batchName;
}

// Cache for Gemini batch results (maps batch name → request order + responses)
const geminiBatchCache = new Map<string, {
  requests: BatchRequest[];
  responses: any[] | null;
}>();

async function pollGeminiBatch(config: LlmConfig, batchId: string): Promise<BatchStatus> {
  const cached = geminiBatchCache.get(batchId);

  // Results already cached from a previous poll
  if (cached?.responses) {
    return {
      id: batchId,
      state: "completed",
      completedCount: cached.responses.length,
      totalCount: cached.requests.length,
    };
  }

  // Poll the batch job status
  const url = `https://generativelanguage.googleapis.com/v1beta/${batchId}?key=${config.apiKey}`;
  const res = await fetch(url);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini batch poll failed ${res.status}: ${text}`);
  }

  const json: any = await res.json();

  // Map Gemini job states to our internal states
  const stateMap: Record<string, BatchStatus["state"]> = {
    JOB_STATE_PENDING: "pending",
    JOB_STATE_RUNNING: "running",
    JOB_STATE_SUCCEEDED: "completed",
    JOB_STATE_FAILED: "failed",
    JOB_STATE_CANCELLED: "failed",
    JOB_STATE_EXPIRED: "failed",
  };

  const state = stateMap[json.state] ?? "running";

  // When succeeded, cache the inlined responses
  if (state === "completed" && json.response?.inlinedResponses) {
    if (cached) {
      cached.responses = json.response.inlinedResponses;
    }
    return {
      id: batchId,
      state: "completed",
      completedCount: json.response.inlinedResponses.length,
      totalCount: cached?.requests.length ?? json.response.inlinedResponses.length,
    };
  }

  return {
    id: batchId,
    state,
    completedCount: 0,
    totalCount: cached?.requests.length ?? 0,
  };
}

async function getGeminiBatchResults(
  config: LlmConfig,
  batchId: string,
): Promise<Map<string, LlmResponse>> {
  const cached = geminiBatchCache.get(batchId);
  if (!cached?.responses) {
    throw new Error(`No results available for Gemini batch ${batchId}`);
  }

  const results = new Map<string, LlmResponse>();

  for (let i = 0; i < cached.responses.length; i++) {
    const entry = cached.responses[i];
    // Each entry has { response: {candidates, usageMetadata}, metadata: {key} }
    const responseObj = entry.response ?? entry;
    const key = entry.metadata?.key ?? cached.requests[i]?.id ?? `unknown-${i}`;

    const content = responseObj.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    const usage = responseObj.usageMetadata ?? {};

    results.set(key, {
      content,
      usage: {
        promptTokens: usage.promptTokenCount ?? 0,
        completionTokens: usage.candidatesTokenCount ?? 0,
      },
    });
  }

  // Clean up cache
  geminiBatchCache.delete(batchId);

  return results;
}

// ─── Agent Loop ───

const DEFAULT_MAX_ITERATIONS = 10;

/** Extended response from agent loop with iteration stats. */
export interface AgentLoopResult extends LlmResponse {
  agentIterations: number;
  toolCallCount: number;
}

/**
 * Calls an LLM in an agent loop with tool support.
 * The LLM can request tool calls which are executed via toolExecutor,
 * then results are fed back until the LLM produces a text response.
 *
 * Only the final doc generation step uses this — summarization remains single-shot.
 *
 * @param tokenBudget - Max total tokens (prompt+completion) before stopping the loop.
 */
export async function callLlmAgentLoop(
  config: LlmConfig,
  messages: LlmMessage[],
  tools: ToolDefinition[],
  toolExecutor: ToolExecutor,
  maxIterations: number = DEFAULT_MAX_ITERATIONS,
  tokenBudget: number = 0,
): Promise<AgentLoopResult> {
  // openai-compatible may not support function calling — fall back to single call
  if (config.provider === "openai-compatible") {
    log("openai-compatible provider: falling back to single call (no tools)");
    const res = await callLlm(config, messages);
    return { ...res, agentIterations: 0, toolCallCount: 0 };
  }

  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
  const temperature = config.temperature ?? DEFAULT_TEMPERATURE;
  const conversation: LlmMessage[] = [...messages];
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let toolCallCount = 0;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    // Call LLM with tools (with retry logic)
    let response: AgentResponse;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (config.provider === "gemini") {
          response = await callGeminiWithTools(config, conversation, tools, maxTokens, temperature);
        } else {
          response = await callOpenAIWithTools(config, conversation, tools, maxTokens, temperature);
        }
        break;
      } catch (err: any) {
        const status = err?.status ?? 0;
        const retryable = status === 429 || status === 500 || status === 503;
        if (retryable && attempt < MAX_RETRIES) {
          const delay = RETRY_DELAYS[attempt] ?? 8000;
          log(`${status} error in agent loop, retrying in ${delay}ms...`);
          await sleep(delay);
          continue;
        }
        throw err;
      }
    }

    totalPromptTokens += response!.usage.promptTokens;
    totalCompletionTokens += response!.usage.completionTokens;
    const totalTokens = totalPromptTokens + totalCompletionTokens;

    // No tool calls — return text response
    if (response!.toolCalls.length === 0) {
      log(`Agent loop completed: ${iteration + 1} iteration(s), ${toolCallCount} tool call(s), ${totalTokens} tokens`);
      return {
        content: response!.content ?? "",
        usage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens },
        agentIterations: iteration + 1,
        toolCallCount,
      };
    }

    // Check token budget
    if (tokenBudget > 0 && totalTokens >= tokenBudget) {
      log(`Token budget exhausted (${totalTokens}/${tokenBudget}), forcing final response`);
      break;
    }

    // Process tool calls
    toolCallCount += response!.toolCalls.length;
    log(`Agent loop iteration ${iteration + 1}: ${response!.toolCalls.length} tool call(s), ${totalTokens} tokens used`);

    // Append assistant message with tool calls
    conversation.push({
      role: "assistant",
      content: response!.content ?? "",
      toolCalls: response!.toolCalls,
    });

    // Execute tools and append results
    for (const tc of response!.toolCalls) {
      let result: string;
      try {
        result = await toolExecutor(tc);
      } catch (err) {
        result = `Error: ${String(err)}`;
      }
      conversation.push({
        role: "tool",
        content: result,
        toolCallId: tc.id,
        name: tc.name,
      });
    }
  }

  // Max iterations or budget reached — make one final call without tools
  log(`Agent loop: forcing final response (${toolCallCount} tool calls, ${totalPromptTokens + totalCompletionTokens} tokens)`);
  const finalRes = await callLlm(config, conversation);
  totalPromptTokens += finalRes.usage.promptTokens;
  totalCompletionTokens += finalRes.usage.completionTokens;
  return {
    content: finalRes.content,
    usage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens },
    agentIterations: maxIterations + 1,
    toolCallCount,
  };
}

// ─── Agent Response Type (internal) ───

interface AgentResponse {
  content: string | null;
  toolCalls: ToolCall[];
  usage: { promptTokens: number; completionTokens: number };
}

// ─── OpenAI with Tools ───

async function callOpenAIWithTools(
  config: LlmConfig,
  messages: LlmMessage[],
  tools: ToolDefinition[],
  maxTokens: number,
  temperature: number,
): Promise<AgentResponse> {
  const url = "https://api.openai.com/v1/chat/completions";

  const body: Record<string, any> = {
    model: config.model,
    messages: serializeOpenAIMessages(messages),
    max_tokens: maxTokens,
    temperature,
    tools: toOpenAITools(tools),
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    const err: any = new Error(`OpenAI API error ${res.status}: ${text}`);
    err.status = res.status;
    throw err;
  }

  const json: any = await res.json();
  const choice = json.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const usage = json.usage ?? {};

  const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((tc: any) => ({
    id: tc.id,
    name: tc.function.name,
    arguments: JSON.parse(tc.function.arguments),
  }));

  return {
    content: message.content ?? null,
    toolCalls,
    usage: {
      promptTokens: usage.prompt_tokens ?? 0,
      completionTokens: usage.completion_tokens ?? 0,
    },
  };
}

function serializeOpenAIMessages(messages: LlmMessage[]): any[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    }
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      return {
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

// ─── Gemini with Tools ───

async function callGeminiWithTools(
  config: LlmConfig,
  messages: LlmMessage[],
  tools: ToolDefinition[],
  maxTokens: number,
  temperature: number,
): Promise<AgentResponse> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${config.apiKey}`;

  const { contents, systemInstruction } = serializeGeminiMessages(messages);

  const body: Record<string, any> = {
    contents,
    generationConfig: { maxOutputTokens: maxTokens, temperature },
    tools: toGeminiTools(tools),
  };

  if (systemInstruction) {
    body.systemInstruction = systemInstruction;
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    const err: any = new Error(`Gemini API error ${res.status}: ${text}`);
    err.status = res.status;
    throw err;
  }

  const json: any = await res.json();
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  const usage = json.usageMetadata ?? {};

  const toolCalls: ToolCall[] = [];
  let textContent: string | null = null;

  for (const part of parts) {
    if (part.functionCall) {
      toolCalls.push({
        id: `gemini-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: part.functionCall.name,
        arguments: part.functionCall.args ?? {},
      });
    }
    if (part.text !== undefined) {
      textContent = (textContent ?? "") + part.text;
    }
  }

  return {
    content: textContent,
    toolCalls,
    usage: {
      promptTokens: usage.promptTokenCount ?? 0,
      completionTokens: usage.candidatesTokenCount ?? 0,
    },
  };
}

function serializeGeminiMessages(messages: LlmMessage[]): {
  contents: any[];
  systemInstruction?: any;
} {
  const systemMessages = messages.filter((m) => m.role === "system");
  const nonSystem = messages.filter((m) => m.role !== "system");

  const contents: any[] = [];

  for (let i = 0; i < nonSystem.length; i++) {
    const m = nonSystem[i];

    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      // Model message with function calls
      contents.push({
        role: "model",
        parts: m.toolCalls.map((tc) => ({
          functionCall: { name: tc.name, args: tc.arguments },
        })),
      });
    } else if (m.role === "tool") {
      // Group consecutive tool results into a single user message
      // (Gemini requires all functionResponse parts from one turn in one message)
      const lastContent = contents[contents.length - 1];
      if (lastContent && lastContent._isFunctionResponse) {
        lastContent.parts.push({
          functionResponse: {
            name: m.name,
            response: { content: m.content },
          },
        });
      } else {
        contents.push({
          role: "user",
          _isFunctionResponse: true,
          parts: [{
            functionResponse: {
              name: m.name,
              response: { content: m.content },
            },
          }],
        });
      }
    } else {
      contents.push({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      });
    }
  }

  // Clean up internal marker
  for (const c of contents) {
    delete c._isFunctionResponse;
  }

  const result: { contents: any[]; systemInstruction?: any } = { contents };
  if (systemMessages.length > 0) {
    result.systemInstruction = {
      parts: [{ text: systemMessages.map((m) => m.content).join("\n\n") }],
    };
  }
  return result;
}

// ─── Helpers ───

function log(msg: string): void {
  process.stderr.write(`[llm-client] ${msg}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
