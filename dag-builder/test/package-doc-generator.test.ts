import { describe, it, expect } from "vitest";
import { buildClusterSummaryPrompt, buildPackageOverviewPrompt } from "../src/prompts";
import { assembleDocument, aggregateExternalDeps } from "../src/package-doc-generator";
import { Cluster, PackageGraph, DagEdge } from "../src/types";

// ─── buildClusterSummaryPrompt ───

describe("buildClusterSummaryPrompt", () => {
  const clusterObjects = [
    { name: "ZCL_PAYMENT", type: "CLAS", summary: "Processes payment transactions." },
    { name: "ZCL_VALIDATOR", type: "CLAS", summary: "Validates payment data." },
  ];
  const clusterEdges: DagEdge[] = [
    { from: "ZCL_PAYMENT", to: "ZCL_VALIDATOR", references: [{ memberName: "VALIDATE", memberType: "method" }] },
  ];

  it("should include cluster object count", () => {
    const messages = buildClusterSummaryPrompt(clusterObjects, clusterEdges);
    const userMsg = messages.find((m) => m.role === "user")!;
    expect(userMsg.content).toContain("2 objects");
  });

  it("should include object summaries", () => {
    const messages = buildClusterSummaryPrompt(clusterObjects, clusterEdges);
    const userMsg = messages.find((m) => m.role === "user")!;
    expect(userMsg.content).toContain("ZCL_PAYMENT (CLAS): Processes payment transactions.");
    expect(userMsg.content).toContain("ZCL_VALIDATOR (CLAS): Validates payment data.");
  });

  it("should include internal dependency arrows", () => {
    const messages = buildClusterSummaryPrompt(clusterObjects, clusterEdges);
    const userMsg = messages.find((m) => m.role === "user")!;
    expect(userMsg.content).toContain("ZCL_PAYMENT -> ZCL_VALIDATOR");
    expect(userMsg.content).toContain("VALIDATE");
  });

  it("should instruct to suggest cluster name on first line", () => {
    const messages = buildClusterSummaryPrompt(clusterObjects, clusterEdges);
    const sysMsg = messages.find((m) => m.role === "system")!;
    expect(sysMsg.content).toContain("First line");
    expect(sysMsg.content).toContain("cluster");
  });

  it("should have 300 word limit", () => {
    const messages = buildClusterSummaryPrompt(clusterObjects, clusterEdges);
    const sysMsg = messages.find((m) => m.role === "system")!;
    expect(sysMsg.content).toContain("300 words");
  });
});

// ─── buildPackageOverviewPrompt ───

describe("buildPackageOverviewPrompt", () => {
  const clusterSummaries = [
    { name: "Payment Processing", summary: "Handles payment logic.", objectCount: 3 },
    { name: "Bank Integration", summary: "Communicates with bank APIs.", objectCount: 2 },
  ];
  const externalDeps = [
    { name: "CL_HTTP_CLIENT", type: "CLAS", usedBy: ["ZCL_BANK_CONNECTOR"] },
  ];

  it("should include package name", () => {
    const messages = buildPackageOverviewPrompt("ZFINANCE", clusterSummaries, externalDeps);
    const sysMsg = messages.find((m) => m.role === "system")!;
    expect(sysMsg.content).toContain("ZFINANCE");
  });

  it("should include total object count", () => {
    const messages = buildPackageOverviewPrompt("ZFINANCE", clusterSummaries, externalDeps);
    const userMsg = messages.find((m) => m.role === "user")!;
    expect(userMsg.content).toContain("5 objects");
    expect(userMsg.content).toContain("2 functional cluster(s)");
  });

  it("should include cluster summaries", () => {
    const messages = buildPackageOverviewPrompt("ZFINANCE", clusterSummaries, externalDeps);
    const userMsg = messages.find((m) => m.role === "user")!;
    expect(userMsg.content).toContain("Payment Processing");
    expect(userMsg.content).toContain("Handles payment logic.");
    expect(userMsg.content).toContain("Bank Integration");
  });

  it("should include external dependencies", () => {
    const messages = buildPackageOverviewPrompt("ZFINANCE", clusterSummaries, externalDeps);
    const userMsg = messages.find((m) => m.role === "user")!;
    expect(userMsg.content).toContain("CL_HTTP_CLIENT");
    expect(userMsg.content).toContain("ZCL_BANK_CONNECTOR");
  });

  it("should request Overview and Architecture sections", () => {
    const messages = buildPackageOverviewPrompt("ZFINANCE", clusterSummaries, externalDeps);
    const sysMsg = messages.find((m) => m.role === "system")!;
    expect(sysMsg.content).toContain("Overview");
    expect(sysMsg.content).toContain("Architecture");
  });
});

// ─── assembleDocument ───

