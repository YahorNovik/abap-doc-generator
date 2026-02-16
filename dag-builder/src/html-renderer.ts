import { marked } from "marked";
import { Cluster, DagEdge, DagNode, DagResult, SubPackageNode, PackageObject, PackageGraph } from "./types";

// ─── GitHub-flavored Markdown CSS ───

const CSS = `
* { box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  font-size: 16px; line-height: 1.6; color: #1f2328;
  max-width: 980px; margin: 0 auto; padding: 32px 24px;
}
h1, h2, h3, h4 { margin-top: 24px; margin-bottom: 16px; font-weight: 600; line-height: 1.25; }
h1 { font-size: 2em; padding-bottom: 0.3em; border-bottom: 1px solid #d1d9e0; }
h2 { font-size: 1.5em; padding-bottom: 0.3em; border-bottom: 1px solid #d1d9e0; }
h3 { font-size: 1.25em; }
h4 { font-size: 1em; }
p { margin-top: 0; margin-bottom: 16px; }
a { color: #0969da; text-decoration: none; }
a:hover { text-decoration: underline; }
ul, ol { margin-top: 0; margin-bottom: 16px; padding-left: 2em; }
li + li { margin-top: 4px; }
code {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 85%; background: rgba(175,184,193,0.2); border-radius: 6px; padding: 0.2em 0.4em;
}
pre {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 85%; line-height: 1.45; background: #f6f8fa; border-radius: 6px;
  padding: 16px; overflow: auto; margin-bottom: 16px;
}
pre code { background: none; padding: 0; font-size: 100%; }
hr { height: 0.25em; padding: 0; margin: 24px 0; background-color: #d1d9e0; border: 0; }
table { border-collapse: collapse; margin-bottom: 16px; width: 100%; overflow: auto; }
table th, table td { padding: 6px 13px; border: 1px solid #d1d9e0; }
table th { font-weight: 600; background: #f6f8fa; }
table tr:nth-child(2n) { background: #f6f8fa; }
strong { font-weight: 600; }
blockquote { margin: 0 0 16px; padding: 0 1em; color: #656d76; border-left: 0.25em solid #d1d9e0; }
nav.breadcrumb { font-size: 14px; color: #656d76; margin-bottom: 16px; }
nav.breadcrumb a { color: #0969da; }
nav.breadcrumb .sep { margin: 0 4px; }
.toc { margin: 16px 0; }
.toc ul { list-style: none; padding-left: 0; }
.toc li { padding: 4px 0; }
.toc .obj-type { color: #656d76; font-size: 85%; margin-left: 4px; }
.toc .obj-desc { color: #656d76; font-size: 85%; }
.obj-card { background: #f6f8fa; border: 1px solid #d1d9e0; border-radius: 6px; padding: 12px 16px; margin: 8px 0; }
.obj-card .obj-header { margin: 0 0 4px; font-size: 1em; font-weight: 600; }
.obj-card .obj-header a { color: #0969da; }
.obj-card .obj-header .obj-type { color: #656d76; font-size: 85%; font-weight: 400; margin-left: 4px; }
.obj-card .obj-summary { margin: 4px 0 0; font-size: 0.9em; color: #1f2328; }
.cluster-section { margin-top: 32px; }
.back-link { margin-top: 32px; padding-top: 16px; border-top: 1px solid #d1d9e0; }
.diagram-container { margin: 16px 0 24px; }
.diagram-container summary { cursor: pointer; font-weight: 600; color: #0969da; }
.diagram-container .mermaid { margin-top: 12px; }
.summary-card { background: #f6f8fa; border: 1px solid #d1d9e0; border-radius: 6px; padding: 12px 16px; margin: 8px 0; }
.summary-card h4 { margin: 0 0 4px; font-size: 1em; }
.summary-card .obj-type { color: #656d76; font-size: 85%; }
.summary-card p { margin: 4px 0 0; font-size: 0.9em; }
.summary-only-section { margin-top: 16px; }
.summary-only-section h4 { color: #656d76; font-size: 0.9em; font-weight: 600; margin-bottom: 8px; }
.sub-package-section { margin-top: 40px; padding-top: 16px; border-top: 2px solid #d1d9e0; }
`;

// ─── Markdown → HTML ───

export function markdownToHtml(markdown: string): string {
  return marked.parse(markdown, { gfm: true, async: false }) as string;
}

// ─── HTML page wrapper ───

