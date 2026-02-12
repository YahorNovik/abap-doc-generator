import { buildDag, createConnectedClient, fetchSourceForNodes } from "./dag-builder";
import { callLlm, callLlmAgentLoop, runBatch } from "./llm-client";
import { buildSummaryPrompt, buildDocPrompt } from "./prompts";
import { AGENT_TOOLS } from "./tools";
import { resolveTemplate } from "./templates";
import { DocInput, DocResult, DagResult, DagEdge, DagNode, LlmConfig, BatchRequest, ToolCall } from "./types";

const DEFAULT_MAX_ITERATIONS = 10;

function log(msg: string): void {
  process.stderr.write(`[doc-generator] ${msg}\n`);
}

/**
 * Generates documentation for an ABAP object by:
 * 1. Building a dependency DAG
 * 2. Fetching source for all nodes
 * 3. Walking topological order bottom-up, summarizing each dep with a cheap LLM
 * 4. Generating final documentation for the root with a capable LLM
 */
export async function generateDocumentation(input: DocInput): Promise<DocResult> {
  const errors: string[] = [];
  const summaries: Record<string, string> = {};
  let summaryTokens = 0;
  let docTokens = 0;

  // 1. Build DAG
  log("Building dependency DAG...");
  const dagResult: DagResult = await buildDag({
    systemUrl: input.systemUrl,
    client: input.client,
    username: input.username,
    password: input.password,
    objectName: input.objectName,
    objectType: input.objectType,
  });
  errors.push(...dagResult.errors);
  log(`DAG built: ${dagResult.nodes.length} nodes, ${dagResult.edges.length} edges.`);

  // 2. Fetch source for all nodes (ADT client stays alive for agent loop tools)
  log("Fetching source code for all nodes...");
  const adtClient = await createConnectedClient(
    input.systemUrl, input.username, input.password, input.client,
  );

  try {
    const sources = await fetchSourceForNodes(adtClient, dagResult.nodes, errors);
    log(`Fetched source for ${sources.size}/${dagResult.nodes.length} nodes.`);

    // Build edge lookup: for each node, which deps does it use and with what members?
    const edgesByFrom = new Map<string, DagEdge[]>();
    for (const edge of dagResult.edges) {
      if (!edgesByFrom.has(edge.from)) edgesByFrom.set(edge.from, []);
      edgesByFrom.get(edge.from)!.push(edge);
    }

    const rootName = dagResult.root;
    const topoOrder = dagResult.topologicalOrder;
    const nodeMap = new Map(dagResult.nodes.map((n) => [n.name, n]));

    // 3. Summarize dependencies (batch or realtime)
    const useBatch = input.mode === "batch"
      && (input.summaryLlm.provider === "openai" || input.summaryLlm.provider === "gemini");

    if (useBatch) {
      log("Using batch mode for summarization...");
      summaryTokens = await summarizeWithBatch(
        input.summaryLlm, topoOrder, rootName, nodeMap, sources, edgesByFrom, summaries, errors,
      );
    } else {
      log("Using realtime mode for summarization...");
      summaryTokens = await summarizeRealtime(
        input.summaryLlm, topoOrder, rootName, nodeMap, sources, edgesByFrom, summaries, errors,
      );
    }

    // 4. Generate full documentation for root (agent loop with ADT tools)
    log(`Generating documentation for ${rootName}...`);
    const rootNode = nodeMap.get(rootName);
    const rootSource = sources.get(rootName);

    if (!rootNode || !rootSource) {
      return {
        objectName: rootName,
        documentation: `# ${rootName}\n\nFailed to generate documentation: source code not available.`,
        summaries,
        tokenUsage: { summaryTokens, docTokens, totalTokens: summaryTokens, agentIterations: 0, toolCalls: 0 },
        errors: [...errors, "Root object source not available."],
      };
    }

    // Build dependency details for the root prompt
    const rootEdges = edgesByFrom.get(rootName) ?? [];
    const depDetails = rootEdges
      .filter((e) => nodeMap.has(e.to))
      .map((e) => ({
        name: e.to,
        type: nodeMap.get(e.to)!.type,
        summary: summaries[e.to] ?? "[No summary available]",
        usedMembers: e.references.map((r) => ({
          memberName: r.memberName,
          memberType: r.memberType,
        })),
      }));

    // Resolve template and set appropriate maxOutputTokens for doc LLM
    const template = resolveTemplate(input.templateType, input.templateCustom, input.objectType);
    const docConfig: LlmConfig = { ...input.docLlm, maxTokens: template.maxOutputTokens };
    log(`Using template: ${template.name} (maxWords=${template.maxWords}, maxOutputTokens=${template.maxOutputTokens})`);

    const docMessages = buildDocPrompt(rootNode, rootSource, depDetails, template);

    // Tool executor: gives the LLM access to ADT for on-demand source and where-used
    const toolExecutor = async (tc: ToolCall): Promise<string> => {
      switch (tc.name) {
        case "get_source": {
          const objectName = tc.arguments.object_name;
          log(`  Tool: get_source(${objectName})`);
          try {
            return await adtClient.fetchSource(objectName);
          } catch (err) {
            return `Error fetching source for ${objectName}: ${String(err)}`;
          }
        }
        case "get_where_used": {
          const objectName = tc.arguments.object_name;
          log(`  Tool: get_where_used(${objectName})`);
          try {
            const refs = await adtClient.getWhereUsed(objectName);
            if (refs.length === 0) return `No where-used references found for ${objectName}.`;
            return refs.map((r) => `${r.name} (${r.type}): ${r.description}`).join("\n");
          } catch (err) {
            return `Error getting where-used for ${objectName}: ${String(err)}`;
          }
        }
        default:
          return `Unknown tool: ${tc.name}`;
      }
    };

    try {
      const tokenBudget = input.maxTotalTokens ?? 0;
      const response = await callLlmAgentLoop(
        docConfig, docMessages, AGENT_TOOLS, toolExecutor,
        DEFAULT_MAX_ITERATIONS, tokenBudget > 0 ? tokenBudget - summaryTokens : 0,
      );
      docTokens = response.usage.promptTokens + response.usage.completionTokens;
      const totalTokens = summaryTokens + docTokens;
      log(`Documentation generated: ${response.agentIterations} iteration(s), ${response.toolCallCount} tool call(s), ${totalTokens} total tokens`);

      return {
        objectName: rootName,
        documentation: response.content,
        summaries,
        tokenUsage: {
          summaryTokens,
          docTokens,
          totalTokens,
          agentIterations: response.agentIterations,
          toolCalls: response.toolCallCount,
        },
        errors,
      };
    } catch (err) {
      errors.push(`Failed to generate documentation: ${String(err)}`);
      return {
        objectName: rootName,
        documentation: `# ${rootName}\n\nFailed to generate documentation: ${String(err)}`,
        summaries,
        tokenUsage: { summaryTokens, docTokens, totalTokens: summaryTokens + docTokens, agentIterations: 0, toolCalls: 0 },
        errors,
      };
    }
  } finally {
    try { await adtClient.disconnect(); } catch { /* ignore */ }
  }
}

