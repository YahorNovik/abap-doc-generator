import { LlmConfig, LlmMessage, LlmResponse } from "./types";

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

// ─── Helpers ───

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
