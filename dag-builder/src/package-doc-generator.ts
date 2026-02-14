import { createConnectedClient, fetchSourceForNodes } from "./dag-builder";
import { fetchPackageObjects, buildPackageGraph, detectClusters } from "./package-graph";
import { callLlm, callLlmAgentLoop, runBatch } from "./llm-client";
import { computeTopologicalLevels } from "./doc-generator";
import {
  buildSummaryPrompt, buildDocPrompt, buildTriagePrompt,
  buildClusterSummaryPrompt, buildPackageOverviewPrompt,
} from "./prompts";
import { AGENT_TOOLS } from "./tools";
import { resolveTemplate, PACKAGE_OVERVIEW_MAX_TOKENS, CLUSTER_SUMMARY_MAX_TOKENS } from "./templates";
import { assembleHtmlWiki, renderFullPageHtml, renderSingleObjectHtml } from "./html-renderer";
import {
  PackageDocInput, PackageDocResult, PackageObject, PackageGraph, Cluster,
  DagEdge, DagNode, LlmConfig, ToolCall, BatchRequest,
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

      // 5a. Summarize each object — batch by topological level
      const useBatch = input.mode === "batch";
      if (useBatch) {
        const levels = computeTopologicalLevels(cluster.topologicalOrder, edgesByFrom, "");
        const maxLevel = cluster.topologicalOrder.length > 0
          ? Math.max(0, ...Array.from(levels.values()))
          : 0;
        log(`  Computed ${maxLevel + 1} topological level(s) for batch summarization.`);

        for (let level = 0; level <= maxLevel; level++) {
          const nodesAtLevel = cluster.topologicalOrder.filter((n) => levels.get(n) === level);
          if (nodesAtLevel.length === 0) continue;

          log(`  Level ${level}: ${nodesAtLevel.length} node(s) — submitting batch...`);
          const batchRequests: BatchRequest[] = [];
          for (const name of nodesAtLevel) {
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
            batchRequests.push({ id: name, messages: buildSummaryPrompt(dagNode, source, depSums) });
          }

          if (batchRequests.length === 0) continue;
          try {
            const results = await runBatch(input.summaryLlm, batchRequests);
            for (const [name, response] of results) {
              summaries[name] = response.content;
              summaryTokens += response.usage.promptTokens + response.usage.completionTokens;
            }
            log(`  Level ${level}: ${results.size} summaries received.`);
          } catch (err) {
            errors.push(`Batch failed for level ${level}: ${String(err)}`);
            for (const req of batchRequests) {
              summaries[req.id] = `[Batch summary unavailable: ${String(err)}]`;
            }
          }
        }
      } else {
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
      }

      // 5b. Triage: decide which objects need full documentation
      const triageSet = new Set<string>();
      if (cluster.objects.length > 1) {
        const triageInput = cluster.objects
          .filter((o) => sources.has(o.name))
          .map((o) => {
            const srcLines = (sources.get(o.name) ?? "").split("\n").length;
            const depCount = (edgesByFrom.get(o.name) ?? []).length;
            const usedByCount = cluster.internalEdges.filter((e) => e.to === o.name).length;
            return {
              name: o.name, type: o.type,
              summary: summaries[o.name] ?? o.description,
              sourceLines: srcLines, depCount, usedByCount,
            };
          });

        const triageMessages = buildTriagePrompt(triageInput);
        try {
          const triageResponse = await callLlm(input.summaryLlm, triageMessages);
          summaryTokens += triageResponse.usage.promptTokens + triageResponse.usage.completionTokens;
          const selectedNames = triageResponse.content
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l.length > 0);
          for (const name of selectedNames) {
            triageSet.add(name);
          }
          log(`  Triage: ${triageSet.size}/${cluster.objects.length} objects selected for full documentation.`);
        } catch (err) {
          // On triage failure, generate docs for all objects
          errors.push(`Triage failed: ${String(err)}, generating docs for all objects.`);
          for (const o of cluster.objects) triageSet.add(o.name);
        }
      } else {
        // Single-object cluster: always generate full doc
        for (const o of cluster.objects) triageSet.add(o.name);
      }

      // 5c. Generate individual object docs (only for triaged objects)
      for (const obj of cluster.objects) {
        if (!triageSet.has(obj.name)) {
          log(`  Skipping doc for ${obj.name} (triage: summary only).`);
          continue;
        }
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
        const docMessages = buildDocPrompt(dagNode, source, depDetails, template, internalWhereUsed, input.userContext);

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

      // 5d. Generate cluster summary
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
      input.userContext,
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

    // 8. Build multi-page HTML wiki
    const pages = assembleHtmlWiki(
      input.packageName, overviewText, clusters, clusterSummaries, objectDocs, aggregatedExternalDeps,
    );

    // 9. Build single-page HTML
    const singlePageHtml = renderFullPageHtml(
      input.packageName, overviewText, clusters, clusterSummaries, objectDocs,
    );

    const totalTokens = summaryTokens + objectDocTokens + clusterSummaryTokens + overviewTokens;
    log(`Package documentation complete. ${totalTokens} total tokens. ${Object.keys(pages).length} HTML pages.`);

    return {
      packageName: input.packageName,
      documentation,
      singlePageHtml,
      pages,
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
  const emptyMd = `# Package ${packageName}\n\nNo relevant custom objects found in this package.`;
  return {
    packageName,
    documentation: emptyMd,
    singlePageHtml: renderSingleObjectHtml(packageName, emptyMd),
    pages: { "index.html": renderSingleObjectHtml(packageName, emptyMd) },
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
