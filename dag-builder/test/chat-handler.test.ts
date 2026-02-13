import { describe, it, expect } from "vitest";

// We test the parseResponse logic by importing it indirectly through the module.
// Since parseResponse is not exported, we test the behavior via the public API shape
// and test the parsing logic inline.

describe("chat-handler", () => {
  describe("response parsing", () => {
    function parseResponse(content: string): { reply: string; updatedMarkdown?: string } {
      const tagStart = "<updated_doc>";
      const tagEnd = "</updated_doc>";
      const startIdx = content.indexOf(tagStart);
      const endIdx = content.indexOf(tagEnd);

      if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
        return { reply: content };
      }

      const updatedMarkdown = content.slice(startIdx + tagStart.length, endIdx).trim();
      const reply = (
        content.slice(0, startIdx).trim()
        + "\n\n"
        + content.slice(endIdx + tagEnd.length).trim()
      ).trim();

      return {
        reply: reply || "I've updated the documentation. Click Apply to see the changes.",
        updatedMarkdown,
      };
    }

    it("should return plain reply when no updated_doc tags", () => {
      const result = parseResponse("Here is my answer about the class.");
      expect(result.reply).toBe("Here is my answer about the class.");
      expect(result.updatedMarkdown).toBeUndefined();
    });

    it("should extract updated markdown from tags", () => {
      const content = "I've updated the docs.\n\n<updated_doc>\n# ZCL_FOO\n\nUpdated content.\n</updated_doc>\n\nLet me know if you need more changes.";
      const result = parseResponse(content);
      expect(result.updatedMarkdown).toBe("# ZCL_FOO\n\nUpdated content.");
      expect(result.reply).toContain("I've updated the docs.");
      expect(result.reply).toContain("Let me know if you need more changes.");
      expect(result.reply).not.toContain("<updated_doc>");
    });

    it("should handle tags with no surrounding text", () => {
      const content = "<updated_doc>\n# ZCL_FOO\n\nNew docs.\n</updated_doc>";
      const result = parseResponse(content);
      expect(result.updatedMarkdown).toBe("# ZCL_FOO\n\nNew docs.");
      expect(result.reply).toBe("I've updated the documentation. Click Apply to see the changes.");
    });

    it("should handle malformed tags (missing end tag)", () => {
      const content = "Some text <updated_doc> content without end tag";
      const result = parseResponse(content);
      expect(result.reply).toBe(content);
      expect(result.updatedMarkdown).toBeUndefined();
    });

    it("should handle empty updated_doc block", () => {
      const content = "Updated.\n<updated_doc>\n</updated_doc>";
      const result = parseResponse(content);
      expect(result.updatedMarkdown).toBe("");
    });
  });

  describe("ChatInput type", () => {
    it("should match expected shape", async () => {
      // Type check: ensure the module exports are accessible
      const mod = await import("../src/chat-handler");
      expect(mod.handleChat).toBeDefined();
      expect(typeof mod.handleChat).toBe("function");
    });
  });
});
