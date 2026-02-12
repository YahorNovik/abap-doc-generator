import { DagNode, DagEdge, LlmMessage } from "./types";
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
    "Focus on: purpose, public API (key methods/types), and behavior.",
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
): LlmMessage[] {
  const system = [
    "You are an ABAP documentation expert.",
    "Generate comprehensive Markdown documentation for the given ABAP object.",
    "Use the dependency summaries to explain how the object interacts with its dependencies.",
    "\n\nYou have access to tools that let you explore the ABAP system on demand:",
    "\n- get_source: Fetch source code for any ABAP object by name",
    "\n- get_where_used: Get the where-used list showing which objects reference a given object",
    "\nUse these tools when you need additional context beyond what is already provided.",
    "Do not fetch source for objects whose source is already included in the prompt.",
  ].join(" ");

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

  parts.push("");
  parts.push(template.sections);
  parts.push("");
  parts.push(`Keep the documentation under ${template.maxWords} words. Be thorough but concise.`);

  return [
    { role: "system", content: system },
    { role: "user", content: parts.join("\n") },
  ];
}
