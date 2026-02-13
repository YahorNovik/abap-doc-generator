import { describe, it, expect } from "vitest";
import { buildPackageGraph, detectClusters } from "../src/package-graph";
import { PackageObject, PackageGraph, DagEdge } from "../src/types";

// ─── buildPackageGraph ───

describe("buildPackageGraph", () => {
  const objects: PackageObject[] = [
    { name: "ZCL_A", type: "CLAS", description: "Class A", uri: "/sap/bc/adt/oo/classes/zcl_a" },
    { name: "ZCL_B", type: "CLAS", description: "Class B", uri: "/sap/bc/adt/oo/classes/zcl_b" },
    { name: "ZCL_C", type: "CLAS", description: "Class C", uri: "/sap/bc/adt/oo/classes/zcl_c" },
  ];

  it("should classify edges as internal when both endpoints are in package", () => {
    // Source for ZCL_A references ZCL_B (which is in the package)
    const sources = new Map<string, string>([
      ["ZCL_A", "CLASS zcl_a DEFINITION.\n  PUBLIC SECTION.\n    DATA: lo_b TYPE REF TO zcl_b.\nENDCLASS.\nCLASS zcl_a IMPLEMENTATION.\nENDCLASS."],
      ["ZCL_B", "CLASS zcl_b DEFINITION.\nENDCLASS.\nCLASS zcl_b IMPLEMENTATION.\nENDCLASS."],
      ["ZCL_C", "CLASS zcl_c DEFINITION.\nENDCLASS.\nCLASS zcl_c IMPLEMENTATION.\nENDCLASS."],
    ]);

    const errors: string[] = [];
    const graph = buildPackageGraph(objects, sources, errors);

    // ZCL_A -> ZCL_B should be internal
    const internalA = graph.internalEdges.filter((e) => e.from === "ZCL_A");
    expect(internalA.some((e) => e.to === "ZCL_B")).toBe(true);
  });

  it("should classify edges as external when target is outside package", () => {
    // Source for ZCL_A references CL_STANDARD (not in our package)
    const sources = new Map<string, string>([
      ["ZCL_A", "CLASS zcl_a DEFINITION.\n  PUBLIC SECTION.\n    DATA: lo_ext TYPE REF TO zcl_external.\nENDCLASS.\nCLASS zcl_a IMPLEMENTATION.\nENDCLASS."],
      ["ZCL_B", "CLASS zcl_b DEFINITION.\nENDCLASS.\nCLASS zcl_b IMPLEMENTATION.\nENDCLASS."],
      ["ZCL_C", "CLASS zcl_c DEFINITION.\nENDCLASS.\nCLASS zcl_c IMPLEMENTATION.\nENDCLASS."],
    ]);

    const errors: string[] = [];
    const graph = buildPackageGraph(objects, sources, errors);

    expect(graph.externalDependencies.some((e) => e.to === "ZCL_EXTERNAL")).toBe(true);
  });

  it("should handle objects with no source", () => {
    const sources = new Map<string, string>([
      ["ZCL_A", "CLASS zcl_a DEFINITION.\nENDCLASS.\nCLASS zcl_a IMPLEMENTATION.\nENDCLASS."],
      // ZCL_B has no source
      ["ZCL_C", "CLASS zcl_c DEFINITION.\nENDCLASS.\nCLASS zcl_c IMPLEMENTATION.\nENDCLASS."],
    ]);

    const errors: string[] = [];
    const graph = buildPackageGraph(objects, sources, errors);

    // Should not crash, just skip ZCL_B
    expect(graph.objects).toHaveLength(3);
  });

  it("should skip self-references", () => {
    const sources = new Map<string, string>([
      ["ZCL_A", "CLASS zcl_a DEFINITION.\n  PUBLIC SECTION.\n    DATA: lo_self TYPE REF TO zcl_a.\nENDCLASS.\nCLASS zcl_a IMPLEMENTATION.\nENDCLASS."],
      ["ZCL_B", "CLASS zcl_b DEFINITION.\nENDCLASS.\nCLASS zcl_b IMPLEMENTATION.\nENDCLASS."],
      ["ZCL_C", "CLASS zcl_c DEFINITION.\nENDCLASS.\nCLASS zcl_c IMPLEMENTATION.\nENDCLASS."],
    ]);

    const errors: string[] = [];
    const graph = buildPackageGraph(objects, sources, errors);

    expect(graph.internalEdges.some((e) => e.from === "ZCL_A" && e.to === "ZCL_A")).toBe(false);
  });

  it("should return empty graph for empty sources", () => {
    const sources = new Map<string, string>();
    const errors: string[] = [];
    const graph = buildPackageGraph(objects, sources, errors);

    expect(graph.internalEdges).toHaveLength(0);
    expect(graph.externalDependencies).toHaveLength(0);
  });
});

// ─── detectClusters ───

