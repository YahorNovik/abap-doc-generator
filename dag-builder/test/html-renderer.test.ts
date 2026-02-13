import { describe, it, expect } from "vitest";
import {
  markdownToHtml,
  linkifyObjectNames,
  buildIndexPage,
  buildObjectPage,
  assembleHtmlWiki,
  renderSingleObjectHtml,
  wrapHtmlPage,
} from "../src/html-renderer";
import { Cluster } from "../src/types";

// ─── markdownToHtml ───

describe("markdownToHtml", () => {
  it("should convert headings", () => {
    const html = markdownToHtml("# Title\n\n## Section");
    expect(html).toContain("<h1>");
    expect(html).toContain("Title");
    expect(html).toContain("<h2>");
    expect(html).toContain("Section");
  });

  it("should convert lists", () => {
    const html = markdownToHtml("- item one\n- item two");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>");
    expect(html).toContain("item one");
  });

  it("should convert inline code", () => {
    const html = markdownToHtml("Use `ZCL_FOO` here.");
    expect(html).toContain("<code>ZCL_FOO</code>");
  });

  it("should convert code blocks", () => {
    const html = markdownToHtml("```\nDATA lv_x TYPE string.\n```");
    expect(html).toContain("<pre>");
    expect(html).toContain("<code>");
    expect(html).toContain("DATA lv_x TYPE string.");
  });

  it("should convert bold and italic", () => {
    const html = markdownToHtml("**bold** and *italic*");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
  });
});

// ─── wrapHtmlPage ───

describe("wrapHtmlPage", () => {
  it("should produce valid HTML structure", () => {
    const page = wrapHtmlPage("Test Title", "<p>Hello</p>");
    expect(page).toContain("<!DOCTYPE html>");
    expect(page).toContain("<title>Test Title</title>");
    expect(page).toContain("<style>");
    expect(page).toContain("<p>Hello</p>");
  });

  it("should include breadcrumbs when provided", () => {
    const page = wrapHtmlPage("Test", "<p>Body</p>", "<nav>Crumbs</nav>");
    expect(page).toContain("<nav>Crumbs</nav>");
  });

  it("should escape HTML in title", () => {
    const page = wrapHtmlPage("A <b> & C", "<p>Body</p>");
    expect(page).toContain("<title>A &lt;b&gt; &amp; C</title>");
  });
});

// ─── linkifyObjectNames ───

describe("linkifyObjectNames", () => {
  const objects = new Set(["ZCL_PAYMENT", "ZCL_HELPER", "ZIF_API"]);

  it("should convert known object names to links", () => {
    const html = "<p>Uses ZCL_HELPER for validation.</p>";
    const result = linkifyObjectNames(html, objects);
    expect(result).toContain('<a href="ZCL_HELPER.html">ZCL_HELPER</a>');
  });

  it("should not self-link current object", () => {
    const html = "<p>ZCL_PAYMENT processes payments using ZCL_HELPER.</p>";
    const result = linkifyObjectNames(html, objects, "ZCL_PAYMENT");
    expect(result).not.toContain('<a href="ZCL_PAYMENT.html">');
    expect(result).toContain('<a href="ZCL_HELPER.html">ZCL_HELPER</a>');
  });

  it("should not linkify inside <code> tags", () => {
    const html = "<p>Call <code>ZCL_HELPER</code> method.</p>";
    const result = linkifyObjectNames(html, objects);
    expect(result).toContain("<code>ZCL_HELPER</code>");
    expect(result).not.toContain("<code><a");
  });

  it("should not linkify inside <pre> tags", () => {
    const html = "<pre><code>DATA lo TYPE REF TO ZCL_HELPER.</code></pre>";
    const result = linkifyObjectNames(html, objects);
    expect(result).not.toContain('<a href="ZCL_HELPER.html">');
  });

  it("should not linkify inside existing <a> tags", () => {
    const html = '<p><a href="other.html">ZCL_HELPER</a> is used.</p>';
    const result = linkifyObjectNames(html, objects);
    // Should not create nested <a> tags
    expect(result).not.toContain("<a href=\"ZCL_HELPER.html\"><a");
  });

  it("should handle multiple objects in one text segment", () => {
    const html = "<p>ZCL_PAYMENT calls ZCL_HELPER via ZIF_API.</p>";
    const result = linkifyObjectNames(html, objects);
    expect(result).toContain('<a href="ZCL_PAYMENT.html">ZCL_PAYMENT</a>');
    expect(result).toContain('<a href="ZCL_HELPER.html">ZCL_HELPER</a>');
    expect(result).toContain('<a href="ZIF_API.html">ZIF_API</a>');
  });

  it("should return html unchanged when no known objects", () => {
    const html = "<p>No objects here.</p>";
    const result = linkifyObjectNames(html, new Set());
    expect(result).toBe(html);
  });
});

