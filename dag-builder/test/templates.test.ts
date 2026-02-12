import { describe, it, expect } from "vitest";
import { resolveTemplate } from "../src/templates";

describe("resolveTemplate — class/interface", () => {
  it("returns default template for classes when no type specified", () => {
    const tmpl = resolveTemplate(undefined, undefined, "CLAS");
    expect(tmpl.name).toBe("Default");
    expect(tmpl.maxOutputTokens).toBe(8192);
    expect(tmpl.maxWords).toBe(3000);
  });

  it("includes Methods section for classes", () => {
    const tmpl = resolveTemplate("default", undefined, "CLAS");
    expect(tmpl.sections).toContain("Methods");
    expect(tmpl.sections).toContain("public, protected, private");
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

  it("does not include Logic section for classes", () => {
    const tmpl = resolveTemplate("default", undefined, "CLAS");
    expect(tmpl.sections).not.toContain("Logic");
  });

  it("works for INTF type", () => {
    const tmpl = resolveTemplate("default", undefined, "INTF");
    expect(tmpl.sections).toContain("Methods");
  });

  it("minimal class template has only Overview and Methods", () => {
    const tmpl = resolveTemplate("minimal", undefined, "CLAS");
    expect(tmpl.name).toBe("Minimal");
    expect(tmpl.sections).toContain("Overview");
    expect(tmpl.sections).toContain("Methods");
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
  it("includes Logic section for reports", () => {
    const tmpl = resolveTemplate("default", undefined, "PROG");
    expect(tmpl.sections).toContain("Logic");
    expect(tmpl.sections).not.toContain("Methods");
  });

  it("includes Where-Used section for reports", () => {
    const tmpl = resolveTemplate("default", undefined, "FUGR");
    expect(tmpl.sections).toContain("Where-Used");
  });

  it("detailed report template includes Selection Screen and Subroutines", () => {
    const tmpl = resolveTemplate("detailed", undefined, "PROG");
    expect(tmpl.sections).toContain("Selection Screen");
    expect(tmpl.sections).toContain("Subroutines");
  });

  it("minimal report template has only Overview and Logic", () => {
    const tmpl = resolveTemplate("minimal", undefined, "FUGR");
    expect(tmpl.sections).toContain("Overview");
    expect(tmpl.sections).toContain("Logic");
    expect(tmpl.sections).not.toContain("Dependencies");
  });
});

describe("resolveTemplate — CDS view", () => {
  it("includes Definition section for DDLS", () => {
    const tmpl = resolveTemplate("default", undefined, "DDLS");
    expect(tmpl.sections).toContain("Definition");
    expect(tmpl.sections).toContain("Where-Used");
    expect(tmpl.sections).not.toContain("Methods");
    expect(tmpl.sections).not.toContain("Logic");
  });

  it("works for DDLX (metadata extension)", () => {
    const tmpl = resolveTemplate("default", undefined, "DDLX");
    expect(tmpl.sections).toContain("Definition");
  });

  it("works for DCLS (access control)", () => {
    const tmpl = resolveTemplate("default", undefined, "DCLS");
    expect(tmpl.sections).toContain("Definition");
  });

  it("minimal CDS template has Overview and Definition", () => {
    const tmpl = resolveTemplate("minimal", undefined, "DDLS");
    expect(tmpl.sections).toContain("Overview");
    expect(tmpl.sections).toContain("Definition");
    expect(tmpl.sections).not.toContain("Where-Used");
  });

  it("detailed CDS template includes annotations and data sources", () => {
    const tmpl = resolveTemplate("detailed", undefined, "DDLS");
    expect(tmpl.sections).toContain("Annotations");
    expect(tmpl.sections).toContain("Data sources");
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
    expect(tmpl.sections).toContain("Methods");
    expect(tmpl.sections).not.toContain("Logic");
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
