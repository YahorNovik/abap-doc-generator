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
  whereUsedList?: Array<{ name: string; type: string; description: string }>,
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
