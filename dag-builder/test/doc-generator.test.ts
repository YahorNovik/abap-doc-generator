import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildSummaryPrompt, buildDocPrompt } from "../src/prompts";
import { computeTopologicalLevels } from "../src/doc-generator";
import { DagNode, DagEdge, LlmMessage } from "../src/types";

// We test the prompt builders and the documentation flow logic directly.
// The actual generateDocumentation() requires a live SAP connection,
// so we test the components it uses: prompt building, summary accumulation.

describe("buildSummaryPrompt", () => {
  const node: DagNode = {
    name: "ZCL_HELPER",
    type: "CLAS",
    isCustom: true,
    sourceAvailable: true,
    usedBy: ["ZCL_ROOT"],
  };
  const source = "CLASS zcl_helper DEFINITION.\nENDCLASS.";

  it("should include object name and type", () => {
    const messages = buildSummaryPrompt(node, source, []);
    const userMsg = messages.find((m) => m.role === "user")!;
    expect(userMsg.content).toContain("ZCL_HELPER");
    expect(userMsg.content).toContain("CLAS");
  });

  it("should include usedBy references", () => {
    const messages = buildSummaryPrompt(node, source, []);
    const userMsg = messages.find((m) => m.role === "user")!;
    expect(userMsg.content).toContain("Used by: ZCL_ROOT");
  });

  it("should include source code", () => {
    const messages = buildSummaryPrompt(node, source, []);
    const userMsg = messages.find((m) => m.role === "user")!;
    expect(userMsg.content).toContain("CLASS zcl_helper DEFINITION.");
  });

  it("should include dependency summaries when provided", () => {
    const depSummaries = [
      { name: "ZCL_UTILS", summary: "Utility class for formatting." },
    ];
    const messages = buildSummaryPrompt(node, source, depSummaries);
    const userMsg = messages.find((m) => m.role === "user")!;
    expect(userMsg.content).toContain("ZCL_UTILS: Utility class for formatting.");
  });

  it("should have system message with instructions", () => {
    const messages = buildSummaryPrompt(node, source, []);
    const sysMsg = messages.find((m) => m.role === "system")!;
    expect(sysMsg.content).toContain("ABAP documentation assistant");
    expect(sysMsg.content).toContain("200 words");
  });
});

describe("buildDocPrompt", () => {
  const rootNode: DagNode = {
    name: "ZCL_ROOT",
    type: "CLAS",
    isCustom: true,
    sourceAvailable: true,
    usedBy: [],
  };
  const rootSource = "CLASS zcl_root DEFINITION.\n  PUBLIC SECTION.\n    METHODS run.\nENDCLASS.";

  it("should include root object name and source", () => {
    const messages = buildDocPrompt(rootNode, rootSource, []);
    const userMsg = messages.find((m) => m.role === "user")!;
    expect(userMsg.content).toContain("ZCL_ROOT");
    expect(userMsg.content).toContain("METHODS run");
  });

  it("should include dependency details with summaries", () => {
    const depDetails = [
      {
        name: "ZCL_HELPER",
        type: "CLAS",
        summary: "Helper for validation logic.",
        usedMembers: [{ memberName: "VALIDATE", memberType: "method" }],
      },
    ];
    const messages = buildDocPrompt(rootNode, rootSource, depDetails);
    const userMsg = messages.find((m) => m.role === "user")!;
    expect(userMsg.content).toContain("ZCL_HELPER (CLAS)");
    expect(userMsg.content).toContain("Helper for validation logic.");
    expect(userMsg.content).toContain("VALIDATE (method)");
  });

  it("should include all required doc sections", () => {
    const messages = buildDocPrompt(rootNode, rootSource, []);
    const userMsg = messages.find((m) => m.role === "user")!;
    expect(userMsg.content).toContain("Overview");
    expect(userMsg.content).toContain("Public API");
    expect(userMsg.content).toContain("Dependencies");
    expect(userMsg.content).toContain("Usage Examples");
    expect(userMsg.content).toContain("Notes");
  });

  it("should have system message for documentation expert", () => {
    const messages = buildDocPrompt(rootNode, rootSource, []);
    const sysMsg = messages.find((m) => m.role === "system")!;
    expect(sysMsg.content).toContain("ABAP documentation expert");
  });
});

