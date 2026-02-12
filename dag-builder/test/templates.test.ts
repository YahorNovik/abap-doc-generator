import { describe, it, expect } from "vitest";
import { TEMPLATES, resolveTemplate } from "../src/templates";

describe("TEMPLATES", () => {
  it("has all four predefined templates", () => {
    expect(Object.keys(TEMPLATES)).toEqual(["default", "minimal", "detailed", "api-reference"]);
  });

  it("each template has required fields", () => {
    for (const [key, tmpl] of Object.entries(TEMPLATES)) {
      expect(tmpl.name, `${key}.name`).toBeTruthy();
      expect(tmpl.sections, `${key}.sections`).toBeTruthy();
      expect(tmpl.maxWords, `${key}.maxWords`).toBeGreaterThan(0);
      expect(tmpl.maxOutputTokens, `${key}.maxOutputTokens`).toBeGreaterThanOrEqual(4096);
    }
  });

  it("default template has 5 sections", () => {
    const sections = TEMPLATES["default"].sections;
    expect(sections).toContain("Overview");
    expect(sections).toContain("Public API");
    expect(sections).toContain("Dependencies");
    expect(sections).toContain("Usage Examples");
    expect(sections).toContain("Notes");
  });

  it("minimal template has 2 sections", () => {
    const sections = TEMPLATES["minimal"].sections;
    expect(sections).toContain("Overview");
    expect(sections).toContain("Public API");
    expect(sections).not.toContain("Dependencies");
  });
});

describe("resolveTemplate", () => {
  it("returns default template when no type specified", () => {
    const tmpl = resolveTemplate();
    expect(tmpl.name).toBe("Default");
    expect(tmpl.maxOutputTokens).toBe(8192);
  });

  it("returns default template for undefined type", () => {
    const tmpl = resolveTemplate(undefined);
    expect(tmpl.name).toBe("Default");
  });

  it("returns default template for empty string", () => {
    const tmpl = resolveTemplate("");
    expect(tmpl.name).toBe("Default");
  });

  it("returns default template for unknown type", () => {
    const tmpl = resolveTemplate("nonexistent");
    expect(tmpl.name).toBe("Default");
  });

  it("returns minimal template", () => {
    const tmpl = resolveTemplate("minimal");
    expect(tmpl.name).toBe("Minimal");
    expect(tmpl.maxWords).toBe(1000);
    expect(tmpl.maxOutputTokens).toBe(4096);
  });

  it("returns detailed template", () => {
    const tmpl = resolveTemplate("detailed");
    expect(tmpl.name).toBe("Detailed");
    expect(tmpl.maxWords).toBe(5000);
    expect(tmpl.maxOutputTokens).toBe(16384);
  });

  it("returns api-reference template", () => {
    const tmpl = resolveTemplate("api-reference");
    expect(tmpl.name).toBe("API Reference");
    expect(tmpl.maxWords).toBe(2000);
  });

  it("returns custom template with user text", () => {
    const tmpl = resolveTemplate("custom", "My custom sections:\n1. Summary\n2. API");
    expect(tmpl.name).toBe("Custom");
    expect(tmpl.sections).toBe("My custom sections:\n1. Summary\n2. API");
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
