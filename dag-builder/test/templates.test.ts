import { describe, it, expect } from "vitest";
import { resolveTemplate } from "../src/templates";

describe("resolveTemplate — class/interface", () => {
  it("returns default template for classes when no type specified", () => {
    const tmpl = resolveTemplate(undefined, undefined, "CLAS");
    expect(tmpl.name).toBe("Default");
    expect(tmpl.maxOutputTokens).toBe(8192);
    expect(tmpl.maxWords).toBe(3000);
  });

  it("includes Functional Logic section for classes", () => {
    const tmpl = resolveTemplate("default", undefined, "CLAS");
    expect(tmpl.sections).toContain("Functional Logic");
    expect(tmpl.sections).toContain("business logic");
  });

  it("focuses on functional areas not method listing", () => {
    const tmpl = resolveTemplate("default", undefined, "CLAS");
    expect(tmpl.sections).toContain("Group by functional area");
    expect(tmpl.sections).not.toContain("Parameters (table");
  });

  it("includes Where-Used section for classes", () => {
    const tmpl = resolveTemplate("default", undefined, "CLAS");
    expect(tmpl.sections).toContain("Where-Used");
    expect(tmpl.sections).toContain("get_where_used");
  });

  it("includes Dependencies section for classes", () => {
    const tmpl = resolveTemplate("default", undefined, "CLAS");
    expect(tmpl.sections).toContain("Dependencies");
  });

  it("does not include Processing Logic section for classes", () => {
    const tmpl = resolveTemplate("default", undefined, "CLAS");
    expect(tmpl.sections).not.toContain("Processing Logic");
  });

  it("works for INTF type", () => {
    const tmpl = resolveTemplate("default", undefined, "INTF");
    expect(tmpl.sections).toContain("Functional Logic");
  });

  it("minimal class template has Overview and Key Capabilities", () => {
    const tmpl = resolveTemplate("minimal", undefined, "CLAS");
    expect(tmpl.name).toBe("Minimal");
    expect(tmpl.sections).toContain("Overview");
    expect(tmpl.sections).toContain("Key Capabilities");
    expect(tmpl.sections).not.toContain("Dependencies");
    expect(tmpl.maxWords).toBe(1000);
    expect(tmpl.maxOutputTokens).toBe(4096);
  });

  it("detailed class template includes Error Handling", () => {
    const tmpl = resolveTemplate("detailed", undefined, "CLAS");
    expect(tmpl.name).toBe("Detailed");
    expect(tmpl.sections).toContain("Error Handling");
    expect(tmpl.maxWords).toBe(5000);
    expect(tmpl.maxOutputTokens).toBe(16384);
  });
});

describe("resolveTemplate — report/FM", () => {
  it("includes Processing Logic section for reports", () => {
    const tmpl = resolveTemplate("default", undefined, "PROG");
    expect(tmpl.sections).toContain("Processing Logic");
    expect(tmpl.sections).toContain("business logic");
    expect(tmpl.sections).not.toContain("Functional Logic");
  });

  it("includes Where-Used section for reports", () => {
    const tmpl = resolveTemplate("default", undefined, "FUGR");
    expect(tmpl.sections).toContain("Where-Used");
  });

  it("detailed report template includes Input section", () => {
    const tmpl = resolveTemplate("detailed", undefined, "PROG");
    expect(tmpl.sections).toContain("Input");
    expect(tmpl.sections).toContain("business meaning");
  });

  it("minimal report template has only Overview and Processing Logic", () => {
    const tmpl = resolveTemplate("minimal", undefined, "FUGR");
    expect(tmpl.sections).toContain("Overview");
    expect(tmpl.sections).toContain("Processing Logic");
    expect(tmpl.sections).not.toContain("Dependencies");
  });
});

describe("resolveTemplate — CDS view", () => {
  it("includes Data Model section for DDLS", () => {
    const tmpl = resolveTemplate("default", undefined, "DDLS");
    expect(tmpl.sections).toContain("Data Model");
    expect(tmpl.sections).toContain("Where-Used");
    expect(tmpl.sections).not.toContain("Functional Logic");
    expect(tmpl.sections).not.toContain("Processing Logic");
  });

  it("works for DDLX (metadata extension)", () => {
    const tmpl = resolveTemplate("default", undefined, "DDLX");
    expect(tmpl.sections).toContain("Data Model");
  });

  it("works for DCLS (access control)", () => {
    const tmpl = resolveTemplate("default", undefined, "DCLS");
    expect(tmpl.sections).toContain("Data Model");
  });

  it("minimal CDS template has Overview and Data Model", () => {
    const tmpl = resolveTemplate("minimal", undefined, "DDLS");
    expect(tmpl.sections).toContain("Overview");
    expect(tmpl.sections).toContain("Data Model");
    expect(tmpl.sections).not.toContain("Where-Used");
  });

  it("detailed CDS template includes annotations and data sources", () => {
    const tmpl = resolveTemplate("detailed", undefined, "DDLS");
    expect(tmpl.sections).toContain("annotations");
    expect(tmpl.sections).toContain("data sources");
    expect(tmpl.sections).toContain("Where-Used");
  });
});

describe("resolveTemplate — fallback and custom", () => {
  it("falls back to default when no type specified", () => {
    const tmpl = resolveTemplate();
    expect(tmpl.name).toBe("Default");
  });

  it("falls back to default for empty string", () => {
    const tmpl = resolveTemplate("");
    expect(tmpl.name).toBe("Default");
  });

  it("falls back to default for unknown type", () => {
    const tmpl = resolveTemplate("nonexistent");
    expect(tmpl.name).toBe("Default");
  });

  it("defaults to class sections when no objectType", () => {
    const tmpl = resolveTemplate("default");
    expect(tmpl.sections).toContain("Functional Logic");
    expect(tmpl.sections).not.toContain("Processing Logic");
  });

  it("returns custom template with user text", () => {
    const tmpl = resolveTemplate("custom", "My custom:\n1. Summary\n2. Details");
    expect(tmpl.name).toBe("Custom");
    expect(tmpl.sections).toBe("My custom:\n1. Summary\n2. Details");
    expect(tmpl.maxOutputTokens).toBe(8192);
  });

  it("falls back to default when custom type but no text", () => {
    const tmpl = resolveTemplate("custom", "");
    expect(tmpl.name).toBe("Default");
  });

  it("falls back to default when custom type but whitespace-only text", () => {
    const tmpl = resolveTemplate("custom", "   ");
    expect(tmpl.name).toBe("Default");
  });
});