// ─── buildIndexPage ───

describe("buildIndexPage", () => {
  const clusters: Cluster[] = [
    {
      id: 0,
      name: "Payment Processing",
      objects: [
        { name: "ZCL_PAYMENT", type: "CLAS", description: "Payment processor", uri: "" },
        { name: "ZCL_VALIDATOR", type: "CLAS", description: "Validates data", uri: "" },
      ],
      internalEdges: [],
      topologicalOrder: ["ZCL_VALIDATOR", "ZCL_PAYMENT"],
    },
  ];
  const clusterSummaries = { "Payment Processing": "Handles payment logic." };
  const externalDeps = [{ name: "CL_HTTP", type: "CLAS", usedBy: ["ZCL_PAYMENT"] }];

  it("should include package name as h1", () => {
    const html = buildIndexPage("ZFINANCE", "<p>Overview.</p>", clusters, clusterSummaries, externalDeps);
    expect(html).toContain("<h1>Package ZFINANCE</h1>");
  });

  it("should include overview content", () => {
    const html = buildIndexPage("ZFINANCE", "<p>Overview text.</p>", clusters, clusterSummaries, externalDeps);
    expect(html).toContain("Overview text.");
  });

  it("should include cluster heading with id", () => {
    const html = buildIndexPage("ZFINANCE", "", clusters, clusterSummaries, externalDeps);
    expect(html).toContain('id="payment-processing"');
    expect(html).toContain("Payment Processing");
  });

  it("should link to object pages", () => {
    const html = buildIndexPage("ZFINANCE", "", clusters, clusterSummaries, externalDeps);
    expect(html).toContain('<a href="ZCL_PAYMENT.html">ZCL_PAYMENT</a>');
    expect(html).toContain('<a href="ZCL_VALIDATOR.html">ZCL_VALIDATOR</a>');
  });

  it("should show object types", () => {
    const html = buildIndexPage("ZFINANCE", "", clusters, clusterSummaries, externalDeps);
    expect(html).toContain("(CLAS)");
  });

  it("should include external dependencies with linked usedBy", () => {
    const html = buildIndexPage("ZFINANCE", "", clusters, clusterSummaries, externalDeps);
    expect(html).toContain("<strong>CL_HTTP</strong>");
    expect(html).toContain('<a href="ZCL_PAYMENT.html">ZCL_PAYMENT</a>');
  });

  it("should include CSS", () => {
    const html = buildIndexPage("ZFINANCE", "", clusters, clusterSummaries, []);
    expect(html).toContain("<style>");
  });
});

// ─── buildObjectPage ───

describe("buildObjectPage", () => {
  it("should include breadcrumbs", () => {
    const html = buildObjectPage("ZCL_PAYMENT", "CLAS", "<h1>ZCL_PAYMENT</h1><p>Doc.</p>", "ZFINANCE", "Payment Processing");
    expect(html).toContain('class="breadcrumb"');
    expect(html).toContain('<a href="index.html">ZFINANCE</a>');
    expect(html).toContain("Payment Processing");
    expect(html).toContain("<strong>ZCL_PAYMENT</strong>");
  });

  it("should include back-to-index link", () => {
    const html = buildObjectPage("ZCL_PAYMENT", "CLAS", "<p>Doc.</p>", "ZFINANCE", "Cluster");
    expect(html).toContain('<a href="index.html">');
    expect(html).toContain("Back to ZFINANCE");
  });

  it("should include CSS", () => {
    const html = buildObjectPage("ZCL_PAYMENT", "CLAS", "<p>Doc.</p>", "ZFINANCE", "Cluster");
    expect(html).toContain("<style>");
  });

  it("should set page title", () => {
    const html = buildObjectPage("ZCL_PAYMENT", "CLAS", "<p>Doc.</p>", "ZFINANCE", "Cluster");
    expect(html).toContain("<title>ZCL_PAYMENT");
  });
});

