import { createConnectedClient, fetchSourceForNodes } from "./dag-builder";
import { AdtClientWrapper } from "./adt-client";
import { fetchPackageObjects, buildPackageGraph, detectClusters, discoverPackageTree, flattenPackageTree } from "./package-graph";
import { callLlm, callLlmAgentLoop } from "./llm-client";
import { computeTopologicalLevels } from "./doc-generator";
import {
  buildSummaryPrompt, buildDocPrompt, buildTriagePrompt,
  buildClusterSummaryPrompt,
} from "./prompts";
import { AGENT_TOOLS } from "./tools";
import { resolveTemplate, CLUSTER_SUMMARY_MAX_TOKENS } from "./templates";
import {
  assembleHtmlWiki, renderFullPageHtml, renderSingleObjectHtml,
  assembleHierarchicalHtmlWiki, renderHierarchicalFullPageHtml,
  SubPackageRenderData,
} from "./html-renderer";
import {
  PackageDocInput, PackageDocResult, PackageObject, PackageGraph, Cluster, SubPackageNode,
  DagEdge, DagNode, LlmConfig, ToolCall, TriageInput, TriageResult,
} from "./types";

const MAX_PACKAGE_OBJECTS = 100;
const DOC_AGENT_MAX_ITERATIONS = 5;

function log(msg: string): void {
  process.stderr.write(`[package-doc] ${msg}\n`);
}

/** Triage metadata for a single object (returned in triage-only mode). */
export interface TriageObjectMeta {
  name: string;
  type: string;
  summary: string;
  sourceLines: number;
  depCount: number;
  usedByCount: number;
  triageDecision: "full" | "summary";
  clusterName: string;
}

/** Options controlling what processPackageObjects does. */
interface ProcessOptions {
  triageOnly?: boolean;
  fullDocObjects?: Set<string>;
  precomputedSummaries?: Record<string, string>;
  precomputedClusterSummaries?: Record<string, string>;
  precomputedClusterAssignments?: Record<string, string[]>;
}

/**
 * Build a fallback cluster name from the object types when LLM fails.
 * e.g., "CLAS/INTF Objects" or "CDS Views"
 */
function buildFallbackClusterName(objects: Array<{ name: string; type: string }>): string {
  const typeCounts = new Map<string, number>();
  for (const o of objects) {
    typeCounts.set(o.type, (typeCounts.get(o.type) ?? 0) + 1);
  }
  const sorted = [...typeCounts.entries()].sort((a, b) => b[1] - a[1]);
  const topTypes = sorted.slice(0, 2).map(([t]) => t);
  return `${topTypes.join("/")} Objects`;
}

/**
 * Build a fallback cluster summary from object summaries when LLM fails.
 */
function buildFallbackClusterSummary(objects: Array<{ name: string; type: string; summary: string }>): string {
  const lines = objects
    .filter((o) => o.summary && o.summary !== "[Summary unavailable]")
    .slice(0, 8)
    .map((o) => `${o.name} (${o.type}): ${o.summary}`);
  if (lines.length === 0) return `Contains ${objects.length} objects: ${objects.map((o) => o.name).join(", ")}.`;
  return `Contains ${objects.length} objects:\n${lines.join("\n")}`;
}

/** Result of processing one (sub-)package's objects. */
interface ProcessResult {
  clusters: Cluster[];
  graph: PackageGraph;
  summaries: Record<string, string>;
  objectDocs: Record<string, string>;
  clusterSummaries: Record<string, string>;
  tokenUsage: { summaryTokens: number; objectDocTokens: number; clusterSummaryTokens: number };
  triageMetadata?: TriageObjectMeta[];
}

/**
 * Processes a set of package objects: fetch source, build graph, detect clusters,
 * summarize, triage, generate docs, generate cluster summaries.
 * Reusable for both root packages and sub-packages.
 */
