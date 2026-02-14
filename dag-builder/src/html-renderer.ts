import { marked } from "marked";
import { Cluster, DagEdge, DagNode } from "./types";

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
.cluster-section { margin-top: 32px; }
.back-link { margin-top: 32px; padding-top: 16px; border-top: 1px solid #d1d9e0; }
.diagram-container { margin: 16px 0 24px; }
.diagram-container summary { cursor: pointer; font-weight: 600; color: #0969da; }
.diagram-container .mermaid { margin-top: 12px; }
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
 * If clickableLinks is true, adds click directives for navigation.
 */
function buildMermaidDiagram(
  objects: Array<{ name: string; type: string }>,
  edges: DagEdge[],
  highlightNode?: string,
  clickableLinks?: boolean,
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

  // Clickable links for navigation
  if (clickableLinks) {
    for (const obj of visibleObjects) {
      lines.push(`  click ${mermaidId(obj.name)} "${obj.name}.html"`);
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

// ─── Page builders ───

export function buildIndexPage(
  packageName: string,
  overviewHtml: string,
  clusters: Cluster[],
  clusterSummaries: Record<string, string>,
  externalDeps: Array<{ name: string; type: string; usedBy: string[] }>,
): string {
  const knownObjects = new Set<string>();
  for (const c of clusters) {
    for (const o of c.objects) knownObjects.add(o.name);
  }

  const parts: string[] = [];
  parts.push(`<h1>Package ${escapeHtml(packageName)}</h1>`);
  parts.push(overviewHtml);

  // Table of Contents by cluster
  for (const cluster of clusters) {
    const clusterId = slugify(cluster.name);
    parts.push(`<div class="cluster-section">`);
    parts.push(`<h2 id="${clusterId}">${escapeHtml(cluster.name)}</h2>`);

    const summary = clusterSummaries[cluster.name];
    if (summary) {
      parts.push(markdownToHtml(summary));
    }

    // Cluster dependency diagram
    const clusterDiagram = buildMermaidDiagram(
      cluster.objects, cluster.internalEdges, undefined, true,
    );
    if (clusterDiagram) {
      parts.push(wrapDiagramHtml(clusterDiagram));
    }

    parts.push(`<div class="toc"><ul>`);
    for (const obj of cluster.objects) {
      parts.push(
        `<li><a href="${obj.name}.html">${escapeHtml(obj.name)}</a>`
        + `<span class="obj-type">(${escapeHtml(obj.type)})</span>`
        + (obj.description ? ` <span class="obj-desc">— ${escapeHtml(obj.description)}</span>` : "")
        + `</li>`,
      );
    }
    parts.push(`</ul></div></div>`);
  }

  // External dependencies
  if (externalDeps.length > 0) {
    parts.push(`<hr>`);
    parts.push(`<h2>External Dependencies</h2>`);
    parts.push(`<ul>`);
    for (const dep of externalDeps.slice(0, 30)) {
      const usedByLinks = dep.usedBy
        .map((u) =>
          knownObjects.has(u) ? `<a href="${u}.html">${escapeHtml(u)}</a>` : escapeHtml(u),
        )
        .join(", ");
      parts.push(
        `<li><strong>${escapeHtml(dep.name)}</strong> (${escapeHtml(dep.type)}) — used by: ${usedByLinks}</li>`,
      );
    }
    parts.push(`</ul>`);
  }

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
): string {
  const clusterId = slugify(clusterName);
  const breadcrumb = `<nav class="breadcrumb">`
    + `<a href="index.html">${escapeHtml(packageName)}</a>`
    + `<span class="sep">/</span>`
    + `<a href="index.html#${clusterId}">${escapeHtml(clusterName)}</a>`
    + `<span class="sep">/</span>`
    + `<strong>${escapeHtml(objectName)}</strong>`
    + `</nav>`;

  let diagramHtml = "";
  if (objectEdges && objectEdges.length > 0 && clusterObjects) {
    // Show only nodes connected to this object
    const connectedNames = new Set<string>([objectName]);
    for (const e of objectEdges) {
      connectedNames.add(e.from);
      connectedNames.add(e.to);
    }
    const visibleObjects = clusterObjects.filter((o) => connectedNames.has(o.name));
    const diagram = buildMermaidDiagram(visibleObjects, objectEdges, objectName, true);
    if (diagram) {
      diagramHtml = "\n" + wrapDiagramHtml(diagram);
    }
  }

  const body = objectDocHtml
    + diagramHtml
    + `\n<div class="back-link"><a href="index.html">&larr; Back to ${escapeHtml(packageName)}</a></div>`;

  return wrapHtmlPage(`${objectName} — ${packageName}`, body, breadcrumb);
}

// ─── Multi-page wiki assembly ───

export function assembleHtmlWiki(
  packageName: string,
  overview: string,
  clusters: Cluster[],
  clusterSummaries: Record<string, string>,
  objectDocs: Record<string, string>,
  externalDeps: Array<{ name: string; type: string; usedBy: string[] }>,
): Record<string, string> {
  const pages: Record<string, string> = {};

  // Collect all known object names for cross-linking
  const knownObjects = new Set<string>();
  for (const cluster of clusters) {
    for (const obj of cluster.objects) {
      knownObjects.add(obj.name);
    }
  }

  // Build object pages
  for (const cluster of clusters) {
    for (const obj of cluster.objects) {
      const md = objectDocs[obj.name];
      if (!md) continue;
      let html = markdownToHtml(md);
      html = linkifyObjectNames(html, knownObjects, obj.name);
      // Collect edges relevant to this object
      const objectEdges = cluster.internalEdges.filter(
        (e) => e.from === obj.name || e.to === obj.name,
      );
      pages[`${obj.name}.html`] = buildObjectPage(
        obj.name, obj.type, html, packageName, cluster.name,
        objectEdges, cluster.objects,
      );
    }
  }

  // Build index page
  const overviewHtml = markdownToHtml(overview);
  pages["index.html"] = buildIndexPage(
    packageName, overviewHtml, clusters, clusterSummaries, externalDeps,
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
