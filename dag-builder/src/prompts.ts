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
    "You are an ABAP documentation assistant writing for ABAP developers.",
    "Summarize this ABAP object in 2-4 sentences. Be technical and specific — no filler.",
    "Focus on: what it does technically, key tables/APIs used, data flow, and integration points.",
    "Do NOT write generic phrases like 'serves as a central component' or 'facilitates the process'. State concrete technical facts.",
    "Do NOT guess or speculate. Never use words like 'likely', 'probably', 'possibly'. Only state what you can confirm from the provided source/structure.",
    "The summary must be at least 30 words. Output plain text, no Markdown headers.",
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
    "This is TECHNICAL documentation for ABAP developers. Be direct and specific — no filler, no general statements.",
    "Focus on concrete technical details: algorithms, data flow, key tables, integration points, non-obvious design decisions.",
    "Do NOT write general introductory sentences like 'This class serves as...' or 'The primary purpose is to facilitate...'. Jump straight into what it does technically.",
    "Do NOT list every method or enumerate parameters. Describe the processing logic and important technical choices.",
    "Do NOT pad sections with obvious statements. If a section would only restate what's in the code, omit it entirely.",
    "Do NOT guess or speculate. Never use words like 'likely', 'probably', 'possibly'. Only document what you can confirm from the source code.",
    "Use the dependency summaries to explain how the object interacts with its dependencies.",
    "",
    "## Output Structure",
    "",
    template.sections,
    "",
    `STRICT LIMIT: Keep the documentation under ${template.maxWords} words. Shorter is better — only include what a developer cannot easily see from the code itself.`,
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
    "Summarize this group of related ABAP objects.",
    "Focus on: what this group does as a unit, the data/control flow between objects, and the business capability it provides.",
    "First line: suggest a short descriptive name for this group (3-5 words, no quotes).",
    "Then a blank line, then the summary.",
    "Keep the summary under 300 words. Output plain text, no Markdown headers.",
    "Do not use the word 'cluster' in your output.",
  ].join(" ");

  const parts: string[] = [
    `Group contains ${clusterObjects.length} objects:`,
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
 * Builds prompt for asking LLM whether a cluster should be split.
 * Only used for clusters with >3 objects. LLM decides if the group is cohesive
 * or should be divided into sub-groups.
 */
export function buildClusterSplitPrompt(
  objects: Array<{ name: string; type: string; summary: string }>,
  edges: DagEdge[],
): LlmMessage[] {
  const system = [
    "You are an ABAP documentation expert analyzing a group of related ABAP objects.",
    "Determine if this group forms ONE cohesive functional area, or if it should be split into separate groups.",
    "",
    "If the group is cohesive (all objects serve the same purpose/domain), respond with exactly:",
    "KEEP",
    "",
    "If the group should be split, respond with a JSON array of groups. Each group is an object with:",
    '- "objects": array of object names belonging to this sub-group',
    "",
    "Example split response:",
    '[{"objects":["ZCL_A","ZCL_B"]},{"objects":["ZCL_C","ZCL_D","ZCL_E"]}]',
    "",
    "Rules:",
    "- Only split if objects clearly serve DIFFERENT functional purposes",
    "- Each sub-group must have at least 2 objects",
    "- If in doubt, respond KEEP — do not force splits",
    "- Output ONLY 'KEEP' or the JSON array, nothing else",
  ].join("\n");

  const parts: string[] = [
    `Group contains ${objects.length} objects:`,
    "",
  ];

  for (const obj of objects) {
    parts.push(`- ${obj.name} (${obj.type}): ${obj.summary}`);
  }

  if (edges.length > 0) {
    parts.push("");
    parts.push("Internal dependencies:");
    for (const edge of edges) {
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
 * Builds prompt for suggesting which cluster standalone objects should be assigned to.
 * Returns one line per standalone object: "OBJECT_NAME -> CLUSTER_NAME" or "OBJECT_NAME -> KEEP".
 */
export function buildStandaloneAssignPrompt(
  standaloneObjects: Array<{ name: string; type: string; summary: string }>,
  clusters: Array<{ name: string; summary: string }>,
): LlmMessage[] {
  const system = [
    "You are an ABAP documentation expert.",
    "For each standalone object below, decide whether it semantically belongs to one of the named groups, or should stay standalone.",
    "",
    "Output one line per object in this exact format:",
    "OBJECT_NAME -> GROUP_NAME",
    "or",
    "OBJECT_NAME -> KEEP",
    "",
    "Rules:",
    "- Only assign an object to a group if it clearly fits the group's functional purpose",
    "- If unsure, output KEEP",
    "- Output ONLY the assignment lines, nothing else",
  ].join("\n");

  const parts: string[] = [
    "Available groups:",
    "",
  ];

  for (const cluster of clusters) {
    parts.push(`- ${cluster.name}: ${cluster.summary}`);
  }

  parts.push("");
  parts.push("Standalone objects to evaluate:");
  parts.push("");

  for (const obj of standaloneObjects) {
    parts.push(`- ${obj.name} (${obj.type}): ${obj.summary}`);
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
  subPackageSummaries?: Array<{ name: string; summary: string; objectCount: number }>,
): LlmMessage[] {
  const hasSubPackages = subPackageSummaries && subPackageSummaries.length > 0;

  const system = [
    `You are an ABAP documentation expert. You are documenting ABAP package ${packageName}.`,
    "Write a concise package overview in exactly 5 sentences:",
    "1. What business domain this package serves.",
    "2. What the package does from a functional perspective.",
    "3. The main architectural pattern or layers used.",
    "4. Key technologies or frameworks involved (e.g. CDS, RAP, BOPF).",
    "5. How the main components relate to each other.",
    "",
    "Output plain text — no headings, no bullets, no markdown formatting. Just 5 sentences in a single paragraph.",
    "Do not use the word 'cluster' in your output.",
    ...(userContext && userContext.trim() ? [
      "",
      "## Additional Context from User",
      "",
      userContext.trim(),
    ] : []),
  ].join("\n");

  const totalObjects = clusterSummaries.reduce((n, c) => n + c.objectCount, 0)
    + (subPackageSummaries?.reduce((n, sp) => n + sp.objectCount, 0) ?? 0);
  const parts: string[] = [
    `# Package: ${packageName}`,
    "",
  ];

  if (hasSubPackages) {
    parts.push(`Contains ${totalObjects} objects across ${subPackageSummaries!.length} sub-package(s) and ${clusterSummaries.length} component group(s).`);
    parts.push("");
    parts.push("## Sub-Packages");
    for (const sp of subPackageSummaries!) {
      parts.push("");
      parts.push(`### ${sp.name} (${sp.objectCount} objects)`);
      parts.push(sp.summary);
    }
  } else {
    parts.push(`Contains ${totalObjects} objects in ${clusterSummaries.length} component group(s).`);
  }

  if (clusterSummaries.length > 0) {
    parts.push("");
    parts.push("## Component Groups");
    for (const cluster of clusterSummaries) {
      parts.push("");
      parts.push(`### ${cluster.name} (${cluster.objectCount} objects)`);
      parts.push(cluster.summary);
    }
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

/**
 * Builds prompt for generating a sub-package summary from its cluster summaries.
 * Used with the summary (cheap) model.
 */
export function buildSubPackageSummaryPrompt(
  subPackageName: string,
  clusterSummaries: Array<{ name: string; summary: string; objectCount: number }>,
  externalDeps: Array<{ name: string; type: string; usedBy: string[] }>,
): LlmMessage[] {
  const system = [
    "You are an ABAP documentation assistant.",
    `Summarize sub-package ${subPackageName} in under 200 words.`,
    "Focus on: what business capability this sub-package provides, how its objects work together.",
    "Output plain text, no Markdown headers.",
    "Do not use the word 'cluster' in your output.",
  ].join(" ");

  const totalObjects = clusterSummaries.reduce((n, c) => n + c.objectCount, 0);
  const parts: string[] = [
    `Sub-package ${subPackageName} contains ${totalObjects} objects in ${clusterSummaries.length} component group(s):`,
    "",
  ];

  for (const cluster of clusterSummaries) {
    parts.push(`- ${cluster.name} (${cluster.objectCount} objects): ${cluster.summary}`);
  }

  if (externalDeps.length > 0) {
    parts.push("");
    parts.push("Key external dependencies:");
    for (const dep of externalDeps.slice(0, 10)) {
      parts.push(`- ${dep.name} (${dep.type}) — used by: ${dep.usedBy.join(", ")}`);
    }
  }

  return [
    { role: "system", content: system },
    { role: "user", content: parts.join("\n") },
  ];
}