async function processPackageObjects(
  client: AdtClientWrapper,
  objects: PackageObject[],
  packageLabel: string,
  input: PackageDocInput,
  errors: string[],
  excludedSet?: Set<string>,
  options?: ProcessOptions,
): Promise<ProcessResult> {
  const summaries: Record<string, string> = options?.precomputedSummaries ? { ...options.precomputedSummaries } : {};
  const objectDocs: Record<string, string> = {};
  const clusterSummaries: Record<string, string> = options?.precomputedClusterSummaries ? { ...options.precomputedClusterSummaries } : {};
  let summaryTokens = 0;
  let objectDocTokens = 0;
  let clusterSummaryTokens = 0;
  const triageMetadata: TriageObjectMeta[] = [];

  const hasSummaries = !!options?.precomputedSummaries;
  const hasClusterSummaries = !!options?.precomputedClusterSummaries;
  const hasClusterAssignments = !!options?.precomputedClusterAssignments;

  // Fetch source for all objects (pass URI from package contents for direct access)
  log(`[${packageLabel}] Fetching source code for ${objects.length} objects...`);
  const sources = await fetchSourceForNodes(client, objects, errors);
  log(`[${packageLabel}] Fetched source for ${sources.size}/${objects.length} objects.`);

  // Build package-internal graph
  log(`[${packageLabel}] Building dependency graph...`);
  const graph = buildPackageGraph(objects, sources, errors);
  log(`[${packageLabel}] Internal edges: ${graph.internalEdges.length}, External deps: ${graph.externalDependencies.length}`);

  // Detect clusters via Union-Find (or use precomputed assignments)
  let clusters: Cluster[];
  if (hasClusterAssignments) {
    log(`[${packageLabel}] Using precomputed cluster assignments...`);
    clusters = rebuildClustersFromAssignments(objects, graph, options!.precomputedClusterAssignments!);
    log(`[${packageLabel}] Restored ${clusters.length} cluster(s) from precomputed assignments.`);
  } else {
    log(`[${packageLabel}] Detecting functional clusters...`);
    const detectResult = detectClusters(graph);
    clusters = detectResult.clusters;
    if (detectResult.hubs.length > 0) {
      log(`[${packageLabel}] Hub objects filtered: ${detectResult.hubs.join(", ")}`);
    }
    log(`[${packageLabel}] Found ${clusters.length} cluster(s).`);
  }

  // Process each cluster
  for (let ci = 0; ci < clusters.length; ci++) {
    const cluster = clusters[ci];
    log(`[${packageLabel}] Processing cluster ${ci + 1}/${clusters.length} (${cluster.objects.length} objects)...`);

    const edgesByFrom = new Map<string, DagEdge[]>();
    for (const edge of cluster.internalEdges) {
      if (!edgesByFrom.has(edge.from)) edgesByFrom.set(edge.from, []);
      edgesByFrom.get(edge.from)!.push(edge);
    }
    const objectMap = new Map(cluster.objects.map((o) => [o.name, o]));

    // Summarize each object (skip if precomputed summaries provided)
    if (!hasSummaries) {
      const levels = computeTopologicalLevels(cluster.topologicalOrder, edgesByFrom, "");
      const maxLevel = cluster.topologicalOrder.length > 0
        ? Math.max(0, ...Array.from(levels.values()))
        : 0;
      log(`  Computed ${maxLevel + 1} topological level(s) for summarization.`);

      for (let level = 0; level <= maxLevel; level++) {
        const nodesAtLevel = cluster.topologicalOrder.filter((n) => levels.get(n) === level);
        if (nodesAtLevel.length === 0) continue;

        const callSpecs: Array<{ name: string; messages: import("./types").LlmMessage[] }> = [];
        for (const name of nodesAtLevel) {
          if (excludedSet?.has(name)) continue;
          const obj = objectMap.get(name);
          if (!obj) continue;
          const source = sources.get(name);
          const edges = edgesByFrom.get(name) ?? [];
          const depSums = edges.filter((e) => summaries[e.to]).map((e) => ({ name: e.to, summary: summaries[e.to] }));
          const dagNode: DagNode = {
            name, type: obj.type, isCustom: true, sourceAvailable: !!source,
            usedBy: cluster.internalEdges.filter((e) => e.to === name).map((e) => e.from),
          };
          // For DDIC objects without source, use description as pseudo-source
          const effectiveSource = source || `* ${obj.type} object: ${name}\n* Description: ${obj.description || "No description available"}`;
          callSpecs.push({ name, messages: buildSummaryPrompt(dagNode, effectiveSource, depSums) });
        }
        if (callSpecs.length === 0) continue;
        log(`  Level ${level}: ${callSpecs.length} node(s) — summarizing in parallel...`);

        const results = await Promise.allSettled(
          callSpecs.map((spec) => callLlm(input.summaryLlm, spec.messages)),
        );

        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          const name = callSpecs[i].name;
          if (result.status === "fulfilled") {
            const rawContent = result.value.content;
            const rawLen = rawContent?.length ?? 0;
            summaries[name] = rawContent || objectMap.get(name)?.description || "[Summary unavailable]";
            summaryTokens += result.value.usage.promptTokens + result.value.usage.completionTokens;
            if (!rawContent) {
              log(`  WARNING: LLM returned empty summary for ${name} — using fallback (${summaries[name].length} chars)`);
            } else {
              log(`  Summarized ${name}: LLM returned ${rawLen} chars, stored ${summaries[name].length} chars`);
            }
          } else {
            summaries[name] = objectMap.get(name)?.description || "[Summary unavailable]";
            log(`  ERROR: Summary for ${name} failed: ${String(result.reason)} — using fallback (${summaries[name].length} chars)`);
            errors.push(`Summary for ${name} failed: ${String(result.reason)}`);
          }
        }
      }
    } else {
      log(`  Using precomputed summaries for ${cluster.objects.length} objects.`);
    }

    // Triage
    const triageSet = new Set<string>();
    const triageCandidates = cluster.objects.filter((o) => !excludedSet?.has(o.name));

    if (options?.fullDocObjects) {
      // Phase 3: use user-approved list
      for (const o of triageCandidates) {
        if (options.fullDocObjects.has(o.name)) triageSet.add(o.name);
      }
      log(`  Triage (user override): ${triageSet.size}/${triageCandidates.length} objects selected for full documentation.`);
    } else if (triageCandidates.length > 1) {
      const triageInput = triageCandidates
        .filter((o) => sources.has(o.name))
        .map((o) => {
          const srcLines = (sources.get(o.name) ?? "").split("\n").length;
          const depCount = (edgesByFrom.get(o.name) ?? []).length;
          const usedByCount = cluster.internalEdges.filter((e) => e.to === o.name).length;
          return { name: o.name, type: o.type, summary: summaries[o.name] || o.description || "", sourceLines: srcLines, depCount, usedByCount };
        });
      try {
        const triageResponse = await callLlm(input.summaryLlm, buildTriagePrompt(triageInput));
        summaryTokens += triageResponse.usage.promptTokens + triageResponse.usage.completionTokens;
        for (const name of triageResponse.content.split("\n").map((l) => l.trim()).filter((l) => l.length > 0)) {
          triageSet.add(name);
        }
        log(`  Triage: ${triageSet.size}/${triageCandidates.length} objects selected for full documentation.`);
      } catch (err) {
        errors.push(`Triage failed: ${String(err)}, generating docs for all objects.`);
        for (const o of triageCandidates) triageSet.add(o.name);
      }
    } else {
      for (const o of triageCandidates) triageSet.add(o.name);
    }

    // Collect triage metadata (for triage-only mode or always — cheap to compute)
    for (const obj of triageCandidates) {
      const srcLines = sources.has(obj.name) ? (sources.get(obj.name) ?? "").split("\n").length : 0;
      const depCount = (edgesByFrom.get(obj.name) ?? []).length;
      const usedByCount = cluster.internalEdges.filter((e) => e.to === obj.name).length;
      triageMetadata.push({
        name: obj.name,
        type: obj.type,
        summary: summaries[obj.name] || obj.description || "[Summary unavailable]",
        sourceLines: srcLines,
        depCount,
        usedByCount,
        triageDecision: triageSet.has(obj.name) ? "full" : "summary",
        clusterName: "", // will be set after cluster naming
      });
    }

    // In triage-only mode, skip full doc generation
    if (!options?.triageOnly) {
      // Generate individual object docs (only for triaged objects, skip excluded)
      for (const obj of cluster.objects) {
        if (excludedSet?.has(obj.name)) continue;
        if (!triageSet.has(obj.name)) {
          log(`  Skipping doc for ${obj.name} (triage: summary only).`);
          continue;
        }
        const source = sources.get(obj.name);
        // For DDIC objects without source, use description as pseudo-source
        const effectiveSource = source || `* ${obj.type} object: ${obj.name}\n* Description: ${obj.description || "No description available"}`;

        const dagNode: DagNode = {
          name: obj.name, type: obj.type, isCustom: true, sourceAvailable: !!source,
          usedBy: cluster.internalEdges.filter((e) => e.to === obj.name).map((e) => e.from),
        };
        const edges = edgesByFrom.get(obj.name) ?? [];
        const depDetails = edges.filter((e) => summaries[e.to]).map((e) => ({
          name: e.to, type: objectMap.get(e.to)?.type ?? "UNKNOWN", summary: summaries[e.to],
          usedMembers: e.references.map((r) => ({ memberName: r.memberName, memberType: r.memberType })),
        }));
        const internalWhereUsed = cluster.internalEdges
          .filter((e) => e.to === obj.name)
          .map((e) => ({ name: e.from, type: objectMap.get(e.from)?.type ?? "UNKNOWN", description: "Package-internal reference" }));

        const template = resolveTemplate(input.templateType, input.templateCustom, obj.type, input.templateMaxWords, input.templateMaxOutputTokens);
        const docConfig: LlmConfig = { ...input.docLlm, maxTokens: template.maxOutputTokens };
        const docMessages = buildDocPrompt(dagNode, effectiveSource, depDetails, template, internalWhereUsed, input.userContext);

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
          const response = await callLlmAgentLoop(docConfig, docMessages, AGENT_TOOLS, toolExecutor, DOC_AGENT_MAX_ITERATIONS, 0);
          objectDocs[obj.name] = response.content;
          objectDocTokens += response.usage.promptTokens + response.usage.completionTokens;
        } catch (err) {
          objectDocs[obj.name] = `Documentation generation failed: ${String(err)}`;
          errors.push(`Failed to generate doc for ${obj.name}: ${String(err)}`);
        }
      }
    }

    // Generate cluster summary (skip if precomputed)
    if (!hasClusterSummaries) {
      if (cluster.name !== "Standalone Objects" && cluster.objects.length > 1) {
        const clusterObjectSummaries = cluster.objects.map((o) => ({
          name: o.name, type: o.type, summary: summaries[o.name] ?? (o.description || "[Summary unavailable]"),
        }));
        const clusterConfig: LlmConfig = { ...input.summaryLlm, maxTokens: CLUSTER_SUMMARY_MAX_TOKENS };
        log(`  Generating cluster summary for ${cluster.objects.length} objects (provider: ${input.summaryLlm.provider}, model: ${input.summaryLlm.model})...`);
        try {
          const response = await callLlm(clusterConfig, buildClusterSummaryPrompt(clusterObjectSummaries, cluster.internalEdges));
          log(`  Cluster summary LLM response: ${response.content.length} chars, ${response.usage.promptTokens}+${response.usage.completionTokens} tokens`);
          if (!response.content || response.content.trim().length === 0) {
            log(`  WARNING: LLM returned empty cluster summary — using fallback`);
            cluster.name = buildFallbackClusterName(clusterObjectSummaries) || `Cluster ${cluster.id + 1}`;
            clusterSummaries[cluster.name] = buildFallbackClusterSummary(clusterObjectSummaries);
          } else {
            // Skip leading blank lines — some models prepend newlines
            const lines = response.content.split("\n");
            const firstNonEmpty = lines.findIndex((l) => l.trim().length > 0);
            const suggestedName = firstNonEmpty >= 0 ? lines[firstNonEmpty].trim() : "";
            cluster.name = suggestedName || buildFallbackClusterName(clusterObjectSummaries) || `Cluster ${cluster.id + 1}`;
            const summaryLines = firstNonEmpty >= 0 ? lines.slice(firstNonEmpty + 1) : lines;
            const summaryText = summaryLines.join("\n").trim();
            clusterSummaries[cluster.name] = summaryText || buildFallbackClusterSummary(clusterObjectSummaries);
          }
          clusterSummaryTokens += response.usage.promptTokens + response.usage.completionTokens;
          log(`  Cluster named: ${cluster.name}`);
        } catch (err) {
          log(`  ERROR: Cluster summary LLM call failed: ${String(err)}`);
          // Fallback: name from primary object types, summary from object list
          cluster.name = buildFallbackClusterName(clusterObjectSummaries) || `Cluster ${cluster.id + 1}`;
          clusterSummaries[cluster.name] = buildFallbackClusterSummary(clusterObjectSummaries);
          errors.push(`Failed to summarize cluster ${cluster.id}: ${String(err)}`);
        }
      } else if (cluster.name === "Standalone Objects") {
        clusterSummaries[cluster.name] = "Objects with no internal package dependencies.";
        log(`  Standalone cluster: ${cluster.objects.length} object(s)`);
      } else if (cluster.objects.length === 1) {
        const obj = cluster.objects[0];
        cluster.name = obj.name;
        clusterSummaries[cluster.name] = summaries[obj.name] || obj.description || "";
        log(`  Single-object cluster: ${obj.name} — summary ${clusterSummaries[cluster.name].length} chars`);
      }
    }

    // Back-fill cluster name in triage metadata
    for (const meta of triageMetadata) {
      if (cluster.objects.some((o) => o.name === meta.name)) {
        meta.clusterName = cluster.name;
      }
    }
  }

  // Log final state summary
  const summaryCount = Object.values(summaries).filter((s) => s && s.length > 0).length;
  const emptySummaries = Object.entries(summaries).filter(([, s]) => !s || s.length === 0).map(([k]) => k);
  const docCount = Object.values(objectDocs).filter((d) => d && d.length > 0).length;
  const clusterSumCount = Object.values(clusterSummaries).filter((s) => s && s.length > 0).length;
  log(`[${packageLabel}] Final state: ${summaryCount} summaries, ${docCount} docs, ${clusterSumCount} cluster summaries, ${clusters.length} clusters`);
  if (emptySummaries.length > 0) {
    log(`[${packageLabel}] WARNING: Objects with empty summaries: ${emptySummaries.join(", ")}`);
  }
  for (const cluster of clusters) {
    const cs = clusterSummaries[cluster.name];
    log(`[${packageLabel}]   Cluster "${cluster.name}": summary ${cs ? cs.length : 0} chars, ${cluster.objects.length} objects`);
  }

  return { clusters, graph, summaries, objectDocs, clusterSummaries, tokenUsage: { summaryTokens, objectDocTokens, clusterSummaryTokens }, triageMetadata };
}

