import { DagNode, DagEdge, LlmMessage, PackageObject } from "./types";
import { DocTemplate } from "./templates";

/**
 * Builds prompt messages for summarizing a dependency object.
 * Used with the cheap/fast model for each non-root node in topological order.
 */
export function buildSummaryPrompt(
  node: DagNode,
  source: string,
  depSummaries: Array<{ name: string; summary: string }>,
): LlmMessage[] {
  const system = [
    "You are an ABAP documentation assistant.",
    "Summarize this ABAP object concisely.",
    "Focus on: purpose, key capabilities, and business behavior.",
    "Keep it under 200 words. Output plain text, no Markdown headers.",
  ].join(" ");

  const parts: string[] = [
    `Object: ${node.name} (Type: ${node.type})`,
  ];

  if (node.usedBy.length > 0) {
    parts.push(`Used by: ${node.usedBy.join(", ")}`);
  }

  if (depSummaries.length > 0) {
    parts.push("");
    parts.push("Dependencies this object uses:");
    for (const dep of depSummaries) {
      parts.push(`- ${dep.name}: ${dep.summary}`);
    }
  }

  parts.push("");
  parts.push("Source code:");
  parts.push(source);

  return [
    { role: "system", content: system },
    { role: "user", content: parts.join("\n") },
  ];
}

/**
 * Builds prompt messages for generating full documentation of the root object.
 * Used with the capable model, receiving all dependency summaries as context.
 */
export function buildDocPrompt(
  rootNode: DagNode,
  rootSource: string,
  depDetails: Array<{
    name: string;
    type: string;
    summary: string;
    usedMembers: Array<{ memberName: string; memberType: string }>;
  }>,
  template: DocTemplate,
  whereUsedList?: Array<{ name: string; type: string; description: string }>,
  userContext?: string,
): LlmMessage[] {
  const objectTypeLabel = rootNode.type === "CLAS" ? "ABAP class"
    : rootNode.type === "INTF" ? "ABAP interface"
    : rootNode.type === "FUGR" ? "ABAP function group"
    : rootNode.type === "PROG" ? "ABAP report/program"
    : rootNode.type === "DDLS" ? "CDS view"
    : rootNode.type === "DDLX" ? "CDS metadata extension"
    : rootNode.type === "DCLS" ? "CDS access control"
    : "ABAP object";

  const system = [
    `You are an ABAP documentation expert. You are documenting an ${objectTypeLabel}: ${rootNode.name}.`,
    "Write functional, business-oriented documentation. Focus on WHAT the object does and WHY, not on technical signatures.",
    "Do NOT list every method with its parameters, return types, and exceptions. Instead, describe the business logic and functional capabilities.",
    "Use the dependency summaries to explain how the object interacts with its dependencies.",
    "",
    "## Output Structure",
    "",
    template.sections,
    "",
    `Keep the documentation under ${template.maxWords} words. Be thorough but concise.`,
    "",
    "## Formatting",
    "",
    "Output clean Markdown. Use `#` for the object name heading, `##` for sections. Do not number the section headings — the heading level provides structure. Use `-` for bullet lists. Use `backticks` for ABAP names inline.",
    "",
    "## Available Tools",
    "",
    "You have access to tools that let you explore the ABAP system on demand:",
    "- get_source: Fetch source code for any ABAP object by name",
    "- get_where_used: Get the where-used list showing which objects reference a given object",
    "",
    "Use these tools when you need additional context beyond what is already provided.",
    "Do not fetch source for objects whose source is already included in the prompt.",
    "The where-used list for the root object is already included in the prompt — do not call get_where_used for it.",
    "Use get_where_used only if you need where-used data for other objects.",
    ...(userContext && userContext.trim() ? [
      "",
      "## Additional Context from User",
      "",
      userContext.trim(),
    ] : []),
  ].join("\n");

  const parts: string[] = [
    `# ${rootNode.name} (${rootNode.type})`,
    "",
    "## Source Code",
    "```abap",
    rootSource,
    "```",
  ];

  if (depDetails.length > 0) {
    parts.push("");
    parts.push("## Dependencies");
    for (const dep of depDetails) {
      parts.push("");
      parts.push(`### ${dep.name} (${dep.type})`);
      parts.push(dep.summary);
      if (dep.usedMembers.length > 0) {
        parts.push("");
        parts.push("Members used:");
        for (const m of dep.usedMembers) {
          parts.push(`- ${m.memberName} (${m.memberType})`);
        }
      }
    }
  }

  if (whereUsedList && whereUsedList.length > 0) {
    parts.push("");
    parts.push("## Where-Used List");
    parts.push("The following objects reference this object:");
    for (const ref of whereUsedList) {
      parts.push(`- ${ref.name} (${ref.type})${ref.description ? ": " + ref.description : ""}`);
    }
  } else if (whereUsedList) {
    parts.push("");
    parts.push("## Where-Used List");
    parts.push("No where-used references found for this object.");
  }

  parts.push("");
  parts.push("Generate the documentation following the output structure from the system instructions.");

  return [
    { role: "system", content: system },
    { role: "user", content: parts.join("\n") },
  ];
}

/**
 * Builds prompt for triaging which objects deserve full documentation.
 * Used with the cheap/fast model after all summaries are generated.
 * Returns a list of object names that should get full docs.
 */
