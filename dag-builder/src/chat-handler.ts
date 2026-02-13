import { AdtClientWrapper } from "./adt-client";
import { callLlmAgentLoop } from "./llm-client";
import { AGENT_TOOLS } from "./tools";
import { renderSingleObjectHtml } from "./html-renderer";
import { LlmConfig, LlmMessage, ToolCall } from "./types";

const CHAT_MAX_ITERATIONS = 5;

export interface ChatInput {
  command: "chat";
  systemUrl: string;
  client: string;
  username: string;
  password: string;
  objectName: string;
  objectType: string;
  documentation: string;          // current markdown documentation
  userContext?: string;
  conversation: Array<{ role: string; content: string }>;
  docLlm: LlmConfig;
}

export interface ChatResult {
  reply: string;
  updatedMarkdown?: string;
  updatedHtml?: string;
  tokenUsage: { promptTokens: number; completionTokens: number };
}

function log(msg: string): void {
  process.stderr.write(`[chat] ${msg}\n`);
}

const CHAT_SYSTEM_PROMPT = `You are an expert ABAP documentation assistant. You are discussing the documentation for an ABAP object with the user.

## Your Role
- Answer questions about the documented ABAP object
- Explain code behavior, patterns, and architecture
- Suggest improvements to the documentation
- Update the documentation when the user requests changes

## Current Documentation
The user has already generated documentation (provided below). Use it as context for the conversation.

## Tools
You have access to tools that let you inspect the SAP system:
- **get_source**: Fetch the ABAP source code of any object
- **get_where_used**: Find where an object is referenced

Use these tools when you need to verify details or gather more information.

## Updating Documentation
When the user asks you to update, modify, improve, or change the documentation, produce the full updated documentation wrapped in delimiters:

<updated_doc>
(full updated markdown documentation here)
</updated_doc>

Include the COMPLETE updated document, not just the changed sections. The user will be able to apply the update with a single click.

If the user is just asking a question or discussing (not requesting changes), respond normally without the <updated_doc> block.`;

export async function handleChat(input: ChatInput): Promise<ChatResult> {
  log(`Chat request for ${input.objectName} (${input.objectType})`);

  const client = new AdtClientWrapper(
    input.systemUrl, input.username, input.password, input.client,
  );

  try {
    await client.connect();

    // Build messages
    const messages: LlmMessage[] = [];

    // System message with context
    let systemContent = CHAT_SYSTEM_PROMPT;
    systemContent += `\n\n## Object: ${input.objectName} (${input.objectType})`;
    systemContent += `\n\n## Current Documentation\n\n${input.documentation}`;
    if (input.userContext && input.userContext.trim()) {
      systemContent += `\n\n## Additional Context from User\n\n${input.userContext.trim()}`;
    }
    messages.push({ role: "system", content: systemContent });

    // Add conversation history
    for (const msg of input.conversation) {
      messages.push({
        role: msg.role as "user" | "assistant",
        content: msg.content,
      });
    }

    // Tool executor using ADT client
    const toolExecutor = async (tc: ToolCall): Promise<string> => {
      switch (tc.name) {
        case "get_source":
          try {
            log(`  Tool: get_source(${tc.arguments.object_name})`);
            return await client.fetchSource(tc.arguments.object_name);
          } catch (err) { return `Error: ${String(err)}`; }
        case "get_where_used":
          try {
            log(`  Tool: get_where_used(${tc.arguments.object_name})`);
            const refs = await client.getWhereUsed(tc.arguments.object_name);
            if (refs.length === 0) return "No where-used references found.";
            return refs.map((r) => `${r.name} (${r.type}): ${r.description}`).join("\n");
          } catch (err) { return `Error: ${String(err)}`; }
        default: return `Unknown tool: ${tc.name}`;
      }
    };

    // Call LLM agent loop
    const docConfig: LlmConfig = { ...input.docLlm, maxTokens: 8192 };
    const response = await callLlmAgentLoop(
      docConfig, messages, AGENT_TOOLS, toolExecutor, CHAT_MAX_ITERATIONS, 0,
    );

    log(`Chat response: ${response.content.length} chars, ${response.toolCallCount} tool calls`);

    // Parse response for <updated_doc> block
    const result = parseResponse(response.content);

    return {
      reply: result.reply,
      updatedMarkdown: result.updatedMarkdown,
      updatedHtml: result.updatedMarkdown
        ? renderSingleObjectHtml(input.objectName, result.updatedMarkdown)
        : undefined,
      tokenUsage: {
        promptTokens: response.usage.promptTokens,
        completionTokens: response.usage.completionTokens,
      },
    };
  } finally {
    try { await client.disconnect(); } catch { /* ignore */ }
  }
}

function parseResponse(content: string): { reply: string; updatedMarkdown?: string } {
  const tagStart = "<updated_doc>";
  const tagEnd = "</updated_doc>";
  const startIdx = content.indexOf(tagStart);
  const endIdx = content.indexOf(tagEnd);

  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    return { reply: content };
  }

  const updatedMarkdown = content.slice(startIdx + tagStart.length, endIdx).trim();
  const reply = (
    content.slice(0, startIdx).trim()
    + "\n\n"
    + content.slice(endIdx + tagEnd.length).trim()
  ).trim();

  return {
    reply: reply || "I've updated the documentation. Click Apply to see the changes.",
    updatedMarkdown,
  };
}