export function wrapHtmlPage(title: string, bodyHtml: string, breadcrumbHtml?: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body>
${breadcrumbHtml ? breadcrumbHtml + "\n" : ""}${bodyHtml}
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<script>mermaid.initialize({ startOnLoad: true, theme: 'neutral', securityLevel: 'loose' });</script>
</body>
</html>`;
}

// ─── Cross-linking ───

export function linkifyObjectNames(
  html: string,
  knownObjects: Set<string>,
  currentObject?: string,
): string {
  const names = Array.from(knownObjects).filter((n) => n !== currentObject);
  if (names.length === 0) return html;

  // Sort by length descending so longer names match first
  names.sort((a, b) => b.length - a.length);
  const pattern = new RegExp(`\\b(${names.map(escapeRegex).join("|")})\\b`, "g");

  // State machine: track nesting of tags where we should NOT linkify
  const skipTags = new Set(["a", "code", "pre"]);
  const parts: string[] = [];
  let skipDepth = 0;
  let pos = 0;

  // Split into tags and text segments
  const tagRegex = /<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*>/g;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(html)) !== null) {
    // Process text before this tag
    if (match.index > pos) {
      const text = html.slice(pos, match.index);
      parts.push(skipDepth > 0 ? text : text.replace(pattern, '<a href="$1.html">$1</a>'));
    }

    const fullTag = match[0];
    const tagName = match[1].toLowerCase();

    if (skipTags.has(tagName)) {
      if (fullTag.startsWith("</")) {
        skipDepth = Math.max(0, skipDepth - 1);
      } else if (!fullTag.endsWith("/>")) {
        skipDepth++;
      }
    }

    parts.push(fullTag);
    pos = match.index + fullTag.length;
  }

  // Process remaining text after last tag
  if (pos < html.length) {
    const text = html.slice(pos);
    parts.push(skipDepth > 0 ? text : text.replace(pattern, '<a href="$1.html">$1</a>'));
  }

  return parts.join("");
}

// ─── Dependency diagram ───

function mermaidId(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

function mermaidNodeDef(name: string, type: string): string {
  const id = mermaidId(name);
  const label = escapeHtml(name);
  switch (type.toUpperCase()) {
    case "INTF": return `  ${id}{{"${label}"}}`;
    case "DDLS":
    case "DDLX":
    case "DCLS": return `  ${id}[("${label}")]`;
    case "PROG":
    case "FUGR": return `  ${id}(["${label}"])`;
    default:     return `  ${id}["${label}"]`;
  }
}

/**
 * Builds a Mermaid graph TD diagram from objects and edges.
 * Returns empty string if fewer than 2 connected nodes.
 * If linkedObjects set is provided, adds click directives for objects in that set.
 */
function buildMermaidDiagram(
  objects: Array<{ name: string; type: string }>,
  edges: DagEdge[],
  highlightNode?: string,
  linkedObjects?: Set<string>,
): string {
  if (objects.length < 2 && edges.length === 0) return "";

  // If >20 objects, only show nodes that have edges
  const connectedNames = new Set<string>();
  for (const e of edges) {
    connectedNames.add(e.from);
    connectedNames.add(e.to);
  }
  const visibleObjects = objects.length > 20
    ? objects.filter((o) => connectedNames.has(o.name))
    : objects;

  if (visibleObjects.length < 2) return "";

  const objectMap = new Map(objects.map((o) => [o.name, o]));
  const lines: string[] = ["graph TD"];

  // Node definitions
  for (const obj of visibleObjects) {
    lines.push(mermaidNodeDef(obj.name, obj.type));
  }

  // Edge definitions with member labels
  for (const edge of edges) {
    if (!objectMap.has(edge.from) || !objectMap.has(edge.to)) continue;
    const fromId = mermaidId(edge.from);
    const toId = mermaidId(edge.to);
    const refs = edge.references.slice(0, 3).map((r) => r.memberName);
    if (edge.references.length > 3) refs.push("...");
    const label = refs.length > 0 ? `|"${refs.join(", ")}"|` : "";
    lines.push(`  ${fromId} -->${label} ${toId}`);
  }

  // Highlight node
  if (highlightNode && objectMap.has(highlightNode)) {
    lines.push(`  style ${mermaidId(highlightNode)} fill:#4a90d9,color:#fff,stroke:#2a6ab0`);
  }

  // Clickable links for navigation (only for objects that have pages)
  if (linkedObjects) {
    for (const obj of visibleObjects) {
      if (linkedObjects.has(obj.name)) {
        lines.push(`  click ${mermaidId(obj.name)} "${obj.name}.html"`);
      }
    }
  }

  return lines.join("\n");
}

function wrapDiagramHtml(mermaidCode: string, open = true): string {
  return `<div class="diagram-container">\n`
    + `<details${open ? " open" : ""}>\n`
    + `<summary>Dependency Graph</summary>\n`
    + `<div class="mermaid">\n${mermaidCode}\n</div>\n`
    + `</details>\n</div>`;
}

// ─── Overview extraction ───

/**
 * Extracts the Overview section text from full object documentation markdown.
 * Returns the paragraph(s) under the "## Overview" heading, or undefined if not found.
 */