describe("detectClusters", () => {
  it("should group connected objects into one cluster", () => {
    const graph: PackageGraph = {
      objects: [
        { name: "ZCL_A", type: "CLAS", description: "", uri: "" },
        { name: "ZCL_B", type: "CLAS", description: "", uri: "" },
        { name: "ZCL_C", type: "CLAS", description: "", uri: "" },
      ],
      internalEdges: [
        { from: "ZCL_A", to: "ZCL_B", references: [] },
        { from: "ZCL_B", to: "ZCL_C", references: [] },
      ],
      externalDependencies: [],
    };

    const clusters = detectClusters(graph);
    // All three should be in one cluster (transitive connection)
    const mainCluster = clusters.find((c) => c.objects.length === 3);
    expect(mainCluster).toBeDefined();
    expect(mainCluster!.objects.map((o) => o.name).sort()).toEqual(["ZCL_A", "ZCL_B", "ZCL_C"]);
  });

  it("should create separate clusters for disconnected groups", () => {
    const graph: PackageGraph = {
      objects: [
        { name: "ZCL_A", type: "CLAS", description: "", uri: "" },
        { name: "ZCL_B", type: "CLAS", description: "", uri: "" },
        { name: "ZCL_C", type: "CLAS", description: "", uri: "" },
        { name: "ZCL_D", type: "CLAS", description: "", uri: "" },
      ],
      internalEdges: [
        { from: "ZCL_A", to: "ZCL_B", references: [] },
        { from: "ZCL_C", to: "ZCL_D", references: [] },
      ],
      externalDependencies: [],
    };

    const clusters = detectClusters(graph);
    // Should have 2 clusters
    const nonStandalone = clusters.filter((c) => c.name !== "Standalone Objects");
    expect(nonStandalone).toHaveLength(2);
  });

  it("should group singletons into Standalone Objects cluster", () => {
    const graph: PackageGraph = {
      objects: [
        { name: "ZCL_A", type: "CLAS", description: "", uri: "" },
        { name: "ZCL_B", type: "CLAS", description: "", uri: "" },
        { name: "ZCL_LONE", type: "CLAS", description: "", uri: "" },
      ],
      internalEdges: [
        { from: "ZCL_A", to: "ZCL_B", references: [] },
      ],
      externalDependencies: [],
    };

    const clusters = detectClusters(graph);
    const standalone = clusters.find((c) => c.name === "Standalone Objects");
    expect(standalone).toBeDefined();
    expect(standalone!.objects.map((o) => o.name)).toEqual(["ZCL_LONE"]);
  });

  it("should produce topological order within cluster (leaves first)", () => {
    const graph: PackageGraph = {
      objects: [
        { name: "ZCL_ROOT", type: "CLAS", description: "", uri: "" },
        { name: "ZCL_MID", type: "CLAS", description: "", uri: "" },
        { name: "ZCL_LEAF", type: "CLAS", description: "", uri: "" },
      ],
      internalEdges: [
        { from: "ZCL_ROOT", to: "ZCL_MID", references: [] },
        { from: "ZCL_MID", to: "ZCL_LEAF", references: [] },
      ],
      externalDependencies: [],
    };

    const clusters = detectClusters(graph);
    const cluster = clusters[0];

    // Leaf should come before mid, mid before root
    const leafIdx = cluster.topologicalOrder.indexOf("ZCL_LEAF");
    const midIdx = cluster.topologicalOrder.indexOf("ZCL_MID");
    const rootIdx = cluster.topologicalOrder.indexOf("ZCL_ROOT");
    expect(leafIdx).toBeLessThan(midIdx);
    expect(midIdx).toBeLessThan(rootIdx);
  });

  it("should handle empty graph", () => {
    const graph: PackageGraph = {
      objects: [],
      internalEdges: [],
      externalDependencies: [],
    };

    const clusters = detectClusters(graph);
    expect(clusters).toHaveLength(0);
  });

  it("should handle all singletons", () => {
    const graph: PackageGraph = {
      objects: [
        { name: "ZCL_A", type: "CLAS", description: "", uri: "" },
        { name: "ZCL_B", type: "CLAS", description: "", uri: "" },
      ],
      internalEdges: [],
      externalDependencies: [],
    };

    const clusters = detectClusters(graph);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].name).toBe("Standalone Objects");
    expect(clusters[0].objects).toHaveLength(2);
  });

  it("should handle diamond dependency pattern", () => {
    const graph: PackageGraph = {
      objects: [
        { name: "A", type: "CLAS", description: "", uri: "" },
        { name: "B", type: "CLAS", description: "", uri: "" },
        { name: "C", type: "CLAS", description: "", uri: "" },
        { name: "D", type: "CLAS", description: "", uri: "" },
      ],
      internalEdges: [
        { from: "A", to: "B", references: [] },
        { from: "A", to: "C", references: [] },
        { from: "B", to: "D", references: [] },
        { from: "C", to: "D", references: [] },
      ],
      externalDependencies: [],
    };

    const clusters = detectClusters(graph);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].objects).toHaveLength(4);

    // D should come first (leaf), A last
    const topoOrder = clusters[0].topologicalOrder;
    expect(topoOrder.indexOf("D")).toBeLessThan(topoOrder.indexOf("A"));
  });
});
