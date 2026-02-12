export interface DocTemplate {
  name: string;
  sections: string;
  maxWords: number;
  maxOutputTokens: number;
}

// ─── Section builders by object type ───

function classSections(detail: "default" | "minimal" | "detailed"): string {
  if (detail === "minimal") {
    return [
      "Generate concise documentation with these sections:",
      "1. **Overview** — one paragraph describing purpose and responsibility",
      "2. **Methods** — for each method (public, protected, private): brief description, parameters, return type, exceptions (use tables)",
    ].join("\n");
  }

  if (detail === "detailed") {
    return [
      "Generate comprehensive documentation with these sections:",
      "1. **Overview** — purpose, responsibility, and design rationale (1-2 paragraphs)",
      "2. **Methods** — for each method (public, protected, private):",
      "   - Description of what the method does and why",
      "   - Parameters (table: name, type, direction, description)",
      "   - Return type",
      "   - Exceptions raised",
      "   Group methods by visibility (PUBLIC, PROTECTED, PRIVATE).",
      "3. **Dependencies** — detailed explanation of each dependency: what it is, how it is used, and why",
      "4. **Where-Used** — where this object is used in the system, how callers use it, and in what context. Use the get_where_used tool to retrieve this information.",
      "5. **Error Handling** — exception classes raised, error scenarios, how callers should handle them",
      "6. **Notes** — design decisions, limitations, edge cases, migration notes",
    ].join("\n");
  }

  // default
  return [
    "Generate documentation with these sections:",
    "1. **Overview** — purpose and responsibility (1-2 paragraphs)",
    "2. **Methods** — for each method (public, protected, private):",
    "   - Description of what the method does",
    "   - Parameters (table: name, type, direction, description)",
    "   - Return type",
    "   - Exceptions raised",
    "   Group methods by visibility (PUBLIC, PROTECTED, PRIVATE).",
    "3. **Dependencies** — how each dependency is used and why",
    "4. **Where-Used** — where this object is used in the system, how and why. Use the get_where_used tool to retrieve this information.",
    "5. **Notes** — design decisions, limitations, edge cases",
  ].join("\n");
}

function reportSections(detail: "default" | "minimal" | "detailed"): string {
  if (detail === "minimal") {
    return [
      "Generate concise documentation with these sections:",
      "1. **Overview** — one paragraph describing purpose and responsibility",
      "2. **Logic** — step-by-step explanation of the program logic, broken into logical parts/blocks",
    ].join("\n");
  }

  if (detail === "detailed") {
    return [
      "Generate comprehensive documentation with these sections:",
      "1. **Overview** — purpose, responsibility, and design rationale (1-2 paragraphs)",
      "2. **Selection Screen** — describe selection screen parameters and their purpose (if applicable)",
      "3. **Logic** — step-by-step explanation of the program logic, broken into logical parts/blocks. For each part explain what it does, why, and how.",
      "4. **Subroutines / Function Modules** — for each FORM or function module: description, parameters, what it does",
      "5. **Dependencies** — detailed explanation of each dependency: what it is, how it is used, and why",
      "6. **Where-Used** — where this program/FM is called, how and in what context. Use the get_where_used tool to retrieve this information.",
      "7. **Notes** — design decisions, limitations, edge cases, migration notes",
    ].join("\n");
  }

  // default
  return [
    "Generate documentation with these sections:",
    "1. **Overview** — purpose and responsibility (1-2 paragraphs)",
    "2. **Logic** — step-by-step explanation of the program logic, broken into logical parts/blocks. For each part explain what it does and why.",
    "3. **Dependencies** — how each dependency is used and why",
    "4. **Where-Used** — where this program/FM is called, how and why. Use the get_where_used tool to retrieve this information.",
    "5. **Notes** — design decisions, limitations, edge cases",
  ].join("\n");
}

function cdsSections(detail: "default" | "minimal" | "detailed"): string {
  if (detail === "minimal") {
    return [
      "Generate concise documentation with these sections:",
      "1. **Overview** — one paragraph describing purpose and what data the view exposes",
      "2. **Definition** — fields with types, associations, parameters (if any), key annotations, and underlying data sources (tables/views)",
    ].join("\n");
  }

  if (detail === "detailed") {
    return [
      "Generate comprehensive documentation with these sections:",
      "1. **Overview** — purpose, what data it exposes, business context, and design rationale (1-2 paragraphs)",
      "2. **Definition** — describe in detail:",
      "   - Fields: name, type, description, calculated/aggregated fields",
      "   - Associations: relationships to other CDS views or tables, cardinality",
      "   - Parameters: input parameters and their purpose (if parameterized)",
      "   - Annotations: key annotations (OData, UI, Analytics, Search, ObjectModel) and their effect",
      "   - Data sources: underlying tables and views it selects from, join conditions",
      "3. **Where-Used** — what consumes this view (other CDS views, OData services, Fiori apps, ABAP programs). Use the get_where_used tool to retrieve this information.",
      "4. **Notes** — design decisions, limitations, performance considerations, access control",
    ].join("\n");
  }

  // default
  return [
    "Generate documentation with these sections:",
    "1. **Overview** — purpose and what data the view exposes (1-2 paragraphs)",
    "2. **Definition** — fields with types, associations, parameters (if any), key annotations, and underlying data sources (tables/views)",
    "3. **Where-Used** — what consumes this view. Use the get_where_used tool to retrieve this information.",
    "4. **Notes** — design decisions, limitations, edge cases",
  ].join("\n");
}

// ─── Detail-level configs ───

interface TemplateConfig {
  name: string;
  detail: "default" | "minimal" | "detailed";
  maxWords: number;
  maxOutputTokens: number;
}

const TEMPLATE_CONFIGS: Record<string, TemplateConfig> = {
  default: { name: "Default", detail: "default", maxWords: 3000, maxOutputTokens: 8192 },
  minimal: { name: "Minimal", detail: "minimal", maxWords: 1000, maxOutputTokens: 4096 },
  detailed: { name: "Detailed", detail: "detailed", maxWords: 5000, maxOutputTokens: 16384 },
};

type ObjectCategory = "class" | "report" | "cds";

function categorizeObjectType(objectType?: string): ObjectCategory {
  if (!objectType) return "class";
  const t = objectType.toUpperCase();
  if (t === "CLAS" || t === "INTF") return "class";
  if (t === "DDLS" || t === "DDLX" || t === "DCLS") return "cds";
  return "report";
}

/**
 * Resolves a template based on template type, custom text, and ABAP object type.
 * Object type determines which section structure to use (class vs report/FM).
 * Falls back to "default" when type is missing or unknown.
 */
export function resolveTemplate(
  templateType?: string,
  templateCustom?: string,
  objectType?: string,
): DocTemplate {
  if (templateType === "custom" && templateCustom && templateCustom.trim().length > 0) {
    return {
      name: "Custom",
      sections: templateCustom.trim(),
      maxWords: 3000,
      maxOutputTokens: 8192,
    };
  }

  const config = (templateType && TEMPLATE_CONFIGS[templateType])
    ? TEMPLATE_CONFIGS[templateType]
    : TEMPLATE_CONFIGS["default"];

  const category = categorizeObjectType(objectType);
  const sections = category === "class" ? classSections(config.detail)
    : category === "cds" ? cdsSections(config.detail)
    : reportSections(config.detail);

  return {
    name: config.name,
    sections,
    maxWords: config.maxWords,
    maxOutputTokens: config.maxOutputTokens,
  };
}
