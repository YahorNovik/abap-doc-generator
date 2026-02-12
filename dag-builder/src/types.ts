export interface DagInput {
  systemUrl: string;
  client: string;
  username: string;
  password: string;
  objectName: string;
  objectType: string;
}

export interface DagNode {
  name: string;
  type: string;
  isCustom: boolean;
  sourceAvailable: boolean;
  usedBy: string[];
}

export interface MemberReference {
  memberName: string;
  memberType: "method" | "attribute" | "type" | "constant" | "event" | "constructor" | "form" | "unknown";
  line?: number;
}

export interface DagEdge {
  from: string;
  to: string;
  references: MemberReference[];
}

export interface DagResult {
  root: string;
  nodes: DagNode[];
  edges: DagEdge[];
  topologicalOrder: string[];
  errors: string[];
}

export interface ParsedDependency {
  objectName: string;
  objectType: string;
  members: MemberReference[];
}

// ─── LLM types ───

export interface LlmConfig {
  provider: "gemini" | "openai" | "openai-compatible";
  apiKey: string;
  model: string;
  baseUrl?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmResponse {
  content: string;
  usage: { promptTokens: number; completionTokens: number };
}

// ─── Doc generation types ───

export interface DocInput {
  command: "generate-doc";
  systemUrl: string;
  client: string;
  username: string;
  password: string;
  objectName: string;
  objectType: string;
  summaryLlm: LlmConfig;
  docLlm: LlmConfig;
}

export interface DocResult {
  objectName: string;
  documentation: string;
  summaries: Record<string, string>;
  tokenUsage: { summaryTokens: number; docTokens: number };
  errors: string[];
}