// ─── Realtime summarization (sequential, one call per node) ───

async function summarizeRealtime(
  config: LlmConfig,
  topoOrder: string[],
  rootName: string,
  nodeMap: Map<string, DagNode>,
  sources: Map<string, string>,
  edgesByFrom: Map<string, DagEdge[]>,
  summaries: Record<string, string>,
  errors: string[],
): Promise<number> {
  let totalTokens = 0;

  for (let i = 0; i < topoOrder.length; i++) {
    const name = topoOrder[i];
    if (name === rootName) continue;

    const node = nodeMap.get(name);
    if (!node) continue;

    const source = sources.get(name);
    if (!source) {
      errors.push(`No source available for ${name}, skipping summarization.`);
      continue;
    }

    log(`[${i + 1}/${topoOrder.length}] Summarizing ${name}...`);

    const edges = edgesByFrom.get(name) ?? [];
    const depSummaries = edges
      .filter((e) => summaries[e.to])
      .map((e) => ({ name: e.to, summary: summaries[e.to] }));

    const messages = buildSummaryPrompt(node, source, depSummaries);

    try {
      const response = await callLlm(config, messages);
      summaries[name] = response.content;
      totalTokens += response.usage.promptTokens + response.usage.completionTokens;
      log(`  Summary: ${response.content.substring(0, 80)}...`);
    } catch (err) {
      errors.push(`Failed to summarize ${name}: ${String(err)}`);
      summaries[name] = `[Summary unavailable: ${String(err)}]`;
    }
  }

  return totalTokens;
}