// ─── assembleHtmlWiki ───

describe("assembleHtmlWiki", () => {
  const clusters: Cluster[] = [
    {
      id: 0,
      name: "Core",
      objects: [
        { name: "ZCL_A", type: "CLAS", description: "", uri: "" },
        { name: "ZCL_B", type: "CLAS", description: "", uri: "" },
      ],
      internalEdges: [],
      topologicalOrder: ["ZCL_A", "ZCL_B"],
    },
    {
      id: 1,
      name: "Standalone Objects",
      objects: [
        { name: "ZCL_C", type: "CLAS", description: "", uri: "" },
      ],
      internalEdges: [],
      topologicalOrder: ["ZCL_C"],
    },
  ];
  const clusterSummaries = { "Core": "Core logic.", "Standalone Objects": "Independent." };
  const objectDocs: Record<string, string> = {
    "ZCL_A": "# ZCL_A\n\nUses ZCL_B for processing.",
    "ZCL_B": "# ZCL_B\n\nHelper class.",
    "ZCL_C": "# ZCL_C\n\nStandalone utility.",
  };
  const externalDeps = [{ name: "CL_HTTP", type: "CLAS", usedBy: ["ZCL_A"] }];

  it("should produce index.html", () => {
    const pages = assembleHtmlWiki("ZPKG", "Overview.", clusters, clusterSummaries, objectDocs, externalDeps);
    expect(pages["index.html"]).toBeDefined();
    expect(pages["index.html"]).toContain("ZPKG");
  });

  it("should produce one HTML file per object", () => {
    const pages = assembleHtmlWiki("ZPKG", "Overview.", clusters, clusterSummaries, objectDocs, externalDeps);
    expect(pages["ZCL_A.html"]).toBeDefined();
    expect(pages["ZCL_B.html"]).toBeDefined();
    expect(pages["ZCL_C.html"]).toBeDefined();
  });

  it("should produce correct total page count", () => {
    const pages = assembleHtmlWiki("ZPKG", "Overview.", clusters, clusterSummaries, objectDocs, externalDeps);
    expect(Object.keys(pages)).toHaveLength(4); // 3 objects + index
  });

  it("should cross-link object references in object pages", () => {
    const pages = assembleHtmlWiki("ZPKG", "Overview.", clusters, clusterSummaries, objectDocs, externalDeps);
    // ZCL_A's doc mentions ZCL_B — should be linked
    expect(pages["ZCL_A.html"]).toContain('<a href="ZCL_B.html">ZCL_B</a>');
  });

  it("should not self-link objects", () => {
    const pages = assembleHtmlWiki("ZPKG", "Overview.", clusters, clusterSummaries, objectDocs, externalDeps);
    // ZCL_A.html heading mentions ZCL_A — should NOT be linked
    expect(pages["ZCL_A.html"]).not.toContain('<a href="ZCL_A.html">ZCL_A</a>');
  });

  it("should include breadcrumbs in object pages", () => {
    const pages = assembleHtmlWiki("ZPKG", "Overview.", clusters, clusterSummaries, objectDocs, externalDeps);
    expect(pages["ZCL_A.html"]).toContain("breadcrumb");
    expect(pages["ZCL_A.html"]).toContain("Core");
  });

  it("should handle empty objectDocs gracefully", () => {
    const pages = assembleHtmlWiki("ZPKG", "Overview.", clusters, clusterSummaries, {}, []);
    expect(pages["index.html"]).toBeDefined();
    expect(Object.keys(pages)).toHaveLength(1); // only index
  });
});

// ─── renderSingleObjectHtml ───

describe("renderSingleObjectHtml", () => {
  it("should produce a complete HTML page", () => {
    const html = renderSingleObjectHtml("ZCL_TEST", "# ZCL_TEST\n\n## Overview\nA test class.");
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<title>ZCL_TEST</title>");
    expect(html).toContain("<style>");
    expect(html).toContain("<h1>");
    expect(html).toContain("A test class.");
  });

  it("should not include breadcrumb navigation", () => {
    const html = renderSingleObjectHtml("ZCL_TEST", "# ZCL_TEST");
    expect(html).not.toContain('<nav class="breadcrumb"');
  });
});