describe("assembleDocument", () => {
  const clusters: Cluster[] = [
    {
      id: 0,
      name: "Payment Processing",
      objects: [
        { name: "ZCL_PAYMENT", type: "CLAS", description: "", uri: "" },
        { name: "ZCL_VALIDATOR", type: "CLAS", description: "", uri: "" },
      ],
      internalEdges: [],
      topologicalOrder: ["ZCL_VALIDATOR", "ZCL_PAYMENT"],
    },
    {
      id: 1,
      name: "Standalone Objects",
      objects: [
        { name: "ZCL_UTILS", type: "CLAS", description: "", uri: "" },
      ],
      internalEdges: [],
      topologicalOrder: ["ZCL_UTILS"],
    },
  ];

  const clusterSummaries: Record<string, string> = {
    "Payment Processing": "Handles payment validation and execution.",
    "Standalone Objects": "Objects with no internal package dependencies.",
  };

  const objectDocs: Record<string, string> = {
    "ZCL_PAYMENT": "# ZCL_PAYMENT\n\n## Overview\nPayment processor.\n\n## Functional Logic\nProcesses payments.",
    "ZCL_VALIDATOR": "# ZCL_VALIDATOR\n\n## Overview\nValidator.\n\n## Functional Logic\nValidates data.",
    "ZCL_UTILS": "# ZCL_UTILS\n\n## Overview\nUtility class.",
  };

  const externalDeps = [
    { name: "CL_HTTP", type: "CLAS", usedBy: ["ZCL_PAYMENT"] },
  ];

  it("should start with package heading", () => {
    const doc = assembleDocument("ZFINANCE", "Overview text.", clusters, clusterSummaries, objectDocs, externalDeps);
    expect(doc.startsWith("# Package ZFINANCE")).toBe(true);
  });

  it("should include overview text", () => {
    const doc = assembleDocument("ZFINANCE", "This is the overview.", clusters, clusterSummaries, objectDocs, externalDeps);
    expect(doc).toContain("This is the overview.");
  });

  it("should include cluster headings at ## level", () => {
    const doc = assembleDocument("ZFINANCE", "Overview.", clusters, clusterSummaries, objectDocs, externalDeps);
    expect(doc).toContain("## Payment Processing");
    expect(doc).toContain("## Standalone Objects");
  });

  it("should include cluster summaries", () => {
    const doc = assembleDocument("ZFINANCE", "Overview.", clusters, clusterSummaries, objectDocs, externalDeps);
    expect(doc).toContain("Handles payment validation and execution.");
  });

  it("should shift individual object doc headings to ### and ####", () => {
    const doc = assembleDocument("ZFINANCE", "Overview.", clusters, clusterSummaries, objectDocs, externalDeps);
    expect(doc).toContain("### ZCL_PAYMENT");
    expect(doc).toContain("#### Overview");
    expect(doc).toContain("#### Functional Logic");
    // Should NOT contain # ZCL_PAYMENT (unshifted)
    expect(doc).not.toMatch(/^# ZCL_PAYMENT$/m);
  });

  it("should include external dependencies section", () => {
    const doc = assembleDocument("ZFINANCE", "Overview.", clusters, clusterSummaries, objectDocs, externalDeps);
    expect(doc).toContain("## External Dependencies");
    expect(doc).toContain("**CL_HTTP**");
    expect(doc).toContain("ZCL_PAYMENT");
  });

  it("should include section separators", () => {
    const doc = assembleDocument("ZFINANCE", "Overview.", clusters, clusterSummaries, objectDocs, externalDeps);
    expect(doc).toContain("---");
  });
});

// ─── aggregateExternalDeps ───

describe("aggregateExternalDeps", () => {
  it("should aggregate and sort by reference count", () => {
    const graph: PackageGraph = {
      objects: [],
      internalEdges: [],
      externalDependencies: [
        { from: "ZCL_A", to: "CL_COMMON", toType: "CLAS", references: [] },
        { from: "ZCL_B", to: "CL_COMMON", toType: "CLAS", references: [] },
        { from: "ZCL_A", to: "CL_RARE", toType: "CLAS", references: [] },
      ],
    };

    const result = aggregateExternalDeps(graph);
    expect(result[0].name).toBe("CL_COMMON");
    expect(result[0].usedBy).toHaveLength(2);
    expect(result[1].name).toBe("CL_RARE");
    expect(result[1].usedBy).toHaveLength(1);
  });

  it("should deduplicate usedBy entries", () => {
    const graph: PackageGraph = {
      objects: [],
      internalEdges: [],
      externalDependencies: [
        { from: "ZCL_A", to: "CL_X", toType: "CLAS", references: [] },
        { from: "ZCL_A", to: "CL_X", toType: "CLAS", references: [] },
      ],
    };

    const result = aggregateExternalDeps(graph);
    expect(result[0].usedBy).toHaveLength(1);
  });

  it("should handle empty graph", () => {
    const graph: PackageGraph = {
      objects: [],
      internalEdges: [],
      externalDependencies: [],
    };

    const result = aggregateExternalDeps(graph);
    expect(result).toHaveLength(0);
  });
});