export function buildTriagePrompt(
  objects: Array<{ name: string; type: string; summary: string; sourceLines: number; depCount: number; usedByCount: number }>,
): LlmMessage[] {
  const system = [
    "You are an ABAP documentation expert deciding which objects in a package deserve full, detailed documentation.",
    "",
    "Objects that SHOULD get full documentation:",
    "- Complex classes with significant business logic",
    "- Key interfaces that define contracts",
    "- Entry points, API classes, or facade patterns",
    "- Objects with multiple dependencies or many consumers",
    "- Objects that are hard to understand from source alone",
    "",
    "Objects that should NOT get full documentation (summary is enough):",
    "- Simple data containers, constants, or enums",
    "- Trivial helper/utility classes with obvious behavior",
    "- Generated code or boilerplate (e.g., MPC/DPC classes)",
    "- Very small objects (< 30 lines) with clear purpose",
    "- Standard framework implementations with no custom logic",
    "",
    "Output ONLY the names of objects that should get full documentation, one per line.",
    "Do NOT include any other text, explanations, or formatting.",
  ].join("\n");

  const parts: string[] = [
    `Package contains ${objects.length} objects. Decide which ones need full documentation:`,
    "",
  ];

  for (const obj of objects) {
    parts.push(`- ${obj.name} (${obj.type}, ${obj.sourceLines} lines, ${obj.depCount} deps, used by ${obj.usedByCount}) — ${obj.summary}`);
  }

  return [
    { role: "system", content: system },
    { role: "user", content: parts.join("\n") },
  ];
}

/**
 * Builds prompt for generating a cluster summary from individual object summaries.
 * Used with the cheap/fast model. First line of response = suggested cluster name.
 */
export function buildClusterSummaryPrompt(
  clusterObjects: Array<{ name: string; type: string; summary: string }>,
  clusterEdges: DagEdge[],
): LlmMessage[] {
  const system = [
    "You are an ABAP documentation assistant.",
    "Summarize this functional cluster of related ABAP objects.",
    "Focus on: what this cluster does as a unit, the data/control flow between objects, and the business capability it provides.",
    "First line: suggest a short descriptive name for this cluster (3-5 words, no quotes).",
    "Then a blank line, then the summary.",
    "Keep the summary under 300 words. Output plain text, no Markdown headers.",
  ].join(" ");

  const parts: string[] = [
    `Cluster contains ${clusterObjects.length} objects:`,
    "",
  ];

  for (const obj of clusterObjects) {
    parts.push(`- ${obj.name} (${obj.type}): ${obj.summary}`);
  }

  if (clusterEdges.length > 0) {
    parts.push("");
    parts.push("Internal dependencies:");
    for (const edge of clusterEdges) {
      const refs = edge.references.map((r) => r.memberName).join(", ");
      parts.push(`- ${edge.from} -> ${edge.to}${refs ? ` (uses: ${refs})` : ""}`);
    }
  }

  return [
    { role: "system", content: system },
    { role: "user", content: parts.join("\n") },
  ];
}

/**
 * Builds prompt for generating the package-level overview from cluster summaries.
 * Used with the capable model.
 */
export function buildPackageOverviewPrompt(
  packageName: string,
  clusterSummaries: Array<{ name: string; summary: string; objectCount: number }>,
  externalDependencies: Array<{ name: string; type: string; usedBy: string[] }>,
  userContext?: string,
): LlmMessage[] {
  const system = [
    `You are an ABAP documentation expert. You are documenting ABAP package ${packageName}.`,
    "Write a package-level overview covering:",
    "",
    "## Output Structure",
    "",
    "- **Overview** — What this package does from a business perspective. What business domain it serves. (1-2 paragraphs)",
    "- **Architecture** — How the functional clusters relate to each other. Describe the high-level data flow, layers, and design patterns. (1-2 paragraphs)",
    "",
    "Keep the overview under 500 words. Be thorough but concise.",
    "",
    "## Formatting",
    "",
    "Output clean Markdown. Use `##` for section headings. Use `-` for bullet lists. Use `backticks` for ABAP names inline.",
    ...(userContext && userContext.trim() ? [
      "",
      "## Additional Context from User",
      "",
      userContext.trim(),
    ] : []),
  ].join("\n");

  const totalObjects = clusterSummaries.reduce((n, c) => n + c.objectCount, 0);
  const parts: string[] = [
    `# Package: ${packageName}`,
    "",
    `Contains ${totalObjects} objects in ${clusterSummaries.length} functional cluster(s).`,
    "",
    "## Functional Clusters",
  ];

  for (const cluster of clusterSummaries) {
    parts.push("");
    parts.push(`### ${cluster.name} (${cluster.objectCount} objects)`);
    parts.push(cluster.summary);
  }

  if (externalDependencies.length > 0) {
    parts.push("");
    parts.push("## Key External Dependencies");
    for (const dep of externalDependencies.slice(0, 20)) {
      parts.push(`- ${dep.name} (${dep.type}) — used by: ${dep.usedBy.join(", ")}`);
    }
  }

  parts.push("");
  parts.push("Generate the package overview following the output structure from the system instructions.");

  return [
    { role: "system", content: system },
    { role: "user", content: parts.join("\n") },
  ];
}