function extractOverview(markdown: string): string | undefined {
  // Match "## Overview" (or "# Overview" after heading shift)
  const overviewMatch = markdown.match(/^##?\s+Overview\s*\n([\s\S]*?)(?=\n##?\s|\n---|\n\*\*\w|$)/m);
  if (!overviewMatch) return undefined;
  const text = overviewMatch[1].trim();
  return text.length > 0 ? text : undefined;
}

// ─── Summary card ───

function renderSummaryCard(obj: PackageObject, summary: string): string {
  return `<div class="summary-card">`
    + `<h4>${escapeHtml(obj.name)} <span class="obj-type">(${escapeHtml(obj.type)})</span></h4>`
    + `<p>${escapeHtml(summary)}</p>`
    + `</div>`;
}

function renderSummaryOnlySection(
  objects: PackageObject[],
  objectDocs: Record<string, string>,
  summaries: Record<string, string>,
): string {
  const summaryOnly = objects.filter((o) => !objectDocs[o.name] && summaries[o.name]);
  if (summaryOnly.length === 0) return "";
  const parts = [`<div class="summary-only-section">`, `<h4>Other Objects (Summary Only)</h4>`];
  for (const obj of summaryOnly) {
    parts.push(renderSummaryCard(obj, summaries[obj.name]));
  }
  parts.push(`</div>`);
  return parts.join("\n");
}

// ─── Page builders ───

export function buildIndexPage(
  packageName: string,
  clusters: Cluster[],
  clusterSummaries: Record<string, string>,
  externalDeps: Array<{ name: string; type: string; usedBy: string[] }>,
  objectDocs?: Record<string, string>,
  summaries?: Record<string, string>,
  objectLinkPrefix?: string,
  parentPackageName?: string,
): string {
  const objectsWithPages = new Set<string>();
  for (const c of clusters) {
    for (const o of c.objects) {
      if (objectDocs?.[o.name] || summaries?.[o.name]) objectsWithPages.add(o.name);
    }
  }
  const linkPrefix = objectLinkPrefix ?? "";

  const parts: string[] = [];
  if (parentPackageName) {
    parts.push(`<nav class="breadcrumb"><a href="../index.html">${escapeHtml(parentPackageName)}</a><span class="sep">/</span>${escapeHtml(packageName)}</nav>`);
  }
  parts.push(`<h1>Package ${escapeHtml(packageName)}</h1>`);

  // Table of Contents by cluster
  for (const cluster of clusters) {
    const clusterId = slugify(cluster.name);
    parts.push(`<div class="cluster-section">`);
    parts.push(`<h2 id="${clusterId}">${escapeHtml(cluster.name)}</h2>`);

    const summary = clusterSummaries[cluster.name];
    if (summary) {
      parts.push(markdownToHtml(summary));
    }

    // Cluster dependency diagram — only link objects that have pages
    const clusterDiagram = buildMermaidDiagram(
      cluster.objects, cluster.internalEdges, undefined, objectsWithPages,
    );
    if (clusterDiagram) {
      parts.push(wrapDiagramHtml(clusterDiagram));
    }

    // Object cards sorted by topological order (entry points first, foundational objects last)
    const topoIndex = new Map(cluster.topologicalOrder.map((name, i) => [name, i]));
    const linkedObjects = cluster.objects
      .filter((o) => objectDocs?.[o.name] || summaries?.[o.name] || o.description)
      .sort((a, b) => (topoIndex.get(b.name) ?? 0) - (topoIndex.get(a.name) ?? 0));
    for (const obj of linkedObjects) {
      // For objects with full docs, prefer the Overview section (more readable)
      // over the raw technical summary
      const overview = objectDocs?.[obj.name] ? extractOverview(objectDocs[obj.name]) : undefined;
      const summary = overview || summaries?.[obj.name] || obj.description || "";
      const nameHtml = objectsWithPages.has(obj.name)
        ? `<a href="${linkPrefix}${obj.name}.html">${escapeHtml(obj.name)}</a>`
        : `<strong>${escapeHtml(obj.name)}</strong>`;
      parts.push(`<div class="obj-card">`);
      parts.push(
        `<div class="obj-header">${nameHtml}`
        + `<span class="obj-type">(${escapeHtml(obj.type)})</span></div>`,
      );
      if (summary) {
        if (overview) {
          // Overview is markdown — render as HTML for inline formatting
          parts.push(`<div class="obj-summary">${markdownToHtml(summary)}</div>`);
        } else {
          parts.push(`<p class="obj-summary">${escapeHtml(summary)}</p>`);
        }
      }
      parts.push(`</div>`);
    }

    parts.push(`</div>`);
  }

  // External dependencies (collapsed)
  parts.push(renderExternalDepsHtml(externalDeps, objectsWithPages, linkPrefix));

  return wrapHtmlPage(`Package ${packageName}`, parts.join("\n"));
}

export function buildObjectPage(
  objectName: string,
  objectType: string,
  objectDocHtml: string,
  packageName: string,
  clusterName: string,
  objectEdges?: DagEdge[],
  clusterObjects?: Array<{ name: string; type: string }>,
  subPackageName?: string,
  objectsWithPages?: Set<string>,
): string {
  const clusterId = slugify(clusterName);
  const indexHref = subPackageName ? "index.html" : "index.html";
  const rootHref = subPackageName ? "../index.html" : "index.html";

  let breadcrumb = `<nav class="breadcrumb">`;
  breadcrumb += `<a href="${rootHref}">${escapeHtml(packageName)}</a>`;
  if (subPackageName) {
    breadcrumb += `<span class="sep">/</span>`;
    breadcrumb += `<a href="${indexHref}">${escapeHtml(subPackageName)}</a>`;
  }
  breadcrumb += `<span class="sep">/</span>`;
  breadcrumb += `<a href="${indexHref}#${clusterId}">${escapeHtml(clusterName)}</a>`;
  breadcrumb += `<span class="sep">/</span>`;
  breadcrumb += `<strong>${escapeHtml(objectName)}</strong>`;
  breadcrumb += `</nav>`;

  let diagramHtml = "";
  if (objectEdges && objectEdges.length > 0 && clusterObjects) {
    // Show only nodes connected to this object
    const connectedNames = new Set<string>([objectName]);
    for (const e of objectEdges) {
      connectedNames.add(e.from);
      connectedNames.add(e.to);
    }
    const visibleObjects = clusterObjects.filter((o) => connectedNames.has(o.name));
    const diagram = buildMermaidDiagram(visibleObjects, objectEdges, objectName, objectsWithPages);
    if (diagram) {
      diagramHtml = "\n" + wrapDiagramHtml(diagram);
    }
  }

  const backHref = subPackageName ? "index.html" : "index.html";
  const backLabel = subPackageName ?? packageName;
  const body = objectDocHtml
    + diagramHtml
    + `\n<div class="back-link"><a href="${backHref}">&larr; Back to ${escapeHtml(backLabel)}</a></div>`;

  return wrapHtmlPage(`${objectName} — ${packageName}`, body, breadcrumb);
}

// ─── Multi-page wiki assembly ───

export function assembleHtmlWiki(
  packageName: string,
  clusters: Cluster[],
  clusterSummaries: Record<string, string>,
  objectDocs: Record<string, string>,
  externalDeps: Array<{ name: string; type: string; usedBy: string[] }>,
  summaries?: Record<string, string>,
): Record<string, string> {
  const pages: Record<string, string> = {};

  // Collect objects that will have pages (for cross-linking and diagram click links)
  const objectsWithPages = new Set<string>();
  for (const cluster of clusters) {
    for (const obj of cluster.objects) {
      if (objectDocs[obj.name] || summaries?.[obj.name]) objectsWithPages.add(obj.name);
    }
  }

  // Build object pages (full docs or summary-only)
  for (const cluster of clusters) {
    for (const obj of cluster.objects) {
      const md = objectDocs[obj.name]
        ?? (summaries?.[obj.name] ? `# ${obj.name}\n\n${summaries[obj.name]}` : undefined);
      if (!md) continue;
      let html = markdownToHtml(md);
      html = linkifyObjectNames(html, objectsWithPages, obj.name);
      const objectEdges = cluster.internalEdges.filter(
        (e) => e.from === obj.name || e.to === obj.name,
      );
      pages[`${obj.name}.html`] = buildObjectPage(
        obj.name, obj.type, html, packageName, cluster.name,
        objectEdges, cluster.objects, undefined, objectsWithPages,
      );
    }
  }

  // Build index page
  pages["index.html"] = buildIndexPage(
    packageName, clusters, clusterSummaries, externalDeps,
    objectDocs, summaries,
  );

  return pages;
}

// ─── Single-object standalone HTML ───

export function renderSingleObjectHtml(
  objectName: string,
  markdown: string,
  dagEdges?: DagEdge[],
  dagNodes?: DagNode[],
): string {
  let html = markdownToHtml(markdown);

  if (dagEdges && dagNodes && dagEdges.length > 0) {
    const objects = dagNodes.map((n) => ({ name: n.name, type: n.type }));
    const diagram = buildMermaidDiagram(objects, dagEdges, objectName);
    if (diagram) {
      html += "\n" + wrapDiagramHtml(diagram);
    }
  }

  return wrapHtmlPage(objectName, html);
}

// ─── Full single-page HTML for packages ───

/**
 * Renders all package documentation into a single self-contained HTML page.
 * Uses anchor links instead of file links. Includes per-cluster Mermaid diagrams.
 */
export function renderFullPageHtml(
  packageName: string,
  clusters: Cluster[],
  clusterSummaries: Record<string, string>,
  objectDocs: Record<string, string>,
  summaries?: Record<string, string>,
): string {
  // Collect all known object names for anchor-based cross-linking
  const knownObjects = new Set<string>();
  for (const c of clusters) {
    for (const o of c.objects) knownObjects.add(o.name);
  }

  const parts: string[] = [];
  parts.push(`<h1>Package ${escapeHtml(packageName)}</h1>`);

  for (const cluster of clusters) {
    const clusterId = slugify(cluster.name);
    parts.push(`<hr>`);
    parts.push(`<h2 id="${clusterId}">${escapeHtml(cluster.name)}</h2>`);

    const summary = clusterSummaries[cluster.name];
    if (summary) {
      parts.push(markdownToHtml(summary));
    }

    // Cluster dependency diagram
    const clusterDiagram = buildMermaidDiagram(
      cluster.objects, cluster.internalEdges,
    );
    if (clusterDiagram) {
      parts.push(wrapDiagramHtml(clusterDiagram));
    }

    // Each object's documentation with shifted headings
    for (const obj of cluster.objects) {
      const md = objectDocs[obj.name];
      if (!md) continue;
      // Shift headings: # → ###, ## → ####
      const shifted = md.replace(/^# /gm, "### ").replace(/^## /gm, "#### ");
      let objHtml = markdownToHtml(shifted);
      // Add anchor target
      objHtml = `<div id="${escapeHtml(obj.name)}">\n${objHtml}\n</div>`;
      // Cross-link: replace file links with anchor links
      objHtml = linkifyAnchors(objHtml, knownObjects, obj.name);
      parts.push(objHtml);
    }

    // Summary cards for triaged-out objects
    if (summaries) {
      const summaryOnly = cluster.objects.filter((o) => !objectDocs[o.name] && summaries[o.name]);
      for (const obj of summaryOnly) {
        parts.push(`<div id="${escapeHtml(obj.name)}">`);
        parts.push(renderSummaryCard(obj, summaries[obj.name]));
        parts.push(`</div>`);
      }
    }
  }

  return wrapHtmlPage(`Package ${packageName}`, parts.join("\n"));
}

/** Like linkifyObjectNames but uses #anchor links instead of file links. */
function linkifyAnchors(
  html: string,
  knownObjects: Set<string>,
  currentObject?: string,
): string {
  const names = Array.from(knownObjects).filter((n) => n !== currentObject);
  if (names.length === 0) return html;

  names.sort((a, b) => b.length - a.length);
  const pattern = new RegExp(`\\b(${names.map(escapeRegex).join("|")})\\b`, "g");

  const skipTags = new Set(["a", "code", "pre"]);
  const parts: string[] = [];
  let skipDepth = 0;
  let pos = 0;

  const tagRegex = /<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*>/g;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(html)) !== null) {
    if (match.index > pos) {
      const text = html.slice(pos, match.index);
      parts.push(skipDepth > 0 ? text : text.replace(pattern, '<a href="#$1">$1</a>'));
    }
    const fullTag = match[0];
    const tagName = match[1].toLowerCase();
    if (skipTags.has(tagName)) {
      if (fullTag.startsWith("</")) {
        skipDepth = Math.max(0, skipDepth - 1);
      } else if (!fullTag.endsWith("/>")) {
        skipDepth++;
      }
    }
    parts.push(fullTag);
    pos = match.index + fullTag.length;
  }

  if (pos < html.length) {
    const text = html.slice(pos);
    parts.push(skipDepth > 0 ? text : text.replace(pattern, '<a href="#$1">$1</a>'));
  }

  return parts.join("");
}

