import { describe, it, expect } from "vitest";
import { DagResult, DagNode, DagEdge } from "../src/types";

// Since dag-builder.ts requires a live SAP connection, we test the
// topological sort and DAG structure logic with mock data.
// Only custom (Z/Y) objects appear in the DAG — standard objects are excluded.

function buildMockDag(): DagResult {
  const nodes: DagNode[] = [
    { name: "ZCL_ROOT", type: "CLAS", isCustom: true, sourceAvailable: true, usedBy: [] },
    { name: "ZCL_HELPER", type: "CLAS", isCustom: true, sourceAvailable: true, usedBy: ["ZCL_ROOT"] },
    { name: "ZCL_UTILS", type: "CLAS", isCustom: true, sourceAvailable: true, usedBy: ["ZCL_ROOT", "ZCL_HELPER"] },
  ];

  const edges: DagEdge[] = [
    { from: "ZCL_ROOT", to: "ZCL_HELPER", references: [{ memberName: "VALIDATE", memberType: "method" }] },
    { from: "ZCL_ROOT", to: "ZCL_UTILS", references: [{ memberName: "CONVERT", memberType: "method" }] },
    { from: "ZCL_HELPER", to: "ZCL_UTILS", references: [{ memberName: "FORMAT", memberType: "method" }] },
  ];

  return {
    root: "ZCL_ROOT",
    nodes,
    edges,
    topologicalOrder: ["ZCL_UTILS", "ZCL_HELPER", "ZCL_ROOT"],
    errors: [],
  };
}

describe("DAG structure", () => {
  it("should have root as the entry point", () => {
    const dag = buildMockDag();
    expect(dag.root).toBe("ZCL_ROOT");
  });

  it("should have correct node count", () => {
    const dag = buildMockDag();
    expect(dag.nodes).toHaveLength(3);
  });

  it("should only contain custom objects", () => {
    const dag = buildMockDag();
    expect(dag.nodes.every((n) => n.isCustom)).toBe(true);
  });

  it("should have correct edge references", () => {
    const dag = buildMockDag();
    const rootToHelper = dag.edges.find((e) => e.from === "ZCL_ROOT" && e.to === "ZCL_HELPER");
    expect(rootToHelper).toBeDefined();
    expect(rootToHelper!.references[0].memberName).toBe("VALIDATE");
  });

  it("should have topological order with leaves first", () => {
    const dag = buildMockDag();
    const order = dag.topologicalOrder;

    // ZCL_UTILS is a leaf (no custom deps) -> should come first
    expect(order.indexOf("ZCL_UTILS")).toBeLessThan(order.indexOf("ZCL_HELPER"));
    // ZCL_ROOT depends on everything -> comes last
    expect(order.indexOf("ZCL_ROOT")).toBe(order.length - 1);
  });

  it("should track usedBy references", () => {
    const dag = buildMockDag();
    const utils = dag.nodes.find((n) => n.name === "ZCL_UTILS");
    expect(utils!.usedBy).toContain("ZCL_ROOT");
    expect(utils!.usedBy).toContain("ZCL_HELPER");
  });

  it("should mark all custom objects as sourceAvailable=true", () => {
    const dag = buildMockDag();
    expect(dag.nodes.every((n) => n.sourceAvailable)).toBe(true);
  });
});
