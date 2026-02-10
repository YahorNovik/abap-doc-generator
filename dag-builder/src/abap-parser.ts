import {
  Registry,
  MemoryFile,
  ABAPObject,
  SyntaxLogic,
  ReferenceType,
  ISpaghettiScope,
  Config,
} from "@abaplint/core";
import { ParsedDependency, MemberReference } from "./types";
import { buildAbapGitFilename } from "./classifier";

interface ScopeNode {
  getData(): {
    references: Array<{
      position: { getName(): string; getStart(): { getRow(): number } };
      resolved: { getName(): string } | undefined;
      referenceType: ReferenceType;
      extra?: { ooName?: string; ooType?: "CLAS" | "INTF" | "Void" };
    }>;
  };
  getChildren(): ScopeNode[];
}

// Configure abaplint to treat ALL unknown objects as void (not errors).
// By setting errorNamespace to a pattern that matches nothing,
// all unresolved references become void references with extractable names.
const ABAPLINT_CONFIG = JSON.stringify({
  global: { files: "/src/**/*.*" },
  syntax: { version: "v758", errorNamespace: "^$" },
  rules: {},
});

/**
 * Parses ABAP source code using abaplint and extracts external object dependencies
 * with member-level reference information.
 */
export function extractDependencies(
  source: string,
  objectName: string,
  objectType: string
): ParsedDependency[] {
  const filename = buildAbapGitFilename(objectName, objectType);
  const file = new MemoryFile(filename, source);

  const conf = new Config(ABAPLINT_CONFIG);
  const reg = new Registry(conf);
  reg.addFile(file);
  reg.parse();

  const obj = findAbapObject(reg, objectName);
  if (!obj) {
    return [];
  }

  const syntaxResult = new SyntaxLogic(reg, obj).run();
  const spaghetti: ISpaghettiScope = syntaxResult.spaghetti;

  return collectDependencies(spaghetti, objectName);
}

function findAbapObject(reg: Registry, objectName: string): ABAPObject | undefined {
  for (const obj of reg.getObjects()) {
    if (obj instanceof ABAPObject && obj.getName().toUpperCase() === objectName.toUpperCase()) {
      return obj;
    }
  }
  return undefined;
}

function collectDependencies(
  spaghetti: ISpaghettiScope,
  selfName: string
): ParsedDependency[] {
  const depMap = new Map<string, ParsedDependency>();
  const top = spaghetti.getTop() as ScopeNode;

  traverseScope(top, selfName, depMap);

  return Array.from(depMap.values());
}

function traverseScope(
  node: ScopeNode,
  selfName: string,
  depMap: Map<string, ParsedDependency>
): void {
  const data = node.getData();
  for (const ref of data.references) {
    processReference(ref, selfName, depMap);
  }
  for (const child of node.getChildren()) {
    traverseScope(child, selfName, depMap);
  }
}

function processReference(
  ref: {
    position: { getName(): string; getStart(): { getRow(): number } };
    resolved: { getName(): string } | undefined;
    referenceType: ReferenceType;
    extra?: { ooName?: string; ooType?: "CLAS" | "INTF" | "Void" };
  },
  selfName: string,
  depMap: Map<string, ParsedDependency>
): void {
  const refType = ref.referenceType;

  // Object-oriented references (TYPE REF TO, CREATE OBJECT, static calls, etc.)
  if (
    refType === ReferenceType.ObjectOrientedReference ||
    refType === ReferenceType.ObjectOrientedVoidReference
  ) {
    const ooName = ref.extra?.ooName;
    if (!ooName || ooName.toUpperCase() === selfName.toUpperCase()) return;

    const dep = getOrCreateDep(depMap, ooName, ref.extra?.ooType ?? "Void");
    return;
  }

  // Method references
  if (refType === ReferenceType.MethodReference) {
    const ooName = ref.extra?.ooName;
    if (!ooName || ooName.toUpperCase() === selfName.toUpperCase()) return;

    const dep = getOrCreateDep(depMap, ooName, ref.extra?.ooType ?? "Void");
    const memberName = ref.position.getName();
    if (memberName && !dep.members.some((m) => m.memberName === memberName && m.memberType === "method")) {
      dep.members.push({
        memberName,
        memberType: "method",
        line: ref.position.getStart().getRow(),
      });
    }
    return;
  }

  // Constructor references
  if (refType === ReferenceType.ConstructorReference) {
    const ooName = ref.extra?.ooName;
    if (!ooName || ooName.toUpperCase() === selfName.toUpperCase()) return;

    const dep = getOrCreateDep(depMap, ooName, ref.extra?.ooType ?? "Void");
    if (!dep.members.some((m) => m.memberType === "constructor")) {
      dep.members.push({
        memberName: "CONSTRUCTOR",
        memberType: "constructor",
        line: ref.position.getStart().getRow(),
      });
    }
    return;
  }

  // Type references (resolved)
  if (refType === ReferenceType.TypeReference) {
    const ooName = ref.extra?.ooName;
    if (!ooName || ooName.toUpperCase() === selfName.toUpperCase()) return;

    const dep = getOrCreateDep(depMap, ooName, ref.extra?.ooType ?? "Void");
    const memberName = ref.position.getName();
    if (memberName && !dep.members.some((m) => m.memberName === memberName && m.memberType === "type")) {
      dep.members.push({
        memberName,
        memberType: "type",
        line: ref.position.getStart().getRow(),
      });
    }
    return;
  }

  // Void type references (TYPE REF TO unknown_class, TYPE unknown_table, etc.)
  // These don't have ooName set — the position name IS the type name
  if (refType === ReferenceType.VoidType) {
    const typeName = ref.extra?.ooName ?? ref.position.getName();
    if (!typeName || typeName.toUpperCase() === selfName.toUpperCase()) return;

    getOrCreateDep(depMap, typeName, ref.extra?.ooType ?? "Void");
    return;
  }

  // Table references
  if (refType === ReferenceType.TableReference || refType === ReferenceType.TableVoidReference) {
    const tableName = ref.position.getName();
    if (!tableName) return;

    const dep = getOrCreateDep(depMap, tableName, "TABL");
    return;
  }
}

function getOrCreateDep(
  depMap: Map<string, ParsedDependency>,
  name: string,
  ooType: string
): ParsedDependency {
  const key = name.toUpperCase();
  let dep = depMap.get(key);
  if (!dep) {
    dep = {
      objectName: key,
      objectType: mapOoType(ooType),
      members: [],
    };
    depMap.set(key, dep);
  }
  return dep;
}

function mapOoType(ooType: string): string {
  switch (ooType) {
    case "CLAS":
      return "CLAS";
    case "INTF":
      return "INTF";
    case "TABL":
      return "TABL";
    default:
      return "UNKNOWN";
  }
}
