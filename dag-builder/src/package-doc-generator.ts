import { createConnectedClient, fetchSourceForNodes } from "./dag-builder";
import { fetchPackageObjects, buildPackageGraph, detectClusters } from "./package-graph";
import { callLlm, callLlmAgentLoop } from "./llm-client";
import {
  buildSummaryPrompt, buildDocPrompt,
  buildClusterSummaryPrompt, buildPackageOverviewPrompt,
} from "./prompts";
import { AGENT_TOOLS } from "./tools";
import { resolveTemplate, PACKAGE_OVERVIEW_MAX_TOKENS, CLUSTER_SUMMARY_MAX_TOKENS } from "./templates";
import {
  PackageDocInput, PackageDocResult, PackageObject, PackageGraph, Cluster,
  DagEdge, DagNode, LlmConfig, ToolCall,
} from "./types";

const MAX_PACKAGE_OBJECTS = 100;
const DOC_AGENT_MAX_ITERATIONS = 5;

function log(msg: string): void {
  process.stderr.write(`[package-doc] ${msg}\n`);
}

/**
 * Generates wiki-style documentation for an entire ABAP package:
 * 1. Fetch package contents
 * 2. Fetch source and build internal dependency graph
 * 3. Cluster objects via Union-Find
 * 4. Summarize each object, generate individual docs
 * 5. Generate cluster summaries and package overview
 * 6. Assemble hierarchical Markdown document
 */
