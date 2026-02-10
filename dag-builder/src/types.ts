export interface DagInput {
  systemUrl: string;
  client: string;
  username: string;
  password: string;
  objectName: string;
  objectType: AbapObjectType;
}

export type AbapObjectType = "CLAS" | "INTF" | "PROG" | "FUGR";

export interface DagNode {
  name: string;
  type: string;
  isCustom: boolean;
  source: string;
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
