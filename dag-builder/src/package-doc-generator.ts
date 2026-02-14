import { createConnectedClient, fetchSourceForNodes } from "./dag-builder";
import { AdtClientWrapper } from "./adt-client";
import { fetchPackageObjects, buildPackageGraph, detectClusters, discoverPackageTree, flattenPackageTree } from "./package-graph";
import { callLlm, callLlmAgentLoop, runBatch } from "./llm-client";
import { computeTopologicalLevels } from "./doc-generator";
import {
  buildSummaryPrompt, buildDocPrompt, buildTriagePrompt,
  buildClusterSummaryPrompt, buildPackageOverviewPrompt, buildSubPackageSummaryPrompt,
} from "./prompts";
import { AGENT_TOOLS } from "./tools";
import { resolveTemplate, PACKAGE_OVERVIEW_MAX_TOKENS, CLUSTER_SUMMARY_MAX_TOKENS } from "./templates";
import {
  assembleHtmlWiki, renderFullPageHtml, renderSingleObjectHtml,
  assembleHierarchicalHtmlWiki, renderHierarchicalFullPageHtml,
  SubPackageRenderData,
} from "./html-renderer";
import {
  PackageDocInput, PackageDocResult, PackageObject, PackageGraph, Cluster, SubPackageNode,
  DagEdge, DagNode, LlmConfig, ToolCall, BatchRequest,
} from "./types";

const MAX_PACKAGE_OBJECTS = 100;
const DOC_AGENT_MAX_ITERATIONS = 5;

function log(msg: string): void {
  process.stderr.write(`[package-doc] ${msg}\n`);
}