describe("bottom-up summary accumulation", () => {
  // Simulate the accumulation logic from doc-generator without ADT/LLM calls

  it("should process leaves before their dependants", () => {
    const topoOrder = ["ZCL_UTILS", "ZCL_HELPER", "ZCL_ROOT"];
    const root = "ZCL_ROOT";
    const edges: DagEdge[] = [
      { from: "ZCL_ROOT", to: "ZCL_HELPER", references: [{ memberName: "VALIDATE", memberType: "method" }] },
      { from: "ZCL_ROOT", to: "ZCL_UTILS", references: [{ memberName: "CONVERT", memberType: "method" }] },
      { from: "ZCL_HELPER", to: "ZCL_UTILS", references: [{ memberName: "FORMAT", memberType: "method" }] },
    ];

    // Simulate the accumulation
    const summaries: Record<string, string> = {};
    const processOrder: string[] = [];

    const edgesByFrom = new Map<string, DagEdge[]>();
    for (const edge of edges) {
      if (!edgesByFrom.has(edge.from)) edgesByFrom.set(edge.from, []);
      edgesByFrom.get(edge.from)!.push(edge);
    }

    for (const name of topoOrder) {
      if (name === root) continue;
      processOrder.push(name);

      // Gather dep summaries available at this point
      const nodeEdges = edgesByFrom.get(name) ?? [];
      const availableSummaries = nodeEdges
        .filter((e) => summaries[e.to] !== undefined)
        .map((e) => e.to);

      // Simulate summary generation
      summaries[name] = `Summary of ${name}`;

      // Verify ordering: when processing ZCL_HELPER, ZCL_UTILS summary is available
      if (name === "ZCL_HELPER") {
        expect(availableSummaries).toContain("ZCL_UTILS");
      }
    }

    expect(processOrder).toEqual(["ZCL_UTILS", "ZCL_HELPER"]);
    expect(Object.keys(summaries)).toHaveLength(2);
    expect(summaries["ZCL_UTILS"]).toBeDefined();
    expect(summaries["ZCL_HELPER"]).toBeDefined();
  });

  it("should pass accumulated summaries to root doc prompt", () => {
    const rootNode: DagNode = {
      name: "ZCL_ROOT",
      type: "CLAS",
      isCustom: true,
      sourceAvailable: true,
      usedBy: [],
    };

    const summaries: Record<string, string> = {
      "ZCL_HELPER": "Validates input data and checks constraints.",
      "ZCL_UTILS": "Provides formatting and conversion utilities.",
    };

    const edges: DagEdge[] = [
      { from: "ZCL_ROOT", to: "ZCL_HELPER", references: [{ memberName: "VALIDATE", memberType: "method" }] },
      { from: "ZCL_ROOT", to: "ZCL_UTILS", references: [{ memberName: "CONVERT", memberType: "method" }] },
    ];

    const nodeMap = new Map<string, DagNode>([
      ["ZCL_ROOT", rootNode],
      ["ZCL_HELPER", { name: "ZCL_HELPER", type: "CLAS", isCustom: true, sourceAvailable: true, usedBy: ["ZCL_ROOT"] }],
      ["ZCL_UTILS", { name: "ZCL_UTILS", type: "CLAS", isCustom: true, sourceAvailable: true, usedBy: ["ZCL_ROOT", "ZCL_HELPER"] }],
    ]);

    const depDetails = edges
      .filter((e) => nodeMap.has(e.to))
      .map((e) => ({
        name: e.to,
        type: nodeMap.get(e.to)!.type,
        summary: summaries[e.to] ?? "[No summary]",
        usedMembers: e.references.map((r) => ({
          memberName: r.memberName,
          memberType: r.memberType,
        })),
      }));

    const messages = buildDocPrompt(rootNode, "CLASS zcl_root DEFINITION.\nENDCLASS.", depDetails);
    const userMsg = messages.find((m) => m.role === "user")!;

    // Both dependency summaries should be in the final prompt
    expect(userMsg.content).toContain("Validates input data and checks constraints.");
    expect(userMsg.content).toContain("Provides formatting and conversion utilities.");
    expect(userMsg.content).toContain("VALIDATE (method)");
    expect(userMsg.content).toContain("CONVERT (method)");
  });
});

