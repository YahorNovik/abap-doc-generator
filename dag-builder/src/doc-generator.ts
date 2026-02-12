import { buildDag, createConnectedClient, fetchSourceForNodes } from "./dag-builder";
import { callLlm } from "./llm-client";
import { buildSummaryPrompt, buildDocPrompt } from "./prompts";
import { DocInput, DocResult, DagResult, DagEdge } from "./types";

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

  // 2. Fetch source for all nodes
  log("Fetching source code for all nodes...");
  const adtClient = await createConnectedClient(
    input.systemUrl, input.username, input.password, input.client,
  );

  let sources: Map<string, string>;
  try {
    sources = await fetchSourceForNodes(adtClient, dagResult.nodes, errors);
  } finally {
    try { await adtClient.disconnect(); } catch { /* ignore */ }
  }
  log(`Fetched source for ${sources.size}/${dagResult.nodes.length} nodes.`);

  // Build edge lookup: for each node, which deps does it use and with what members?
  const edgesByFrom = new Map<string, DagEdge[]>();
  for (const edge of dagResult.edges) {
    if (!edgesByFrom.has(edge.from)) edgesByFrom.set(edge.from, []);
    edgesByFrom.get(edge.from)!.push(edge);
  }

  // 3. Walk topological order (leaves first), summarize each non-root node
  const rootName = dagResult.root;
  const topoOrder = dagResult.topologicalOrder;
  const nodeMap = new Map(dagResult.nodes.map((n) => [n.name, n]));

  for (let i = 0; i < topoOrder.length; i++) {
    const name = topoOrder[i];
    const node = nodeMap.get(name);
    if (!node) continue;

    const source = sources.get(name);
    if (!source) {
      errors.push(`No source available for ${name}, skipping summarization.`);
      continue;
    }

    const isRoot = name === rootName;

    if (!isRoot) {
      // Summarize dependency with cheap model
      log(`[${i + 1}/${topoOrder.length}] Summarizing ${name}...`);

      // Gather summaries of this node's own dependencies
      const edges = edgesByFrom.get(name) ?? [];
      const depSummaries = edges
        .filter((e) => summaries[e.to])
        .map((e) => ({ name: e.to, summary: summaries[e.to] }));

      const messages = buildSummaryPrompt(node, source, depSummaries);

      try {
        const response = await callLlm(input.summaryLlm, messages);
        summaries[name] = response.content;
        summaryTokens += response.usage.promptTokens + response.usage.completionTokens;
        log(`  Summary: ${response.content.substring(0, 80)}...`);
      } catch (err) {
        errors.push(`Failed to summarize ${name}: ${String(err)}`);
        summaries[name] = `[Summary unavailable: ${String(err)}]`;
      }
    }
  }

  // 4. Generate full documentation for root
  log(`Generating documentation for ${rootName}...`);
  const rootNode = nodeMap.get(rootName);
  const rootSource = sources.get(rootName);

  if (!rootNode || !rootSource) {
    return {
      objectName: rootName,
      documentation: `# ${rootName}\n\nFailed to generate documentation: source code not available.`,
      summaries,
      tokenUsage: { summaryTokens, docTokens },
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

  const docMessages = buildDocPrompt(rootNode, rootSource, depDetails);

  try {
    const response = await callLlm(input.docLlm, docMessages);
    docTokens = response.usage.promptTokens + response.usage.completionTokens;
    log("Documentation generated successfully.");

    return {
      objectName: rootName,
      documentation: response.content,
      summaries,
      tokenUsage: { summaryTokens, docTokens },
      errors,
    };
  } catch (err) {
    errors.push(`Failed to generate documentation: ${String(err)}`);
    return {
      objectName: rootName,
      documentation: `# ${rootName}\n\nFailed to generate documentation: ${String(err)}`,
      summaries,
      tokenUsage: { summaryTokens, docTokens },
      errors,
    };
  }
}