/** Result of processing one (sub-)package's objects. */
interface ProcessResult {
  clusters: Cluster[];
  graph: PackageGraph;
  summaries: Record<string, string>;
  objectDocs: Record<string, string>;
  clusterSummaries: Record<string, string>;
  tokenUsage: { summaryTokens: number; objectDocTokens: number; clusterSummaryTokens: number };
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
): Promise<ProcessResult> {
  const summaries: Record<string, string> = {};
  const objectDocs: Record<string, string> = {};
  const clusterSummaries: Record<string, string> = {};
  let summaryTokens = 0;
  let objectDocTokens = 0;
  let clusterSummaryTokens = 0;

  // Fetch source for all objects
  log(`[${packageLabel}] Fetching source code for ${objects.length} objects...`);
  const dagNodes: DagNode[] = objects.map((o) => ({
    name: o.name, type: o.type, isCustom: true, sourceAvailable: true, usedBy: [],
  }));
  const sources = await fetchSourceForNodes(client, dagNodes, errors);
  log(`[${packageLabel}] Fetched source for ${sources.size}/${objects.length} objects.`);

  // Build package-internal graph
  log(`[${packageLabel}] Building dependency graph...`);
  const graph = buildPackageGraph(objects, sources, errors);
  log(`[${packageLabel}] Internal edges: ${graph.internalEdges.length}, External deps: ${graph.externalDependencies.length}`);

  // Detect clusters via Union-Find
  log(`[${packageLabel}] Detecting functional clusters...`);
  const clusters = detectClusters(graph);
  log(`[${packageLabel}] Found ${clusters.length} cluster(s).`);

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

    // Summarize each object
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

        const batchRequests: BatchRequest[] = [];
        for (const name of nodesAtLevel) {
          const obj = objectMap.get(name);
          if (!obj) continue;
          const source = sources.get(name);
          if (!source) { errors.push(`No source for ${name}, skipping.`); continue; }
          const edges = edgesByFrom.get(name) ?? [];
          const depSums = edges.filter((e) => summaries[e.to]).map((e) => ({ name: e.to, summary: summaries[e.to] }));
          const dagNode: DagNode = {
            name, type: obj.type, isCustom: true, sourceAvailable: true,
            usedBy: cluster.internalEdges.filter((e) => e.to === name).map((e) => e.from),
          };
          batchRequests.push({ id: name, messages: buildSummaryPrompt(dagNode, source, depSums) });
        }
        if (batchRequests.length === 0) continue;
        log(`  Level ${level}: ${batchRequests.length} node(s) — submitting batch...`);
        try {
          const results = await runBatch(input.summaryLlm, batchRequests);
          for (const [name, response] of results) {
            summaries[name] = response.content;
            summaryTokens += response.usage.promptTokens + response.usage.completionTokens;
          }
        } catch (err) {
          log(`  Batch failed for level ${level}, falling back to realtime: ${String(err)}`);
          for (const req of batchRequests) {
            try {
              const response = await callLlm(input.summaryLlm, req.messages);
              summaries[req.id] = response.content;
              summaryTokens += response.usage.promptTokens + response.usage.completionTokens;
              log(`  Summarized ${req.id} (realtime fallback)`);
            } catch (retryErr) {
              summaries[req.id] = objectMap.get(req.id)?.description ?? "[Summary unavailable]";
              errors.push(`Summary for ${req.id} failed: ${String(retryErr)}`);
            }
          }
        }
      }
    } else {
      for (const name of cluster.topologicalOrder) {
        const obj = objectMap.get(name);
        if (!obj) continue;
        const source = sources.get(name);
        if (!source) { errors.push(`No source for ${name}, skipping.`); continue; }

        const edges = edgesByFrom.get(name) ?? [];
        const depSums = edges.filter((e) => summaries[e.to]).map((e) => ({ name: e.to, summary: summaries[e.to] }));
        const dagNode: DagNode = {
          name, type: obj.type, isCustom: true, sourceAvailable: true,
          usedBy: cluster.internalEdges.filter((e) => e.to === name).map((e) => e.from),
        };

        try {
          const response = await callLlm(input.summaryLlm, buildSummaryPrompt(dagNode, source, depSums));
          summaries[name] = response.content;
          summaryTokens += response.usage.promptTokens + response.usage.completionTokens;
          log(`  Summarized ${name}`);
        } catch (err) {
          summaries[name] = `[Summary unavailable: ${String(err)}]`;
          errors.push(`Failed to summarize ${name}: ${String(err)}`);
        }
      }
    }

    // Triage
    const triageSet = new Set<string>();
    if (cluster.objects.length > 1) {
      const triageInput = cluster.objects
        .filter((o) => sources.has(o.name))
        .map((o) => {
          const srcLines = (sources.get(o.name) ?? "").split("\n").length;
          const depCount = (edgesByFrom.get(o.name) ?? []).length;
          const usedByCount = cluster.internalEdges.filter((e) => e.to === o.name).length;
          return { name: o.name, type: o.type, summary: summaries[o.name] ?? o.description, sourceLines: srcLines, depCount, usedByCount };
        });
      try {
        const triageResponse = await callLlm(input.summaryLlm, buildTriagePrompt(triageInput));
        summaryTokens += triageResponse.usage.promptTokens + triageResponse.usage.completionTokens;
        for (const name of triageResponse.content.split("\n").map((l) => l.trim()).filter((l) => l.length > 0)) {
          triageSet.add(name);
        }
        log(`  Triage: ${triageSet.size}/${cluster.objects.length} objects selected for full documentation.`);
      } catch (err) {
        errors.push(`Triage failed: ${String(err)}, generating docs for all objects.`);
        for (const o of cluster.objects) triageSet.add(o.name);
      }
    } else {
      for (const o of cluster.objects) triageSet.add(o.name);
    }

    // Generate individual object docs (only for triaged objects)
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
      const depDetails = edges.filter((e) => summaries[e.to]).map((e) => ({
        name: e.to, type: objectMap.get(e.to)?.type ?? "UNKNOWN", summary: summaries[e.to],
        usedMembers: e.references.map((r) => ({ memberName: r.memberName, memberType: r.memberType })),
      }));
      const internalWhereUsed = cluster.internalEdges
        .filter((e) => e.to === obj.name)
        .map((e) => ({ name: e.from, type: objectMap.get(e.from)?.type ?? "UNKNOWN", description: "Package-internal reference" }));

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
        const response = await callLlmAgentLoop(docConfig, docMessages, AGENT_TOOLS, toolExecutor, DOC_AGENT_MAX_ITERATIONS, 0);
        objectDocs[obj.name] = response.content;
        objectDocTokens += response.usage.promptTokens + response.usage.completionTokens;
      } catch (err) {
        objectDocs[obj.name] = `Documentation generation failed: ${String(err)}`;
        errors.push(`Failed to generate doc for ${obj.name}: ${String(err)}`);
      }
    }

    // Generate cluster summary
    if (cluster.name !== "Standalone Objects" && cluster.objects.length > 1) {
      const clusterObjectSummaries = cluster.objects.map((o) => ({
        name: o.name, type: o.type, summary: summaries[o.name] ?? o.description,
      }));
      const clusterConfig: LlmConfig = { ...input.summaryLlm, maxTokens: CLUSTER_SUMMARY_MAX_TOKENS };
      try {
        const response = await callLlm(clusterConfig, buildClusterSummaryPrompt(clusterObjectSummaries, cluster.internalEdges));
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
      const obj = cluster.objects[0];
      cluster.name = obj.name;
      clusterSummaries[cluster.name] = summaries[obj.name] ?? obj.description;
    }
  }

  return { clusters, graph, summaries, objectDocs, clusterSummaries, tokenUsage: { summaryTokens, objectDocTokens, clusterSummaryTokens } };
}

