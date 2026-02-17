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
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];    // on assistant messages with tool calls
  toolCallId?: string;       // on tool result messages (role === "tool")
  name?: string;             // function name for tool results
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

  maxTotalTokens?: number;    // token budget for entire generation
  templateType?: "default" | "minimal" | "detailed" | "api-reference" | "custom";
  templateCustom?: string;    // user-provided template text (when templateType === "custom")
  templateMaxWords?: number;   // override maxWords for custom templates
  templateMaxOutputTokens?: number; // override maxOutputTokens for custom templates
  userContext?: string;        // additional context/notes from the user
}

export interface DocResult {
  objectName: string;
  documentation: string;
  html: string;
  summaries: Record<string, string>;
  tokenUsage: {
    summaryTokens: number;
    docTokens: number;
    totalTokens: number;
    agentIterations: number;
    toolCalls: number;
  };
  errors: string[];
}

// ─── Package documentation types ───

export interface ListObjectsInput {
  command: "list-package-objects";
  systemUrl: string;
  client: string;
  username: string;
  password: string;
  packageName: string;
  maxSubPackageDepth?: number;
}

export interface ListObjectsResult {
  packageName: string;
  objects: Array<{
    name: string;
    type: string;
    description: string;
    subPackage: string;
  }>;
  subPackages: string[];
  errors: string[];
}

export interface PackageDocInput {
  command: "generate-package-doc";
  systemUrl: string;
  client: string;
  username: string;
  password: string;
  packageName: string;
  summaryLlm: LlmConfig;
  docLlm: LlmConfig;

  maxTotalTokens?: number;
  templateType?: "default" | "minimal" | "detailed" | "custom";
  templateCustom?: string;
  templateMaxWords?: number;
  templateMaxOutputTokens?: number;
  userContext?: string;        // additional context/notes from the user
  maxSubPackageDepth?: number; // recursion depth for sub-packages (default 2)
  excludedObjects?: string[];  // object names to skip docs for (still in diagrams)

  // Phase 3 inputs — skip triage/summarization when provided from Phase 2
  fullDocObjects?: string[];                      // user-approved objects for full docs (skips triage)
  precomputedSummaries?: Record<string, string>;   // reuse summaries from triage phase
  precomputedClusterSummaries?: Record<string, string>;
  precomputedClusterAssignments?: Record<string, string[]>; // clusterName → objectNames
}

// ─── Triage types (Phase 2) ───

export interface TriageInput {
  command: "triage-package";
  systemUrl: string;
  client: string;
  username: string;
  password: string;
  packageName: string;
  summaryLlm: LlmConfig;
  maxSubPackageDepth?: number;
  excludedObjects?: string[];
}

export interface TriageResult {
  packageName: string;
  objects: Array<{
    name: string;
    type: string;
    summary: string;
    sourceLines: number;
    depCount: number;
    usedByCount: number;
    triageDecision: "full" | "summary";
    subPackage: string;
    clusterName: string;
  }>;
  clusters: Array<{
    name: string;
    summary: string;
    objectNames: string[];
    subPackage: string;
  }>;
  tokenUsage: {
    summaryTokens: number;
    clusterSummaryTokens: number;
    triageTokens: number;
  };
  errors: string[];
}

/** A node in the recursive package tree. */
export interface SubPackageNode {
  name: string;
  description: string;
  depth: number;
  objects: PackageObject[];
  children: SubPackageNode[];
}

export interface PackageObject {
  name: string;
  type: string;
  description: string;
  uri: string;
}

export interface PackageGraph {
  objects: PackageObject[];
  internalEdges: DagEdge[];
  externalDependencies: Array<{
    from: string;
    to: string;
    toType: string;
    references: MemberReference[];
  }>;
}

export interface Cluster {
  id: number;
  name: string;
  objects: PackageObject[];
  internalEdges: DagEdge[];
  topologicalOrder: string[];
}

export interface PackageDocResult {
  packageName: string;
  documentation: string;
  singlePageHtml: string;
  pages: Record<string, string>;
  objectCount: number;
  clusterCount: number;
  subPackageCount?: number;
  summaries: Record<string, string>;
  clusterSummaries: Record<string, string>;
  objectDocs: Record<string, string>;
  tokenUsage: {
    summaryTokens: number;
    objectDocTokens: number;
    clusterSummaryTokens: number;
    overviewTokens: number;
    totalTokens: number;
  };
  errors: string[];
}

// ─── Agent / Tool types ───

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required: string[];
  };
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

export type ToolExecutor = (toolCall: ToolCall) => Promise<string>;

// ─── Batch types ───

export interface BatchRequest {
  id: string;
  messages: LlmMessage[];
}

export interface BatchStatus {
  id: string;
  state: "pending" | "running" | "completed" | "failed";
  completedCount: number;
  totalCount: number;
  outputFileId?: string;
}