/**
 * Rebuild Cluster objects from precomputed cluster assignments.
 * Used in Phase 3 to skip cluster detection.
 */
function rebuildClustersFromAssignments(
  objects: PackageObject[],
  graph: PackageGraph,
  assignments: Record<string, string[]>,
): Cluster[] {
  const objectsByName = new Map(objects.map((o) => [o.name, o]));
  const clusters: Cluster[] = [];
  let id = 0;

  for (const [clusterName, objectNames] of Object.entries(assignments)) {
    const clusterObjects = objectNames
      .map((n) => objectsByName.get(n))
      .filter((o): o is PackageObject => !!o);
    if (clusterObjects.length === 0) continue;

    const nameSet = new Set(objectNames);
    const internalEdges = graph.internalEdges.filter(
      (e) => nameSet.has(e.from) && nameSet.has(e.to),
    );

    // Simple topological sort within cluster
    const inDegree = new Map<string, number>();
    for (const n of objectNames) inDegree.set(n, 0);
    for (const e of internalEdges) {
      inDegree.set(e.from, (inDegree.get(e.from) ?? 0) + 1);
    }
    const queue = objectNames.filter((n) => (inDegree.get(n) ?? 0) === 0);
    const topo: string[] = [];
    while (queue.length > 0) {
      const n = queue.shift()!;
      topo.push(n);
      for (const e of internalEdges.filter((e) => e.to === n)) {
        const deg = (inDegree.get(e.from) ?? 1) - 1;
        inDegree.set(e.from, deg);
        if (deg === 0) queue.push(e.from);
      }
    }
    // Add any remaining nodes not in topo
    for (const n of objectNames) {
      if (!topo.includes(n)) topo.push(n);
    }

    clusters.push({
      id: id++,
      name: clusterName,
      objects: clusterObjects,
      internalEdges,
      topologicalOrder: topo,
    });
  }

  // Ensure "Standalone Objects" comes after named clusters
  clusters.sort((a, b) => {
    if (a.name === "Standalone Objects") return 1;
    if (b.name === "Standalone Objects") return -1;
    return 0;
  });

  return clusters;
}

