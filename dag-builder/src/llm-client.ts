import { LlmConfig, LlmMessage, LlmResponse, BatchRequest, BatchStatus } from "./types";

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

async function submitGeminiBatch(
  config: LlmConfig,
  requests: BatchRequest[],
): Promise<string> {
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
  const temperature = config.temperature ?? DEFAULT_TEMPERATURE;

  const geminiRequests = requests.map((req) => {
    const systemMessages = req.messages.filter((m) => m.role === "system");
    const nonSystemMessages = req.messages.filter((m) => m.role !== "system");

    const reqBody: Record<string, any> = {
      contents: nonSystemMessages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      })),
      generationConfig: { maxOutputTokens: maxTokens, temperature },
    };

    if (systemMessages.length > 0) {
      reqBody.systemInstruction = {
        parts: [{ text: systemMessages.map((m) => m.content).join("\n\n") }],
      };
    }

    return reqBody;
  });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:batchGenerateContent?key=${config.apiKey}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requests: geminiRequests }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini batch submission failed ${res.status}: ${text}`);
  }

  const json: any = await res.json();

  // If response contains results directly (small batch, synchronous return)
  if (json.responses) {
    // Store results in a cache keyed by a synthetic ID
    const syntheticId = `gemini-sync-${Date.now()}`;
    geminiBatchCache.set(syntheticId, { requests, responses: json.responses });
    return syntheticId;
  }

  // Async operation — store request IDs for later mapping
  const operationName = json.name;
  geminiBatchCache.set(operationName, { requests, responses: null });
  return operationName;
}

// Cache for Gemini batch results (maps operation name → request order + responses)
const geminiBatchCache = new Map<string, {
  requests: BatchRequest[];
  responses: any[] | null;
}>();

async function pollGeminiBatch(config: LlmConfig, batchId: string): Promise<BatchStatus> {
  const cached = geminiBatchCache.get(batchId);

  // Synchronous result already available
  if (cached?.responses) {
    return {
      id: batchId,
      state: "completed",
      completedCount: cached.responses.length,
      totalCount: cached.requests.length,
    };
  }

  // Poll async operation
  const url = `https://generativelanguage.googleapis.com/v1beta/${batchId}?key=${config.apiKey}`;
  const res = await fetch(url);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini batch poll failed ${res.status}: ${text}`);
  }

  const json: any = await res.json();

  if (json.done && json.response?.responses) {
    // Cache the results
    if (cached) {
      cached.responses = json.response.responses;
    }
    return {
      id: batchId,
      state: "completed",
      completedCount: json.response.responses.length,
      totalCount: cached?.requests.length ?? json.response.responses.length,
    };
  }

  const stateMap: Record<string, BatchStatus["state"]> = {
    JOB_STATE_PENDING: "pending",
    JOB_STATE_RUNNING: "running",
    JOB_STATE_SUCCEEDED: "completed",
    JOB_STATE_FAILED: "failed",
    JOB_STATE_CANCELLED: "failed",
    JOB_STATE_EXPIRED: "failed",
  };

  return {
    id: batchId,
    state: stateMap[json.metadata?.state] ?? "running",
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
    const response = cached.responses[i];
    const requestId = cached.requests[i]?.id ?? `unknown-${i}`;

    const content = response.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    const usage = response.usageMetadata ?? {};

    results.set(requestId, {
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

// ─── Helpers ───

function log(msg: string): void {
  process.stderr.write(`[llm-client] ${msg}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
