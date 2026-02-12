import { describe, it, expect } from "vitest";
import { AGENT_TOOLS, toOpenAITools, toGeminiTools } from "../src/tools";

describe("AGENT_TOOLS", () => {
  it("should have get_source and get_where_used tools", () => {
    const names = AGENT_TOOLS.map((t) => t.name);
    expect(names).toContain("get_source");
    expect(names).toContain("get_where_used");
  });

  it("should require object_name for both tools", () => {
    for (const tool of AGENT_TOOLS) {
      expect(tool.parameters.required).toContain("object_name");
      expect(tool.parameters.properties.object_name.type).toBe("string");
    }
  });
});

describe("toOpenAITools", () => {
  it("should produce correct OpenAI function calling format", () => {
    const result = toOpenAITools(AGENT_TOOLS);

    expect(result).toHaveLength(2);
    for (const tool of result) {
      expect(tool.type).toBe("function");
      expect(tool.function).toBeDefined();
      expect(tool.function.name).toBeDefined();
      expect(tool.function.description).toBeDefined();
      expect(tool.function.parameters.type).toBe("object");
      expect(tool.function.parameters.required).toContain("object_name");
    }
  });

  it("should preserve parameter types as lowercase", () => {
    const result = toOpenAITools(AGENT_TOOLS);
    expect(result[0].function.parameters.properties.object_name.type).toBe("string");
  });
});

describe("toGeminiTools", () => {
  it("should produce correct Gemini functionDeclarations format", () => {
    const result = toGeminiTools(AGENT_TOOLS);

    expect(result).toHaveLength(1);
    expect(result[0].functionDeclarations).toHaveLength(2);

    for (const decl of result[0].functionDeclarations) {
      expect(decl.name).toBeDefined();
      expect(decl.description).toBeDefined();
      expect(decl.parameters).toBeDefined();
    }
  });

  it("should uppercase type names for Gemini", () => {
    const result = toGeminiTools(AGENT_TOOLS);
    const params = result[0].functionDeclarations[0].parameters;

    expect(params.type).toBe("OBJECT");
    expect(params.properties.object_name.type).toBe("STRING");
  });
});
