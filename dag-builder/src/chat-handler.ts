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
  isPackage?: boolean;            // true when chatting about a package doc object
}

export interface ChatResult {
  reply: string;
  updatedMarkdown?: string;
  updatedHtml?: string;
  updatedPageName?: string;       // for package docs: which page file to update
  tokenUsage: { promptTokens: number; completionTokens: number };
}

function log(msg: string): void {
  process.stderr.write(`[chat] ${msg}\n`);
}

const CHAT_SYSTEM_PROMPT = `You are the documentation agent that generated the ABAP documentation shown below.

## Your Role
- Explain your documentation decisions and answer questions about the documented objects
- Provide additional context about code behavior, patterns, and architecture
- Modify the documentation when the user requests changes

The documentation was auto-generated from source code analysis. The user may have additional context about the business purpose that was not visible in the code.

## Tools
You have access to SAP system inspection tools:
- **get_source**: Fetch ABAP source code of any object
- **get_where_used**: Find where an object is referenced

Use these tools when you need to verify details or gather more information beyond what is already provided.

## Updating Documentation
When the user asks to update, modify, improve, or change the documentation, output the full updated markdown wrapped in:

<updated_doc>
(complete updated markdown)
</updated_doc>

Include the COMPLETE document, not just changed sections.
If just answering a question, respond normally without the block.`;

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
      updatedPageName: result.updatedMarkdown && input.isPackage
        ? `${input.objectName}.html`
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