export async function generatePackageDocumentation(input: PackageDocInput): Promise<PackageDocResult> {
  const errors: string[] = [];
  const summaries: Record<string, string> = {};
  const objectDocs: Record<string, string> = {};
  const clusterSummaries: Record<string, string> = {};
  let summaryTokens = 0;
  let objectDocTokens = 0;
  let clusterSummaryTokens = 0;
  let overviewTokens = 0;

  const client = await createConnectedClient(
    input.systemUrl, input.username, input.password, input.client,
  );

  try {
    // 1. Fetch package contents
    log(`Fetching contents of package ${input.packageName}...`);
    let objects = await fetchPackageObjects(client, input.packageName, errors);
    log(`Found ${objects.length} relevant custom objects.`);

    if (objects.length > MAX_PACKAGE_OBJECTS) {
      log(`Package has ${objects.length} objects, capping to ${MAX_PACKAGE_OBJECTS}.`);
      errors.push(`Package has ${objects.length} objects; only first ${MAX_PACKAGE_OBJECTS} will be processed.`);
      objects = objects.slice(0, MAX_PACKAGE_OBJECTS);
    }

    if (objects.length === 0) {
      return emptyResult(input.packageName, errors);
    }

    // 2. Fetch source for all objects
    log("Fetching source code for all package objects...");
    const dagNodes: DagNode[] = objects.map((o) => ({
      name: o.name, type: o.type, isCustom: true, sourceAvailable: true, usedBy: [],
    }));
    const sources = await fetchSourceForNodes(client, dagNodes, errors);
    log(`Fetched source for ${sources.size}/${objects.length} objects.`);

    // 3. Build package-internal graph
    log("Building package-internal dependency graph...");
    const graph = buildPackageGraph(objects, sources, errors);
    log(`Internal edges: ${graph.internalEdges.length}, External deps: ${graph.externalDependencies.length}`);

    // 4. Detect clusters via Union-Find
    log("Detecting functional clusters...");
    const clusters = detectClusters(graph);
    log(`Found ${clusters.length} cluster(s).`);

    // 5. Process each cluster
    for (let ci = 0; ci < clusters.length; ci++) {
      const cluster = clusters[ci];
      log(`Processing cluster ${ci + 1}/${clusters.length} (${cluster.objects.length} objects)...`);

      const edgesByFrom = new Map<string, DagEdge[]>();
      for (const edge of cluster.internalEdges) {
        if (!edgesByFrom.has(edge.from)) edgesByFrom.set(edge.from, []);
        edgesByFrom.get(edge.from)!.push(edge);
      }
      const objectMap = new Map(cluster.objects.map((o) => [o.name, o]));

      // 5a. Summarize each object in topological order
      for (const name of cluster.topologicalOrder) {
        const obj = objectMap.get(name);
        if (!obj) continue;
        const source = sources.get(name);
        if (!source) {
          errors.push(`No source for ${name}, skipping.`);
          continue;
        }

        const edges = edgesByFrom.get(name) ?? [];
        const depSums = edges
          .filter((e) => summaries[e.to])
          .map((e) => ({ name: e.to, summary: summaries[e.to] }));

        const dagNode: DagNode = {
          name, type: obj.type, isCustom: true, sourceAvailable: true,
          usedBy: cluster.internalEdges.filter((e) => e.to === name).map((e) => e.from),
        };

        const messages = buildSummaryPrompt(dagNode, source, depSums);
        try {
          const response = await callLlm(input.summaryLlm, messages);
          summaries[name] = response.content;
          summaryTokens += response.usage.promptTokens + response.usage.completionTokens;
          log(`  Summarized ${name}`);
        } catch (err) {
          summaries[name] = `[Summary unavailable: ${String(err)}]`;
          errors.push(`Failed to summarize ${name}: ${String(err)}`);
        }
      }

      // 5b. Generate individual object docs
      for (const obj of cluster.objects) {
        const source = sources.get(obj.name);
        if (!source) continue;

        const dagNode: DagNode = {
          name: obj.name, type: obj.type, isCustom: true, sourceAvailable: true,
          usedBy: cluster.internalEdges.filter((e) => e.to === obj.name).map((e) => e.from),
        };

        const edges = edgesByFrom.get(obj.name) ?? [];
        const depDetails = edges
          .filter((e) => summaries[e.to])
          .map((e) => ({
            name: e.to,
            type: objectMap.get(e.to)?.type ?? "UNKNOWN",
            summary: summaries[e.to],
            usedMembers: e.references.map((r) => ({
              memberName: r.memberName, memberType: r.memberType,
            })),
          }));

        // Package-internal where-used
        const internalWhereUsed = cluster.internalEdges
          .filter((e) => e.to === obj.name)
          .map((e) => ({
            name: e.from,
            type: objectMap.get(e.from)?.type ?? "UNKNOWN",
            description: "Package-internal reference",
          }));

        const template = resolveTemplate(input.templateType, input.templateCustom, obj.type);
        const docConfig: LlmConfig = { ...input.docLlm, maxTokens: template.maxOutputTokens };
        const docMessages = buildDocPrompt(dagNode, source, depDetails, template, internalWhereUsed);

        const toolExecutor = async (tc: ToolCall): Promise<string> => {
          switch (tc.name) {
            case "get_source":
              try { return await client.fetchSource(tc.arguments.object_name); }
              catch (err) { return `Error: ${String(err)}`; }
            case "get_where_used":
              try {
                const refs = await client.getWhereUsed(tc.arguments.object_name);
                if (refs.length === 0) return "No where-used references found.";
                return refs.map((r) => `${r.name} (${r.type}): ${r.description}`).join("\n");
              } catch (err) { return `Error: ${String(err)}`; }
            default: return `Unknown tool: ${tc.name}`;
          }
        };

        try {
          log(`  Generating doc for ${obj.name}...`);
          const response = await callLlmAgentLoop(
            docConfig, docMessages, AGENT_TOOLS, toolExecutor, DOC_AGENT_MAX_ITERATIONS, 0,
          );
          objectDocs[obj.name] = response.content;
          objectDocTokens += response.usage.promptTokens + response.usage.completionTokens;
        } catch (err) {
          objectDocs[obj.name] = `Documentation generation failed: ${String(err)}`;
          errors.push(`Failed to generate doc for ${obj.name}: ${String(err)}`);
        }
      }

      // 5c. Generate cluster summary
      if (cluster.name !== "Standalone Objects" && cluster.objects.length > 1) {
        const clusterObjectSummaries = cluster.objects.map((o) => ({
          name: o.name, type: o.type, summary: summaries[o.name] ?? o.description,
        }));

        const clusterMessages = buildClusterSummaryPrompt(clusterObjectSummaries, cluster.internalEdges);
        const clusterConfig: LlmConfig = { ...input.summaryLlm, maxTokens: CLUSTER_SUMMARY_MAX_TOKENS };

        try {
          const response = await callLlm(clusterConfig, clusterMessages);
          const lines = response.content.split("\n");
          cluster.name = lines[0].trim();
          clusterSummaries[cluster.name] = lines.slice(2).join("\n").trim();
          clusterSummaryTokens += response.usage.promptTokens + response.usage.completionTokens;
          log(`  Cluster named: ${cluster.name}`);
        } catch (err) {
          cluster.name = `Cluster ${cluster.id + 1}`;
          clusterSummaries[cluster.name] = "[Summary unavailable]";
          errors.push(`Failed to summarize cluster ${cluster.id}: ${String(err)}`);
        }
      } else if (cluster.name === "Standalone Objects") {
        clusterSummaries[cluster.name] = "Objects with no internal package dependencies.";
      } else if (cluster.objects.length === 1) {
        // Single-object cluster — use the object's summary as cluster summary
        const obj = cluster.objects[0];
        cluster.name = obj.name;
        clusterSummaries[cluster.name] = summaries[obj.name] ?? obj.description;
      }
    }

    // 6. Generate package overview
    log("Generating package overview...");
    const aggregatedExternalDeps = aggregateExternalDeps(graph);
    const overviewMessages = buildPackageOverviewPrompt(
      input.packageName,
      clusters.map((c) => ({
        name: c.name,
        summary: clusterSummaries[c.name] ?? "",
        objectCount: c.objects.length,
      })),
      aggregatedExternalDeps,
    );
    const overviewConfig: LlmConfig = { ...input.docLlm, maxTokens: PACKAGE_OVERVIEW_MAX_TOKENS };

    let overviewText = "";
    try {
      const response = await callLlm(overviewConfig, overviewMessages);
      overviewText = response.content;
      overviewTokens = response.usage.promptTokens + response.usage.completionTokens;
    } catch (err) {
      overviewText = `Package overview generation failed: ${String(err)}`;
      errors.push(`Failed to generate package overview: ${String(err)}`);
    }

    // 7. Assemble hierarchical document
    const documentation = assembleDocument(
      input.packageName, overviewText, clusters, clusterSummaries, objectDocs, aggregatedExternalDeps,
    );

    const totalTokens = summaryTokens + objectDocTokens + clusterSummaryTokens + overviewTokens;
    log(`Package documentation complete. ${totalTokens} total tokens.`);

    return {
      packageName: input.packageName,
      documentation,
      objectCount: objects.length,
      clusterCount: clusters.length,
      summaries,
      clusterSummaries,
      objectDocs,
      tokenUsage: { summaryTokens, objectDocTokens, clusterSummaryTokens, overviewTokens, totalTokens },
      errors,
    };
  } finally {
    try { await client.disconnect(); } catch { /* ignore */ }
  }
}

