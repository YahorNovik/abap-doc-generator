export interface DocTemplate {
  name: string;
  sections: string;
  maxWords: number;
  maxOutputTokens: number;
}

export const TEMPLATES: Record<string, DocTemplate> = {
  default: {
    name: "Default",
    sections: [
      "Generate documentation with these sections:",
      "1. **Overview** — purpose and responsibility (1-2 paragraphs)",
      "2. **Public API** — methods with parameters, return types, and exceptions (use tables)",
      "3. **Dependencies** — how each dependency is used and why",
      "4. **Usage Examples** — typical ABAP calling patterns",
      "5. **Notes** — design decisions, limitations, edge cases",
    ].join("\n"),
    maxWords: 3000,
    maxOutputTokens: 8192,
  },

  minimal: {
    name: "Minimal",
    sections: [
      "Generate concise documentation with these sections:",
      "1. **Overview** — one paragraph describing purpose and responsibility",
      "2. **Public API** — method signatures with brief descriptions (use a table)",
    ].join("\n"),
    maxWords: 1000,
    maxOutputTokens: 4096,
  },

  detailed: {
    name: "Detailed",
    sections: [
      "Generate comprehensive documentation with these sections:",
      "1. **Overview** — purpose, responsibility, and design rationale",
      "2. **Architecture** — class structure, inheritance, design patterns used",
      "3. **Public API** — methods with parameters, return types, and exceptions (use tables)",
      "4. **Internal Implementation** — key private/protected methods and their role",
      "5. **Dependencies** — detailed explanation of each dependency interaction",
      "6. **Error Handling** — exceptions raised, error scenarios, recovery patterns",
      "7. **Usage Examples** — typical ABAP calling patterns with full code samples",
      "8. **Configuration** — customization points, constants, configuration options",
      "9. **Notes** — design decisions, limitations, edge cases, migration notes",
    ].join("\n"),
    maxWords: 5000,
    maxOutputTokens: 16384,
  },

  "api-reference": {
    name: "API Reference",
    sections: [
      "Generate API reference documentation with these sections:",
      "1. **Overview** — one paragraph describing purpose",
      "2. **Types** — public type definitions (table: name, type, description)",
      "3. **Constants** — public constants (table: name, value, description)",
      "4. **Methods** — for each public method:",
      "   - Signature",
      "   - Parameters (table: name, type, optional, description)",
      "   - Return type",
      "   - Exceptions",
      "   - Brief description",
      "5. **Events** — if applicable",
      "",
      "Use table format wherever possible. Keep prose minimal.",
    ].join("\n"),
    maxWords: 2000,
    maxOutputTokens: 8192,
  },
};

/**
 * Resolves a template from the type name and optional custom text.
 * Falls back to "default" when type is missing or unknown.
 */
export function resolveTemplate(templateType?: string, templateCustom?: string): DocTemplate {
  if (templateType === "custom" && templateCustom && templateCustom.trim().length > 0) {
    return {
      name: "Custom",
      sections: templateCustom.trim(),
      maxWords: 3000,
      maxOutputTokens: 8192,
    };
  }

  if (templateType && TEMPLATES[templateType]) {
    return TEMPLATES[templateType];
  }

  return TEMPLATES["default"];
}
