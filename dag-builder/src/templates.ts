export interface DocTemplate {
  name: string;
  sections: string;
  maxWords: number;
  maxOutputTokens: number;
}

// ─── Package-level token limits ───

export const PACKAGE_OVERVIEW_MAX_TOKENS = 1024;
export const CLUSTER_SUMMARY_MAX_TOKENS = 4096;

// ─── Section builders by object type ───

function classSections(detail: "default" | "minimal" | "detailed"): string {
  if (detail === "minimal") {
    return [
      "Generate concise functional documentation. Only Overview is required — include Key Capabilities only if there is something meaningful to say:",
      "- **Overview** (required) — what this class/interface does from a business perspective, what problem it solves",
      "- **Key Capabilities** (include only if non-trivial) — the main operations and behaviors it provides, described functionally (not a method-by-method API listing)",
    ].join("\n");
  }

  if (detail === "detailed") {
    return [
      "Generate comprehensive functional documentation with these sections. Only Overview is required — omit any other section if there is nothing meaningful to say:",
      "- **Overview** (required) — what this class/interface does from a business perspective, what problem it solves, and its role in the application (1-2 paragraphs)",
      "- **Functional Logic** (include only if non-trivial) — describe the business logic and key operations this class provides. Group by functional area, not by method name. Explain the processing flow, business rules, and decision logic. Mention method names only when they represent a distinct functional step.",
      "- **Dependencies** (include only if dependencies exist) — what other objects it relies on and what functional role each dependency plays in the overall logic",
      "- **Where-Used** (include only if where-used data is available) — where this object is used in the system and for what functional purpose. Use the where-used data provided in the prompt.",
      "- **Error Handling** (include only if non-trivial) — what can go wrong, what business validations are performed, and how errors are communicated to callers",
      "- **Notes** (include only if noteworthy) — design decisions, business constraints, known limitations",
    ].join("\n");
  }

  // default
  return [
    "Generate functional documentation with these sections. Only Overview is required — omit any other section if there is nothing meaningful to say:",
    "- **Overview** (required) — what this class/interface does from a business perspective, what problem it solves (1-2 paragraphs)",
    "- **Functional Logic** (include only if non-trivial) — describe the business logic and key operations. Group by functional area, not by method name. Explain the processing flow and business rules. Mention method names only when they represent a distinct functional step.",
    "- **Dependencies** (include only if dependencies exist) — what other objects it relies on and what functional role each dependency plays",
    "- **Where-Used** (include only if where-used data is available) — where this object is used and for what purpose. Use the where-used data provided in the prompt.",
    "- **Notes** (include only if noteworthy) — design decisions, limitations, edge cases",
  ].join("\n");
}

function reportSections(detail: "default" | "minimal" | "detailed"): string {
  if (detail === "minimal") {
    return [
      "Generate concise functional documentation. Only Overview is required — include Processing Logic only if there is something meaningful to say:",
      "- **Overview** (required) — what this program does from a business perspective, what problem it solves",
      "- **Processing Logic** (include only if non-trivial) — step-by-step explanation of the business logic, broken into functional steps",
    ].join("\n");
  }

  if (detail === "detailed") {
    return [
      "Generate comprehensive functional documentation with these sections. Only Overview is required — omit any other section if there is nothing meaningful to say:",
      "- **Overview** (required) — what this program does from a business perspective, what problem it solves, and when/why it is run (1-2 paragraphs)",
      "- **Input** (include only if selection screen exists) — selection screen parameters and their business meaning",
      "- **Processing Logic** (include only if non-trivial) — step-by-step explanation of the business logic, broken into functional steps. For each step explain what it does, what business rules apply, and what data is affected.",
      "- **Dependencies** (include only if dependencies exist) — what other objects it relies on and what functional role each plays",
      "- **Where-Used** (include only if where-used data is available) — where this program/FM is called and in what business context. Use the where-used data provided in the prompt.",
      "- **Notes** (include only if noteworthy) — design decisions, business constraints, known limitations",
    ].join("\n");
  }

  // default
  return [
    "Generate functional documentation with these sections. Only Overview is required — omit any other section if there is nothing meaningful to say:",
    "- **Overview** (required) — what this program does from a business perspective, what problem it solves (1-2 paragraphs)",
    "- **Processing Logic** (include only if non-trivial) — step-by-step explanation of the business logic, broken into functional steps. For each step explain what it does and what business rules apply.",
    "- **Dependencies** (include only if dependencies exist) — what other objects it relies on and what functional role each plays",
    "- **Where-Used** (include only if where-used data is available) — where this program/FM is called and for what purpose. Use the where-used data provided in the prompt.",
    "- **Notes** (include only if noteworthy) — design decisions, limitations, edge cases",
  ].join("\n");
}

function cdsSections(detail: "default" | "minimal" | "detailed"): string {
  if (detail === "minimal") {
    return [
      "Generate concise functional documentation. Only Overview is required — include Data Model only if there is something meaningful to say:",
      "- **Overview** (required) — what business data this view exposes and for what purpose",
      "- **Data Model** (include only if non-trivial) — what data is provided, key fields, relationships to other entities, and underlying data sources",
    ].join("\n");
  }

  if (detail === "detailed") {
    return [
      "Generate comprehensive functional documentation with these sections. Only Overview is required — omit any other section if there is nothing meaningful to say:",
      "- **Overview** (required) — what business data this view exposes, for what purpose, and its role in the application (1-2 paragraphs)",
      "- **Data Model** (include only if non-trivial) — what business data is provided, key fields and their business meaning, relationships to other entities, calculated/derived fields and their logic, parameters and their purpose, key annotations and their effect, underlying data sources",
      "- **Where-Used** (include only if where-used data is available) — what consumes this view and for what business purpose (other CDS views, OData services, Fiori apps, reports). Use the where-used data provided in the prompt.",
      "- **Notes** (include only if noteworthy) — design decisions, performance considerations, access control, business constraints",
    ].join("\n");
  }

  // default
  return [
    "Generate functional documentation with these sections. Only Overview is required — omit any other section if there is nothing meaningful to say:",
    "- **Overview** (required) — what business data this view exposes and for what purpose (1-2 paragraphs)",
    "- **Data Model** (include only if non-trivial) — what data is provided, key fields and their business meaning, relationships to other entities, and underlying data sources",
    "- **Where-Used** (include only if where-used data is available) — what consumes this view and for what purpose. Use the where-used data provided in the prompt.",
    "- **Notes** (include only if noteworthy) — design decisions, limitations, edge cases",
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
  default: { name: "Default", detail: "default", maxWords: 800, maxOutputTokens: 4096 },
  minimal: { name: "Minimal", detail: "minimal", maxWords: 400, maxOutputTokens: 2048 },
  detailed: { name: "Detailed", detail: "detailed", maxWords: 1500, maxOutputTokens: 8192 },
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
 * Object type determines which section structure to use (class vs report/FM vs CDS).
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