// ─── Hierarchical (sub-package) rendering ───

/** Data for one processed sub-package, passed to hierarchical renderers. */
export interface SubPackageRenderData {
  node: SubPackageNode;
  clusters: Cluster[];
  clusterSummaries: Record<string, string>;
  objectDocs: Record<string, string>;
  summaries: Record<string, string>;
  subPackageSummary: string;
  externalDeps: Array<{ name: string; type: string; usedBy: string[] }>;
}

/**
 * Assembles a multi-page HTML wiki with subdirectories for sub-packages.
 * File structure:
 *   index.html                    — root overview + sub-package nav
 *   SUBPKG/index.html             — sub-package overview
 *   SUBPKG/OBJECT.html            — object page
 *   OBJECT.html                   — root-level object (no subdirectory)
 */
export function assembleHierarchicalHtmlWiki(
  packageName: string,
  rootClusters: Cluster[],
  rootClusterSummaries: Record<string, string>,
  rootObjectDocs: Record<string, string>,
  rootSummaries: Record<string, string>,
  rootExternalDeps: Array<{ name: string; type: string; usedBy: string[] }>,
  subPackages: SubPackageRenderData[],
): Record<string, string> {
  const pages: Record<string, string> = {};

  // Collect objects that will have pages (for cross-linking and diagram click links)
  const rootObjectsWithPages = new Set<string>();
  for (const cluster of rootClusters) {
    for (const obj of cluster.objects) {
      if (rootObjectDocs[obj.name] || rootSummaries[obj.name]) rootObjectsWithPages.add(obj.name);
    }
  }

  // Build root-level object pages (full docs or summary-only)
  for (const cluster of rootClusters) {
    for (const obj of cluster.objects) {
      const md = rootObjectDocs[obj.name]
        ?? (rootSummaries[obj.name] ? `# ${obj.name}\n\n${rootSummaries[obj.name]}` : undefined);
      if (!md) continue;
      let html = markdownToHtml(md);
      html = linkifyObjectNames(html, rootObjectsWithPages, obj.name);
      const objectEdges = cluster.internalEdges.filter(
        (e) => e.from === obj.name || e.to === obj.name,
      );
      pages[`${obj.name}.html`] = buildObjectPage(
        obj.name, obj.type, html, packageName, cluster.name,
        objectEdges, cluster.objects, undefined, rootObjectsWithPages,
      );
    }
  }

  // Build sub-package pages
  for (const sp of subPackages) {
    const spName = sp.node.name;
    const spDir = `${spName}/`;

    // Collect sub-package objects with pages
    const spObjectsWithPages = new Set<string>();
    for (const cluster of sp.clusters) {
      for (const obj of cluster.objects) {
        if (sp.objectDocs[obj.name] || sp.summaries[obj.name]) spObjectsWithPages.add(obj.name);
      }
    }

    // Object pages within sub-package directory (full docs or summary-only)
    for (const cluster of sp.clusters) {
      for (const obj of cluster.objects) {
        const md = sp.objectDocs[obj.name]
          ?? (sp.summaries[obj.name] ? `# ${obj.name}\n\n${sp.summaries[obj.name]}` : undefined);
        if (!md) continue;
        let html = markdownToHtml(md);
        html = linkifyObjectNames(html, spObjectsWithPages, obj.name);
        const objectEdges = cluster.internalEdges.filter(
          (e) => e.from === obj.name || e.to === obj.name,
        );
        pages[`${spDir}${obj.name}.html`] = buildObjectPage(
          obj.name, obj.type, html, packageName, cluster.name,
          objectEdges, cluster.objects, spName, spObjectsWithPages,
        );
      }
    }

    // Sub-package index page (with back link to root)
    pages[`${spDir}index.html`] = buildIndexPage(
      spName, sp.clusters, sp.clusterSummaries,
      sp.externalDeps, sp.objectDocs, sp.summaries,
      undefined, packageName,
    );
  }

  // Root index page
  const rootParts: string[] = [];
  rootParts.push(`<h1>Package ${escapeHtml(packageName)}</h1>`);

  // Root-level clusters first (objects directly in root package)
  if (rootClusters.length > 0 && rootClusters.some((c) => c.objects.length > 0)) {
    for (const cluster of rootClusters) {
      const clusterId = slugify(cluster.name);
      rootParts.push(`<div class="cluster-section">`);
      rootParts.push(`<h2 id="${clusterId}">${escapeHtml(cluster.name)}</h2>`);
      const summary = rootClusterSummaries[cluster.name];
      if (summary) rootParts.push(markdownToHtml(summary));

      const clusterDiagram = buildMermaidDiagram(
        cluster.objects, cluster.internalEdges, undefined, rootObjectsWithPages,
      );
      if (clusterDiagram) rootParts.push(wrapDiagramHtml(clusterDiagram));

      const topoIndex = new Map(cluster.topologicalOrder.map((name, i) => [name, i]));
      const linkedObjects = cluster.objects
        .filter((o) => rootObjectDocs[o.name] || rootSummaries[o.name] || o.description)
        .sort((a, b) => (topoIndex.get(b.name) ?? 0) - (topoIndex.get(a.name) ?? 0));
      for (const obj of linkedObjects) {
        const summary = rootSummaries[obj.name] || obj.description || "";
        const nameHtml = rootObjectsWithPages.has(obj.name)
          ? `<a href="${obj.name}.html">${escapeHtml(obj.name)}</a>`
          : `<strong>${escapeHtml(obj.name)}</strong>`;
        rootParts.push(`<div class="obj-card">`);
        rootParts.push(
          `<div class="obj-header">${nameHtml}`
          + `<span class="obj-type">(${escapeHtml(obj.type)})</span></div>`,
        );
        if (summary) {
          rootParts.push(`<p class="obj-summary">${escapeHtml(summary)}</p>`);
        }
        rootParts.push(`</div>`);
      }
      rootParts.push(`</div>`);
    }
  }

  // Sub-packages after root objects
  if (subPackages.length > 0) {
    rootParts.push(`<h2>Sub-Packages</h2>`);
    rootParts.push(`<div class="toc"><ul>`);
    for (const sp of subPackages) {
      const objCount = sp.clusters.reduce((n, c) => n + c.objects.length, 0);
      rootParts.push(
        `<li><a href="${sp.node.name}/index.html"><strong>${escapeHtml(sp.node.name)}</strong></a>`
        + ` (${objCount} objects)`
        + (sp.node.description ? ` <span class="obj-desc">— ${escapeHtml(sp.node.description)}</span>` : "")
        + `</li>`,
      );
    }
    rootParts.push(`</ul></div>`);
  }

  // External deps (collapsed)
  rootParts.push(renderExternalDepsHtml(rootExternalDeps, rootObjectsWithPages));

  pages["index.html"] = wrapHtmlPage(`Package ${packageName}`, rootParts.join("\n"));
  return pages;
}