/**
 * Generates wiki-style documentation for an entire ABAP package.
 * Supports recursive sub-package discovery and hierarchical documentation.
 */
export async function generatePackageDocumentation(input: PackageDocInput): Promise<PackageDocResult> {
  const errors: string[] = [];
  let overviewTokens = 0;

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

    if (!hasSubPackages) {
      // ─── FLAT FLOW (no sub-packages) — existing behavior with summaries ───
      if (rootObjects.length === 0) {
        return emptyResult(input.packageName, errors);
      }

      const result = await processPackageObjects(client, rootObjects, input.packageName, input, errors);
      const aggregatedExternalDeps = aggregateExternalDeps(result.graph);

      // Generate package overview
      log("Generating package overview...");
      const overviewMessages = buildPackageOverviewPrompt(
        input.packageName,
        result.clusters.map((c) => ({ name: c.name, summary: result.clusterSummaries[c.name] ?? "", objectCount: c.objects.length })),
        aggregatedExternalDeps,
        input.userContext,
      );
      let overviewText = "";
      try {
        const response = await callLlm({ ...input.docLlm, maxTokens: PACKAGE_OVERVIEW_MAX_TOKENS }, overviewMessages);
        overviewText = response.content;
        overviewTokens = response.usage.promptTokens + response.usage.completionTokens;
      } catch (err) {
        overviewText = `Package overview generation failed: ${String(err)}`;
        errors.push(`Failed to generate package overview: ${String(err)}`);
      }

      const documentation = assembleDocument(input.packageName, overviewText, result.clusters, result.clusterSummaries, result.objectDocs, aggregatedExternalDeps, result.summaries);
      const pages = assembleHtmlWiki(input.packageName, overviewText, result.clusters, result.clusterSummaries, result.objectDocs, aggregatedExternalDeps, result.summaries);
      const singlePageHtml = renderFullPageHtml(input.packageName, overviewText, result.clusters, result.clusterSummaries, result.objectDocs, result.summaries);

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
        rootResult = await processPackageObjects(client, rootObjects, input.packageName, input, errors);
        rootExternalDeps = aggregateExternalDeps(rootResult.graph);
      }

      // Process each sub-package
      const spRenderData: SubPackageRenderData[] = [];
      let totalSummaryTokens = rootResult?.tokenUsage.summaryTokens ?? 0;
      let totalObjectDocTokens = rootResult?.tokenUsage.objectDocTokens ?? 0;
      let totalClusterSummaryTokens = rootResult?.tokenUsage.clusterSummaryTokens ?? 0;

      for (const spNode of subPackagesWithObjects) {
        let spObjects = spNode.objects;
        if (spObjects.length > MAX_PACKAGE_OBJECTS) {
          errors.push(`Sub-package ${spNode.name} has ${spObjects.length} objects; capping to ${MAX_PACKAGE_OBJECTS}.`);
          spObjects = spObjects.slice(0, MAX_PACKAGE_OBJECTS);
        }

        log(`Processing sub-package ${spNode.name} (${spObjects.length} objects)...`);
        const spResult = await processPackageObjects(client, spObjects, spNode.name, input, errors);
        const spExternalDeps = aggregateExternalDeps(spResult.graph);

        // Generate sub-package summary
        let subPackageSummary = "";
        const spClusterSummaryInput = spResult.clusters.map((c) => ({
          name: c.name, summary: spResult.clusterSummaries[c.name] ?? "", objectCount: c.objects.length,
        }));
        try {
          const spSummaryMessages = buildSubPackageSummaryPrompt(spNode.name, spClusterSummaryInput, spExternalDeps);
          const response = await callLlm({ ...input.summaryLlm, maxTokens: CLUSTER_SUMMARY_MAX_TOKENS }, spSummaryMessages);
          subPackageSummary = response.content;
          totalSummaryTokens += response.usage.promptTokens + response.usage.completionTokens;
        } catch (err) {
          subPackageSummary = spNode.description || `Sub-package ${spNode.name}`;
          errors.push(`Failed to generate summary for sub-package ${spNode.name}: ${String(err)}`);
        }

        spRenderData.push({
          node: spNode,
          clusters: spResult.clusters,
          clusterSummaries: spResult.clusterSummaries,
          objectDocs: spResult.objectDocs,
          summaries: spResult.summaries,
          subPackageSummary,
          externalDeps: spExternalDeps,
        });

        totalSummaryTokens += spResult.tokenUsage.summaryTokens;
        totalObjectDocTokens += spResult.tokenUsage.objectDocTokens;
        totalClusterSummaryTokens += spResult.tokenUsage.clusterSummaryTokens;
      }

      // Generate top-level package overview with sub-package summaries
      log("Generating hierarchical package overview...");
      const rootClusterSummaryInput = rootResult
        ? rootResult.clusters.map((c) => ({ name: c.name, summary: rootResult!.clusterSummaries[c.name] ?? "", objectCount: c.objects.length }))
        : [];
      const subPackageSummaryInput = spRenderData.map((sp) => ({
        name: sp.node.name,
        summary: sp.subPackageSummary,
        objectCount: sp.clusters.reduce((n, c) => n + c.objects.length, 0),
      }));

      const overviewMessages = buildPackageOverviewPrompt(
        input.packageName, rootClusterSummaryInput, rootExternalDeps,
        input.userContext, subPackageSummaryInput,
      );
      let overviewText = "";
      try {
        const response = await callLlm({ ...input.docLlm, maxTokens: PACKAGE_OVERVIEW_MAX_TOKENS }, overviewMessages);
        overviewText = response.content;
        overviewTokens = response.usage.promptTokens + response.usage.completionTokens;
      } catch (err) {
        overviewText = `Package overview generation failed: ${String(err)}`;
        errors.push(`Failed to generate package overview: ${String(err)}`);
      }

      // Assemble all outputs
      const rootClusters = rootResult?.clusters ?? [];
      const rootClusterSummaries = rootResult?.clusterSummaries ?? {};
      const rootObjectDocs = rootResult?.objectDocs ?? {};
      const rootSummaries = rootResult?.summaries ?? {};

      const documentation = assembleHierarchicalDocument(
        input.packageName, overviewText, rootClusters, rootClusterSummaries,
        rootObjectDocs, rootSummaries, rootExternalDeps, spRenderData,
      );
      const pages = assembleHierarchicalHtmlWiki(
        input.packageName, overviewText, rootClusters, rootClusterSummaries,
        rootObjectDocs, rootSummaries, rootExternalDeps, spRenderData,
      );
      const singlePageHtml = renderHierarchicalFullPageHtml(
        input.packageName, overviewText, rootClusters, rootClusterSummaries,
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
  overview: string,
  clusters: Cluster[],
  clusterSummaries: Record<string, string>,
  objectDocs: Record<string, string>,
  externalDeps: Array<{ name: string; type: string; usedBy: string[] }>,
  summaries?: Record<string, string>,
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
  overview: string,
  rootClusters: Cluster[],
  rootClusterSummaries: Record<string, string>,
  rootObjectDocs: Record<string, string>,
  rootSummaries: Record<string, string>,
  rootExternalDeps: Array<{ name: string; type: string; usedBy: string[] }>,
  subPackages: SubPackageRenderData[],
): string {
  const parts: string[] = [];

  parts.push(`# Package ${packageName}`);
  parts.push("");
  parts.push(overview);

  // Sub-package sections
  for (const sp of subPackages) {
    parts.push("");
    parts.push("---");
    parts.push("");
    parts.push(`## ${sp.node.name}`);
    parts.push("");
    if (sp.subPackageSummary) {
      parts.push(sp.subPackageSummary);
    }

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

  // Root-level clusters
  if (rootClusters.length > 0 && rootClusters.some((c) => c.objects.length > 0)) {
    if (subPackages.length > 0) {
      parts.push("");
      parts.push("---");
      parts.push("");
      parts.push("## Root Package Objects");
    }

    for (const cluster of rootClusters) {
      parts.push("");
      parts.push(`### ${cluster.name}`);
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