describe("computeTopologicalLevels", () => {
  const edges: DagEdge[] = [
    { from: "ZCL_ROOT", to: "ZCL_HELPER", references: [{ memberName: "VALIDATE", memberType: "method" }] },
    { from: "ZCL_ROOT", to: "ZCL_UTILS", references: [{ memberName: "CONVERT", memberType: "method" }] },
    { from: "ZCL_HELPER", to: "ZCL_UTILS", references: [{ memberName: "FORMAT", memberType: "method" }] },
  ];

  const edgesByFrom = new Map<string, DagEdge[]>();
  for (const edge of edges) {
    if (!edgesByFrom.has(edge.from)) edgesByFrom.set(edge.from, []);
    edgesByFrom.get(edge.from)!.push(edge);
  }

  it("should assign level 0 to leaf nodes", () => {
    const topoOrder = ["ZCL_UTILS", "ZCL_HELPER", "ZCL_ROOT"];
    const levels = computeTopologicalLevels(topoOrder, edgesByFrom, "ZCL_ROOT");

    expect(levels.get("ZCL_UTILS")).toBe(0);
  });

  it("should assign level 1 to nodes depending on leaves", () => {
    const topoOrder = ["ZCL_UTILS", "ZCL_HELPER", "ZCL_ROOT"];
    const levels = computeTopologicalLevels(topoOrder, edgesByFrom, "ZCL_ROOT");

    expect(levels.get("ZCL_HELPER")).toBe(1);
  });

  it("should exclude root from levels", () => {
    const topoOrder = ["ZCL_UTILS", "ZCL_HELPER", "ZCL_ROOT"];
    const levels = computeTopologicalLevels(topoOrder, edgesByFrom, "ZCL_ROOT");

    expect(levels.has("ZCL_ROOT")).toBe(false);
  });

  it("should handle diamond dependencies correctly", () => {
    // A depends on B and C, B depends on D, C depends on D
    const diamondEdges: DagEdge[] = [
      { from: "A", to: "B", references: [] },
      { from: "A", to: "C", references: [] },
      { from: "B", to: "D", references: [] },
      { from: "C", to: "D", references: [] },
    ];

    const diamondByFrom = new Map<string, DagEdge[]>();
    for (const e of diamondEdges) {
      if (!diamondByFrom.has(e.from)) diamondByFrom.set(e.from, []);
      diamondByFrom.get(e.from)!.push(e);
    }

    const topoOrder = ["D", "B", "C", "A"];
    const levels = computeTopologicalLevels(topoOrder, diamondByFrom, "A");

    expect(levels.get("D")).toBe(0);  // leaf
    expect(levels.get("B")).toBe(1);  // depends on D (level 0)
    expect(levels.get("C")).toBe(1);  // depends on D (level 0)
    // A is root, excluded
  });

  it("should group same-level nodes for batching", () => {
    const topoOrder = ["ZCL_UTILS", "ZCL_HELPER", "ZCL_ROOT"];
    const levels = computeTopologicalLevels(topoOrder, edgesByFrom, "ZCL_ROOT");

    // Group by level
    const groups = new Map<number, string[]>();
    for (const [name, level] of levels) {
      if (!groups.has(level)) groups.set(level, []);
      groups.get(level)!.push(name);
    }

    expect(groups.get(0)).toEqual(["ZCL_UTILS"]);
    expect(groups.get(1)).toEqual(["ZCL_HELPER"]);
  });
});