/**
 * Renders hierarchical package docs into a single self-contained HTML page.
 */
export function renderHierarchicalFullPageHtml(
  packageName: string,
  rootClusters: Cluster[],
  rootClusterSummaries: Record<string, string>,
  rootObjectDocs: Record<string, string>,
  rootSummaries: Record<string, string>,
  subPackages: SubPackageRenderData[],
): string {
  const knownObjects = new Set<string>();
  for (const c of rootClusters) {
    for (const o of c.objects) knownObjects.add(o.name);
  }
  for (const sp of subPackages) {
    for (const c of sp.clusters) {
      for (const o of c.objects) knownObjects.add(o.name);
    }
  }

  const parts: string[] = [];
  parts.push(`<h1>Package ${escapeHtml(packageName)}</h1>`);

  // Root-level clusters first
  if (rootClusters.length > 0 && rootClusters.some((c) => c.objects.length > 0)) {
    for (const cluster of rootClusters) {
      const clusterId = slugify(cluster.name);
      parts.push(`<h2 id="${clusterId}">${escapeHtml(cluster.name)}</h2>`);
      const summary = rootClusterSummaries[cluster.name];
      if (summary) parts.push(markdownToHtml(summary));

      const clusterDiagram = buildMermaidDiagram(cluster.objects, cluster.internalEdges);
      if (clusterDiagram) parts.push(wrapDiagramHtml(clusterDiagram));

      for (const obj of cluster.objects) {
        const md = rootObjectDocs[obj.name];
        if (md) {
          const shifted = md.replace(/^# /gm, "#### ").replace(/^## /gm, "##### ");
          let objHtml = markdownToHtml(shifted);
          objHtml = `<div id="${escapeHtml(obj.name)}">\n${objHtml}\n</div>`;
          objHtml = linkifyAnchors(objHtml, knownObjects, obj.name);
          parts.push(objHtml);
        } else if (rootSummaries[obj.name]) {
          parts.push(`<div id="${escapeHtml(obj.name)}">`);
          parts.push(renderSummaryCard(obj, rootSummaries[obj.name]));
          parts.push(`</div>`);
        }
      }
    }
  }

  // Sub-package sections after root
  for (const sp of subPackages) {
    const spId = slugify(sp.node.name);
    parts.push(`<hr>`);
    parts.push(`<div class="sub-package-section">`);
    parts.push(`<h2 id="${spId}">${escapeHtml(sp.node.name)}</h2>`);

    for (const cluster of sp.clusters) {
      const clusterId = slugify(sp.node.name + "-" + cluster.name);
      parts.push(`<h3 id="${clusterId}">${escapeHtml(cluster.name)}</h3>`);
      const summary = sp.clusterSummaries[cluster.name];
      if (summary) parts.push(markdownToHtml(summary));

      const clusterDiagram = buildMermaidDiagram(cluster.objects, cluster.internalEdges);
      if (clusterDiagram) parts.push(wrapDiagramHtml(clusterDiagram));

      for (const obj of cluster.objects) {
        const md = sp.objectDocs[obj.name];
        if (md) {
          const shifted = md.replace(/^# /gm, "#### ").replace(/^## /gm, "##### ");
          let objHtml = markdownToHtml(shifted);
          objHtml = `<div id="${escapeHtml(obj.name)}">\n${objHtml}\n</div>`;
          objHtml = linkifyAnchors(objHtml, knownObjects, obj.name);
          parts.push(objHtml);
        } else if (sp.summaries[obj.name]) {
          parts.push(`<div id="${escapeHtml(obj.name)}">`);
          parts.push(renderSummaryCard(obj, sp.summaries[obj.name]));
          parts.push(`</div>`);
        }
      }
    }
    parts.push(`</div>`);
  }

  return wrapHtmlPage(`Package ${packageName}`, parts.join("\n"));
}

// ─── Helpers ───

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** Renders external deps with first 3 visible and the rest collapsed. */
function renderExternalDepsHtml(
  deps: Array<{ name: string; type: string; usedBy: string[] }>,
  knownObjects?: Set<string>,
  linkPrefix?: string,
): string {
  if (deps.length === 0) return "";
  const prefix = linkPrefix ?? "";
  const VISIBLE_COUNT = 3;

  function renderDepItem(dep: { name: string; type: string; usedBy: string[] }): string {
    const usedByLinks = dep.usedBy
      .map((u) =>
        knownObjects?.has(u) ? `<a href="${prefix}${u}.html">${escapeHtml(u)}</a>` : escapeHtml(u),
      )
      .join(", ");
    return `<li><strong>${escapeHtml(dep.name)}</strong> (${escapeHtml(dep.type)}) — used by: ${usedByLinks}</li>`;
  }

  const parts: string[] = [];
  parts.push(`<hr>`);
  parts.push(`<h2>External Dependencies</h2>`);
  parts.push(`<ul>`);
  for (const dep of deps.slice(0, VISIBLE_COUNT)) {
    parts.push(renderDepItem(dep));
  }
  parts.push(`</ul>`);

  if (deps.length > VISIBLE_COUNT) {
    parts.push(`<details>`);
    parts.push(`<summary>Show all ${deps.length} external dependencies...</summary>`);
    parts.push(`<ul>`);
    for (const dep of deps.slice(VISIBLE_COUNT)) {
      parts.push(renderDepItem(dep));
    }
    parts.push(`</ul>`);
    parts.push(`</details>`);
  }

  return parts.join("\n");
}

// ─── Standalone diagram pages ───

/**
 * Renders a standalone HTML page showing the dependency diagram for a single object.
 */
export function renderObjectDiagramHtml(objectName: string, dagResult: DagResult): string {
  const { nodes, edges, root } = dagResult;
  const objects = nodes.map((n) => ({ name: n.name, type: n.type }));
  const diagram = buildMermaidDiagram(objects, edges, root);

  // Build edge lookup for stats
  const depsOf = new Map<string, number>();
  const usedByOf = new Map<string, number>();
  for (const e of edges) {
    depsOf.set(e.from, (depsOf.get(e.from) ?? 0) + 1);
    usedByOf.set(e.to, (usedByOf.get(e.to) ?? 0) + 1);
  }

  const parts: string[] = [];
  parts.push(`<h1>Dependency Diagram: ${escapeHtml(objectName)}</h1>`);
  parts.push(`<p>${nodes.length} objects, ${edges.length} dependency edges. Root: <code>${escapeHtml(root)}</code></p>`);

  if (diagram) {
    parts.push(`<div class="mermaid">\n${diagram}\n</div>`);
  } else {
    parts.push(`<p><em>No dependencies found — this object has no connections to visualize.</em></p>`);
  }

  // Objects table
  parts.push(`<h2>Objects</h2>`);
  parts.push(`<table>`);
  parts.push(`<tr><th>Name</th><th>Type</th><th>Custom</th><th>Dependencies</th><th>Used By</th></tr>`);
  for (const node of nodes) {
    const deps = depsOf.get(node.name) ?? 0;
    const usedBy = usedByOf.get(node.name) ?? 0;
    const isRoot = node.name === root;
    const nameHtml = isRoot ? `<strong>${escapeHtml(node.name)}</strong>` : escapeHtml(node.name);
    parts.push(`<tr><td>${nameHtml}</td><td>${escapeHtml(node.type)}</td>`
      + `<td>${node.isCustom ? "Yes" : "No"}</td>`
      + `<td>${deps}</td><td>${usedBy}</td></tr>`);
  }
  parts.push(`</table>`);

  // Edge details
  if (edges.length > 0) {
    parts.push(`<h2>Dependency Details</h2>`);
    parts.push(`<table>`);
    parts.push(`<tr><th>From</th><th>To</th><th>Members Used</th></tr>`);
    for (const edge of edges) {
      const members = edge.references.map((r) => r.memberName).join(", ") || "\u2014";
      parts.push(`<tr><td><code>${escapeHtml(edge.from)}</code></td>`
        + `<td><code>${escapeHtml(edge.to)}</code></td>`
        + `<td>${escapeHtml(members)}</td></tr>`);
    }
    parts.push(`</table>`);
  }

  return wrapHtmlPage("Dependency Diagram: " + objectName, parts.join("\n"));
}

/**
 * Renders a standalone HTML page showing the package architecture diagram.
 */
export function renderPackageDiagramHtml(
  packageName: string,
  graph: PackageGraph,
  clusters: Cluster[],
): string {
  const parts: string[] = [];
  parts.push(`<h1>Package Diagram: ${escapeHtml(packageName)}</h1>`);
  parts.push(`<p>${graph.objects.length} objects, ${graph.internalEdges.length} internal edges, `
    + `${graph.externalDependencies.length} external dependencies, ${clusters.length} cluster(s)</p>`);

  // Full package diagram
  if (graph.internalEdges.length > 0) {
    const allObjects = graph.objects.map((o) => ({ name: o.name, type: o.type }));
    const fullDiagram = buildMermaidDiagram(allObjects, graph.internalEdges);
    if (fullDiagram) {
      parts.push(`<h2>Full Package Graph</h2>`);
      parts.push(`<div class="mermaid">\n${fullDiagram}\n</div>`);
    }
  }

  // Per-cluster diagrams
  if (clusters.length > 0) {
    parts.push(`<h2>Clusters</h2>`);
    for (const cluster of clusters) {
      parts.push(`<h3>${escapeHtml(cluster.name)} (${cluster.objects.length} objects)</h3>`);
      const clusterObjs = cluster.objects.map((o) => ({ name: o.name, type: o.type }));
      const clusterDiagram = buildMermaidDiagram(clusterObjs, cluster.internalEdges);
      if (clusterDiagram) {
        parts.push(`<div class="mermaid">\n${clusterDiagram}\n</div>`);
      }
      parts.push(`<ul>`);
      for (const obj of cluster.objects) {
        parts.push(`<li><code>${escapeHtml(obj.name)}</code> (${escapeHtml(obj.type)})</li>`);
      }
      parts.push(`</ul>`);
    }
  }

  // External dependencies
  if (graph.externalDependencies.length > 0) {
    parts.push(`<h2>External Dependencies</h2>`);
    parts.push(`<table>`);
    parts.push(`<tr><th>Used By</th><th>Depends On</th><th>Type</th><th>Members</th></tr>`);
    for (const dep of graph.externalDependencies.slice(0, 50)) {
      const members = dep.references.map((r) => r.memberName).join(", ") || "\u2014";
      parts.push(`<tr><td><code>${escapeHtml(dep.from)}</code></td>`
        + `<td><code>${escapeHtml(dep.to)}</code></td>`
        + `<td>${escapeHtml(dep.toType)}</td>`
        + `<td>${escapeHtml(members)}</td></tr>`);
    }
    parts.push(`</table>`);
    if (graph.externalDependencies.length > 50) {
      parts.push(`<p><em>Showing first 50 of ${graph.externalDependencies.length} external dependencies.</em></p>`);
    }
  }

  return wrapHtmlPage("Package Diagram: " + packageName, parts.join("\n"));
}
