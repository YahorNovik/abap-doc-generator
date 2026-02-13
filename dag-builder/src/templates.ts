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
      "Generate concise functional documentation with these sections:",
      "- **Overview** — what this class/interface does from a business perspective, what problem it solves",
      "- **Key Capabilities** — the main operations and behaviors it provides, described functionally (not a method-by-method API listing)",
    ].join("\n");
  }

  if (detail === "detailed") {
    return [
      "Generate comprehensive functional documentation with these sections:",
      "- **Overview** — what this class/interface does from a business perspective, what problem it solves, and its role in the application (1-2 paragraphs)",
      "- **Functional Logic** — describe the business logic and key operations this class provides. Group by functional area, not by method name. Explain the processing flow, business rules, and decision logic. Mention method names only when they represent a distinct functional step.",
      "- **Dependencies** — what other objects it relies on and what functional role each dependency plays in the overall logic",
      "- **Where-Used** — where this object is used in the system and for what functional purpose. Use the where-used data provided in the prompt.",
      "- **Error Handling** — what can go wrong, what business validations are performed, and how errors are communicated to callers",
      "- **Notes** (optional — omit if nothing noteworthy) — design decisions, business constraints, known limitations",
    ].join("\n");
  }

  // default
  return [
    "Generate functional documentation with these sections:",
    "- **Overview** — what this class/interface does from a business perspective, what problem it solves (1-2 paragraphs)",
    "- **Functional Logic** — describe the business logic and key operations. Group by functional area, not by method name. Explain the processing flow and business rules. Mention method names only when they represent a distinct functional step.",
    "- **Dependencies** — what other objects it relies on and what functional role each dependency plays",
    "- **Where-Used** — where this object is used and for what purpose. Use the where-used data provided in the prompt.",
    "- **Notes** (optional — omit if nothing noteworthy) — design decisions, limitations, edge cases",
  ].join("\n");
}

function reportSections(detail: "default" | "minimal" | "detailed"): string {
  if (detail === "minimal") {
    return [
      "Generate concise functional documentation with these sections:",
      "- **Overview** — what this program does from a business perspective, what problem it solves",
      "- **Processing Logic** — step-by-step explanation of the business logic, broken into functional steps",
    ].join("\n");
  }

  if (detail === "detailed") {
    return [
      "Generate comprehensive functional documentation with these sections:",
      "- **Overview** — what this program does from a business perspective, what problem it solves, and when/why it is run (1-2 paragraphs)",
      "- **Input** — selection screen parameters and their business meaning (if applicable)",
      "- **Processing Logic** — step-by-step explanation of the business logic, broken into functional steps. For each step explain what it does, what business rules apply, and what data is affected.",
      "- **Dependencies** — what other objects it relies on and what functional role each plays",
      "- **Where-Used** — where this program/FM is called and in what business context. Use the where-used data provided in the prompt.",
      "- **Notes** (optional — omit if nothing noteworthy) — design decisions, business constraints, known limitations",
    ].join("\n");
  }

  // default
  return [
    "Generate functional documentation with these sections:",
    "- **Overview** — what this program does from a business perspective, what problem it solves (1-2 paragraphs)",
    "- **Processing Logic** — step-by-step explanation of the business logic, broken into functional steps. For each step explain what it does and what business rules apply.",
    "- **Dependencies** — what other objects it relies on and what functional role each plays",
    "- **Where-Used** — where this program/FM is called and for what purpose. Use the where-used data provided in the prompt.",
    "- **Notes** (optional — omit if nothing noteworthy) — design decisions, limitations, edge cases",
  ].join("\n");
}

function cdsSections(detail: "default" | "minimal" | "detailed"): string {
  if (detail === "minimal") {
    return [
      "Generate concise functional documentation with these sections:",
      "- **Overview** — what business data this view exposes and for what purpose",
      "- **Data Model** — what data is provided, key fields, relationships to other entities, and underlying data sources",
    ].join("\n");
  }

  if (detail === "detailed") {
    return [
      "Generate comprehensive functional documentation with these sections:",
      "- **Overview** — what business data this view exposes, for what purpose, and its role in the application (1-2 paragraphs)",
      "- **Data Model** — what business data is provided, key fields and their business meaning, relationships to other entities, calculated/derived fields and their logic, parameters and their purpose, key annotations and their effect, underlying data sources",
      "- **Where-Used** — what consumes this view and for what business purpose (other CDS views, OData services, Fiori apps, reports). Use the where-used data provided in the prompt.",
      "- **Notes** (optional — omit if nothing noteworthy) — design decisions, performance considerations, access control, business constraints",
    ].join("\n");
  }

  // default
  return [
    "Generate functional documentation with these sections:",
    "- **Overview** — what business data this view exposes and for what purpose (1-2 paragraphs)",
    "- **Data Model** — what data is provided, key fields and their business meaning, relationships to other entities, and underlying data sources",
    "- **Where-Used** — what consumes this view and for what purpose. Use the where-used data provided in the prompt.",
    "- **Notes** (optional — omit if nothing noteworthy) — design decisions, limitations, edge cases",
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