function emptyResult(packageName: string, errors: string[]): PackageDocResult {
  return {
    packageName,
    documentation: `# Package ${packageName}\n\nNo relevant custom objects found in this package.`,
    objectCount: 0,
    clusterCount: 0,
    summaries: {},
    clusterSummaries: {},
    objectDocs: {},
    tokenUsage: { summaryTokens: 0, objectDocTokens: 0, clusterSummaryTokens: 0, overviewTokens: 0, totalTokens: 0 },
    errors: [...errors, "No relevant custom objects found."],
  };
}

/**
 * Assembles the hierarchical Markdown document from all generated pieces.
 */
export function assembleDocument(
  packageName: string,
  overview: string,
  clusters: Cluster[],
  clusterSummaries: Record<string, string>,
  objectDocs: Record<string, string>,
  externalDeps: Array<{ name: string; type: string; usedBy: string[] }>,
): string {
  const parts: string[] = [];

  parts.push(`# Package ${packageName}`);
  parts.push("");
  parts.push(overview);

  for (const cluster of clusters) {
    parts.push("");
    parts.push("---");
    parts.push("");
    parts.push(`## ${cluster.name}`);
    parts.push("");

    if (clusterSummaries[cluster.name]) {
      parts.push(clusterSummaries[cluster.name]);
    }

    for (const obj of cluster.objects) {
      const doc = objectDocs[obj.name];
      if (doc) {
        parts.push("");
        // Shift heading levels: # → ###, ## → ####
        const shiftedDoc = doc.replace(/^# /gm, "### ").replace(/^## /gm, "#### ");
        parts.push(shiftedDoc);
      }
    }
  }

  if (externalDeps.length > 0) {
    parts.push("");
    parts.push("---");
    parts.push("");
    parts.push("## External Dependencies");
    parts.push("");
    for (const dep of externalDeps.slice(0, 30)) {
      parts.push(`- **${dep.name}** (${dep.type}) — used by: ${dep.usedBy.join(", ")}`);
    }
  }

  return parts.join("\n");
}

/**
 * Aggregates external dependencies across the package, sorted by reference count.
 */
export function aggregateExternalDeps(
  graph: PackageGraph,
): Array<{ name: string; type: string; usedBy: string[] }> {
  const depMap = new Map<string, { type: string; usedBy: Set<string> }>();
  for (const ext of graph.externalDependencies) {
    if (!depMap.has(ext.to)) depMap.set(ext.to, { type: ext.toType, usedBy: new Set() });
    depMap.get(ext.to)!.usedBy.add(ext.from);
  }
  return Array.from(depMap.entries())
    .map(([name, data]) => ({ name, type: data.type, usedBy: Array.from(data.usedBy) }))
    .sort((a, b) => b.usedBy.length - a.usedBy.length);
}