// ─── Batch summarization (by topological level) ───

async function summarizeWithBatch(
  config: LlmConfig,
  topoOrder: string[],
  rootName: string,
  nodeMap: Map<string, DagNode>,
  sources: Map<string, string>,
  edgesByFrom: Map<string, DagEdge[]>,
  summaries: Record<string, string>,
  errors: string[],
): Promise<number> {
  let totalTokens = 0;

  // Compute topological levels
  const levels = computeTopologicalLevels(topoOrder, edgesByFrom, rootName);
  const maxLevel = Math.max(0, ...Array.from(levels.values()));

  log(`Computed ${maxLevel + 1} topological levels for batch processing.`);

  for (let level = 0; level <= maxLevel; level++) {
    const nodesAtLevel = topoOrder.filter((n) => levels.get(n) === level);

    if (nodesAtLevel.length === 0) continue;

    log(`Level ${level}: ${nodesAtLevel.length} nodes — submitting batch...`);

    // Build batch requests for this level
    const batchRequests: BatchRequest[] = [];
    for (const name of nodesAtLevel) {
      const node = nodeMap.get(name);
      if (!node) continue;

      const source = sources.get(name);
      if (!source) {
        errors.push(`No source available for ${name}, skipping.`);
        continue;
      }

      const edges = edgesByFrom.get(name) ?? [];
      const depSummaries = edges
        .filter((e) => summaries[e.to])
        .map((e) => ({ name: e.to, summary: summaries[e.to] }));

      const messages = buildSummaryPrompt(node, source, depSummaries);
      batchRequests.push({ id: name, messages });
    }

    if (batchRequests.length === 0) continue;

    // Submit batch and wait for results
    try {
      const results = await runBatch(config, batchRequests);

      for (const [name, response] of results) {
        summaries[name] = response.content;
        totalTokens += response.usage.promptTokens + response.usage.completionTokens;
      }

      log(`Level ${level}: ${results.size} summaries received.`);
    } catch (err) {
      errors.push(`Batch failed for level ${level}: ${String(err)}`);
      // Mark all nodes at this level as failed
      for (const req of batchRequests) {
        summaries[req.id] = `[Batch summary unavailable: ${String(err)}]`;
      }
    }
  }

  return totalTokens;
}

/**
 * Computes topological levels for batch grouping.
 * Level 0 = leaves (no deps in DAG), level N = depends only on levels < N.
 * Root is excluded.
 */
export function computeTopologicalLevels(
  topoOrder: string[],
  edgesByFrom: Map<string, DagEdge[]>,
  rootName: string,
): Map<string, number> {
  const levels = new Map<string, number>();

  for (const name of topoOrder) {
    if (name === rootName) continue;

    const edges = edgesByFrom.get(name) ?? [];
    const depLevels = edges
      .map((e) => levels.get(e.to))
      .filter((l): l is number => l !== undefined);

    if (depLevels.length === 0) {
      levels.set(name, 0);
    } else {
      levels.set(name, Math.max(...depLevels) + 1);
    }
  }

  return levels;
}