/**
 * Runs Phase 2: source fetch, graph, summarization, clustering, triage.
 * Returns triage decisions + summaries for the user to review before Phase 3.
 */
export async function triagePackage(input: TriageInput): Promise<TriageResult> {
  const errors: string[] = [];
  const excludedSet = input.excludedObjects && input.excludedObjects.length > 0
    ? new Set(input.excludedObjects)
    : undefined;

  const client = await createConnectedClient(
    input.systemUrl, input.username, input.password, input.client,
  );

  try {
    const maxDepth = input.maxSubPackageDepth ?? 2;
    log(`[triage] Discovering package tree for ${input.packageName} (max depth: ${maxDepth})...`);
    const tree = await discoverPackageTree(client, input.packageName, maxDepth, errors);

    const allNodes = flattenPackageTree(tree);
    const subPackagesWithObjects = allNodes.filter((n) => n.depth > 0 && n.objects.length > 0);
    const totalObjects = allNodes.reduce((n, p) => n + p.objects.length, 0);
    log(`[triage] Package tree: ${allNodes.length} package(s), ${totalObjects} total objects.`);

    if (totalObjects === 0) {
      return { packageName: input.packageName, objects: [], clusters: [], errors: [...errors, "No relevant custom objects found."] };
    }

    // Build a fake PackageDocInput just for processPackageObjects (only summaryLlm used in triage mode)
    const pseudoInput: PackageDocInput = {
      command: "generate-package-doc",
      systemUrl: input.systemUrl,
      client: input.client,
      username: input.username,
      password: input.password,
      packageName: input.packageName,
      summaryLlm: input.summaryLlm,
      docLlm: input.summaryLlm, // not used in triage-only mode
      excludedObjects: input.excludedObjects,
    };

    const allTriageObjects: TriageResult["objects"] = [];
    const allClusters: TriageResult["clusters"] = [];

    // Process root objects
    let rootObjects = tree.objects;
    if (rootObjects.length > MAX_PACKAGE_OBJECTS) {
      errors.push(`Root package has ${rootObjects.length} objects; capping to ${MAX_PACKAGE_OBJECTS}.`);
      rootObjects = rootObjects.slice(0, MAX_PACKAGE_OBJECTS);
    }
    if (rootObjects.length > 0) {
      const result = await processPackageObjects(client, rootObjects, input.packageName, pseudoInput, errors, excludedSet, { triageOnly: true });
      for (const meta of result.triageMetadata ?? []) {
        allTriageObjects.push({ ...meta, subPackage: "" });
      }
      for (const cluster of result.clusters) {
        allClusters.push({
          name: cluster.name,
          summary: result.clusterSummaries[cluster.name] || "",
          objectNames: cluster.objects.map((o) => o.name),
          subPackage: "",
        });
      }
    }

    // Process sub-packages (skip those where all objects are excluded)
    for (const spNode of subPackagesWithObjects) {
      if (excludedSet && spNode.objects.every((o) => excludedSet.has(o.name))) {
        log(`[triage] Skipping sub-package ${spNode.name} — all ${spNode.objects.length} objects excluded`);
        continue;
      }
      let spObjects = spNode.objects;
      if (spObjects.length > MAX_PACKAGE_OBJECTS) {
        errors.push(`Sub-package ${spNode.name} has ${spObjects.length} objects; capping to ${MAX_PACKAGE_OBJECTS}.`);
        spObjects = spObjects.slice(0, MAX_PACKAGE_OBJECTS);
      }
      const result = await processPackageObjects(client, spObjects, spNode.name, pseudoInput, errors, excludedSet, { triageOnly: true });
      for (const meta of result.triageMetadata ?? []) {
        allTriageObjects.push({ ...meta, subPackage: spNode.name });
      }
      for (const cluster of result.clusters) {
        allClusters.push({
          name: cluster.name,
          summary: result.clusterSummaries[cluster.name] || "",
          objectNames: cluster.objects.map((o) => o.name),
          subPackage: spNode.name,
        });
      }
    }

    return { packageName: input.packageName, objects: allTriageObjects, clusters: allClusters, errors };
  } finally {
    try { await client.disconnect(); } catch { /* ignore */ }
  }
}

/**
 * Generates wiki-style documentation for an entire ABAP package.
 * Supports recursive sub-package discovery and hierarchical documentation.
 */
export async function generatePackageDocumentation(input: PackageDocInput): Promise<PackageDocResult> {
  const errors: string[] = [];
  let overviewTokens = 0;
  const excludedSet = input.excludedObjects && input.excludedObjects.length > 0
    ? new Set(input.excludedObjects)
    : undefined;

  const client = await createConnectedClient(
    input.systemUrl, input.username, input.password, input.client,
  );

  try {
    // 1. Discover package tree (always, to detect sub-packages)
    const maxDepth = input.maxSubPackageDepth ?? 2;
    log(`Discovering package tree for ${input.packageName} (max depth: ${maxDepth})...`);
    const tree = await discoverPackageTree(client, input.packageName, maxDepth, errors);

    const allNodes = flattenPackageTree(tree);
    const subPackagesWithObjects = allNodes.filter((n) => n.depth > 0 && n.objects.length > 0);
    const hasSubPackages = subPackagesWithObjects.length > 0;
    const totalObjects = allNodes.reduce((n, p) => n + p.objects.length, 0);
    log(`Package tree: ${allNodes.length} package(s), ${totalObjects} total objects, ${subPackagesWithObjects.length} sub-packages with objects.`);

    if (totalObjects === 0) {
      return emptyResult(input.packageName, errors);
    }

    // 2. Cap root objects
    let rootObjects = tree.objects;
    if (rootObjects.length > MAX_PACKAGE_OBJECTS) {
      errors.push(`Root package has ${rootObjects.length} objects; capping to ${MAX_PACKAGE_OBJECTS}.`);
      rootObjects = rootObjects.slice(0, MAX_PACKAGE_OBJECTS);
    }

    // Helper: filter composite-keyed maps by sub-package scope.
    // Java sends keys as "SUBPKG::ClusterName" for sub-packages, plain "ClusterName" for root.
    const hasPrecomputed = !!(input.fullDocObjects || input.precomputedSummaries || input.precomputedClusterSummaries);
    const fullDocSet = input.fullDocObjects ? new Set(input.fullDocObjects) : undefined;

    function buildScopedOpts(subPackageName?: string): ProcessOptions | undefined {
      if (!hasPrecomputed) return undefined;
      const prefix = subPackageName ? subPackageName + "::" : "";
      return {
        fullDocObjects: fullDocSet,
        precomputedSummaries: input.precomputedSummaries,
        precomputedClusterSummaries: filterByPrefix(input.precomputedClusterSummaries, prefix),
        precomputedClusterAssignments: filterByPrefix(input.precomputedClusterAssignments, prefix),
      };
    }

    if (!hasSubPackages) {
      // ─── FLAT FLOW (no sub-packages) — existing behavior with summaries ───
      if (rootObjects.length === 0) {
        return emptyResult(input.packageName, errors);
      }

      const result = await processPackageObjects(client, rootObjects, input.packageName, input, errors, excludedSet, buildScopedOpts());
      const aggregatedExternalDeps = aggregateExternalDeps(result.graph);

      const documentation = assembleDocument(input.packageName, result.clusters, result.clusterSummaries, result.objectDocs, aggregatedExternalDeps, result.summaries);
      const pages = assembleHtmlWiki(input.packageName, result.clusters, result.clusterSummaries, result.objectDocs, aggregatedExternalDeps, result.summaries);
      const singlePageHtml = renderFullPageHtml(input.packageName, result.clusters, result.clusterSummaries, result.objectDocs, result.summaries);

      const { summaryTokens, objectDocTokens, clusterSummaryTokens } = result.tokenUsage;
      const totalTokens = summaryTokens + objectDocTokens + clusterSummaryTokens + overviewTokens;

      return {
        packageName: input.packageName,
        documentation, singlePageHtml, pages,
        objectCount: rootObjects.length,
        clusterCount: result.clusters.length,
        summaries: result.summaries, clusterSummaries: result.clusterSummaries, objectDocs: result.objectDocs,
        tokenUsage: { summaryTokens, objectDocTokens, clusterSummaryTokens, overviewTokens, totalTokens },
        errors,
      };

    } else {
      // ─── HIERARCHICAL FLOW (sub-packages present) ───
      log(`Processing ${subPackagesWithObjects.length} sub-package(s) + root objects...`);

      // Process root objects (if any)
      let rootResult: ProcessResult | undefined;
      let rootExternalDeps: Array<{ name: string; type: string; usedBy: string[] }> = [];
      if (rootObjects.length > 0) {
        log(`Processing root package objects (${rootObjects.length})...`);
        rootResult = await processPackageObjects(client, rootObjects, input.packageName, input, errors, excludedSet, buildScopedOpts());
        rootExternalDeps = aggregateExternalDeps(rootResult.graph);
      }

      // Process each sub-package
      const spRenderData: SubPackageRenderData[] = [];
      let totalSummaryTokens = rootResult?.tokenUsage.summaryTokens ?? 0;
      let totalObjectDocTokens = rootResult?.tokenUsage.objectDocTokens ?? 0;
      let totalClusterSummaryTokens = rootResult?.tokenUsage.clusterSummaryTokens ?? 0;

      for (const spNode of subPackagesWithObjects) {
        // Skip sub-packages where all objects are excluded
        if (excludedSet && spNode.objects.every((o) => excludedSet.has(o.name))) {
          log(`Skipping sub-package ${spNode.name} — all ${spNode.objects.length} objects excluded`);
          continue;
        }
        let spObjects = spNode.objects;
        if (spObjects.length > MAX_PACKAGE_OBJECTS) {
          errors.push(`Sub-package ${spNode.name} has ${spObjects.length} objects; capping to ${MAX_PACKAGE_OBJECTS}.`);
          spObjects = spObjects.slice(0, MAX_PACKAGE_OBJECTS);
        }

        log(`Processing sub-package ${spNode.name} (${spObjects.length} objects)...`);
        const spResult = await processPackageObjects(client, spObjects, spNode.name, input, errors, excludedSet, buildScopedOpts(spNode.name));
        const spExternalDeps = aggregateExternalDeps(spResult.graph);

        spRenderData.push({
          node: spNode,
          clusters: spResult.clusters,
          clusterSummaries: spResult.clusterSummaries,
          objectDocs: spResult.objectDocs,
          summaries: spResult.summaries,
          subPackageSummary: "",
          externalDeps: spExternalDeps,
        });

        totalSummaryTokens += spResult.tokenUsage.summaryTokens;
        totalObjectDocTokens += spResult.tokenUsage.objectDocTokens;
        totalClusterSummaryTokens += spResult.tokenUsage.clusterSummaryTokens;
      }

      // Assemble all outputs
      const rootClusters = rootResult?.clusters ?? [];
      const rootClusterSummaries = rootResult?.clusterSummaries ?? {};
      const rootObjectDocs = rootResult?.objectDocs ?? {};
      const rootSummaries = rootResult?.summaries ?? {};

      const documentation = assembleHierarchicalDocument(
        input.packageName, rootClusters, rootClusterSummaries,
        rootObjectDocs, rootSummaries, rootExternalDeps, spRenderData,
      );
      const pages = assembleHierarchicalHtmlWiki(
        input.packageName, rootClusters, rootClusterSummaries,
        rootObjectDocs, rootSummaries, rootExternalDeps, spRenderData,
      );
      const singlePageHtml = renderHierarchicalFullPageHtml(
        input.packageName, rootClusters, rootClusterSummaries,
        rootObjectDocs, rootSummaries, spRenderData,
      );

      // Merge all summaries/objectDocs for the result
      const allSummaries: Record<string, string> = { ...rootSummaries };
      const allObjectDocs: Record<string, string> = { ...rootObjectDocs };
      const allClusterSummaries: Record<string, string> = { ...rootClusterSummaries };
      for (const sp of spRenderData) {
        Object.assign(allSummaries, sp.summaries);
        Object.assign(allObjectDocs, sp.objectDocs);
        Object.assign(allClusterSummaries, sp.clusterSummaries);
      }

      const totalTokens = totalSummaryTokens + totalObjectDocTokens + totalClusterSummaryTokens + overviewTokens;
      const allClusterCount = rootClusters.length + spRenderData.reduce((n, sp) => n + sp.clusters.length, 0);

      return {
        packageName: input.packageName,
        documentation, singlePageHtml, pages,
        objectCount: totalObjects,
        clusterCount: allClusterCount,
        subPackageCount: subPackagesWithObjects.length,
        summaries: allSummaries, clusterSummaries: allClusterSummaries, objectDocs: allObjectDocs,
        tokenUsage: {
          summaryTokens: totalSummaryTokens, objectDocTokens: totalObjectDocTokens,
          clusterSummaryTokens: totalClusterSummaryTokens, overviewTokens, totalTokens,
        },
        errors,
      };
    }
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
  clusters: Cluster[],
  clusterSummaries: Record<string, string>,
  objectDocs: Record<string, string>,
  externalDeps: Array<{ name: string; type: string; usedBy: string[] }>,
  summaries?: Record<string, string>,
): string {
  const parts: string[] = [];

  parts.push(`# Package ${packageName}`);

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
        const shiftedDoc = doc.replace(/^# /gm, "### ").replace(/^## /gm, "#### ");
        parts.push(shiftedDoc);
      } else if (summaries?.[obj.name]) {
        parts.push("");
        parts.push(`### ${obj.name} (${obj.type})`);
        parts.push("");
        parts.push(`> ${summaries[obj.name]}`);
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
 * Assembles hierarchical Markdown document with sub-package sections.
 */
function assembleHierarchicalDocument(
  packageName: string,
  rootClusters: Cluster[],
  rootClusterSummaries: Record<string, string>,
  rootObjectDocs: Record<string, string>,
  rootSummaries: Record<string, string>,
  rootExternalDeps: Array<{ name: string; type: string; usedBy: string[] }>,
  subPackages: SubPackageRenderData[],
): string {
  const parts: string[] = [];

  parts.push(`# Package ${packageName}`);

  // Root-level clusters first
  if (rootClusters.length > 0 && rootClusters.some((c) => c.objects.length > 0)) {
    for (const cluster of rootClusters) {
      parts.push("");
      parts.push("---");
      parts.push("");
      parts.push(`## ${cluster.name}`);
      parts.push("");
      if (rootClusterSummaries[cluster.name]) {
        parts.push(rootClusterSummaries[cluster.name]);
      }

      for (const obj of cluster.objects) {
        const doc = rootObjectDocs[obj.name];
        if (doc) {
          parts.push("");
          const shiftedDoc = doc.replace(/^# /gm, "#### ").replace(/^## /gm, "##### ");
          parts.push(shiftedDoc);
        } else if (rootSummaries[obj.name]) {
          parts.push("");
          parts.push(`#### ${obj.name} (${obj.type})`);
          parts.push("");
          parts.push(`> ${rootSummaries[obj.name]}`);
        }
      }
    }
  }

  // Sub-package sections after root
  for (const sp of subPackages) {
    parts.push("");
    parts.push("---");
    parts.push("");
    parts.push(`## ${sp.node.name}`);

    for (const cluster of sp.clusters) {
      parts.push("");
      parts.push(`### ${cluster.name}`);
      parts.push("");
      if (sp.clusterSummaries[cluster.name]) {
        parts.push(sp.clusterSummaries[cluster.name]);
      }

      for (const obj of cluster.objects) {
        const doc = sp.objectDocs[obj.name];
        if (doc) {
          parts.push("");
          const shiftedDoc = doc.replace(/^# /gm, "#### ").replace(/^## /gm, "##### ");
          parts.push(shiftedDoc);
        } else if (sp.summaries[obj.name]) {
          parts.push("");
          parts.push(`#### ${obj.name} (${obj.type})`);
          parts.push("");
          parts.push(`> ${sp.summaries[obj.name]}`);
        }
      }
    }
  }

  // External dependencies
  if (rootExternalDeps.length > 0) {
    parts.push("");
    parts.push("---");
    parts.push("");
    parts.push("## External Dependencies");
    parts.push("");
    for (const dep of rootExternalDeps.slice(0, 30)) {
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

/**
 * Filters a Record by composite key prefix.
 * Keys like "SUBPKG::ClusterName" match prefix "SUBPKG::" → stripped to "ClusterName".
 * Keys without "::" match empty prefix (root scope).
 */
function filterByPrefix<T>(map: Record<string, T> | undefined, prefix: string): Record<string, T> | undefined {
  if (!map) return undefined;
  const result: Record<string, T> = {};
  for (const [key, value] of Object.entries(map)) {
    if (prefix) {
      // Sub-package scope: match "SUBPKG::name" → strip to "name"
      if (key.startsWith(prefix)) {
        result[key.slice(prefix.length)] = value;
      }
    } else {
      // Root scope: match keys without "::"
      if (!key.includes("::")) {
        result[key] = value;
      }
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
