import {
  Registry,
  MemoryFile,
  ABAPObject,
  SyntaxLogic,
  ReferenceType,
  ISpaghettiScope,
  Config,
  Statements,
  Expressions,
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

  const depMap = new Map<string, ParsedDependency>();

  // 1. Collect scope-based references (OO, types, tables)
  collectScopeReferences(spaghetti, objectName, depMap);

  // 2. Collect AST-based references (CALL FUNCTION, PERFORM, SUBMIT)
  collectAstReferences(obj, objectName, depMap);

  return Array.from(depMap.values());
}

function findAbapObject(reg: Registry, objectName: string): ABAPObject | undefined {
  for (const obj of reg.getObjects()) {
    if (obj instanceof ABAPObject && obj.getName().toUpperCase() === objectName.toUpperCase()) {
      return obj;
    }
  }
  return undefined;
}

// ─── Scope-based reference collection (OO, types, tables) ───

function collectScopeReferences(
  spaghetti: ISpaghettiScope,
  selfName: string,
  depMap: Map<string, ParsedDependency>
): void {
  const top = spaghetti.getTop() as ScopeNode;
  traverseScope(top, selfName, depMap);
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

    getOrCreateDep(depMap, ooName, ref.extra?.ooType ?? inferTypeFromName(ooName));
    return;
  }

  // Method references
  if (refType === ReferenceType.MethodReference) {
    const ooName = ref.extra?.ooName;
    if (!ooName || ooName.toUpperCase() === selfName.toUpperCase()) return;

    const dep = getOrCreateDep(depMap, ooName, ref.extra?.ooType ?? inferTypeFromName(ooName));
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

    const dep = getOrCreateDep(depMap, ooName, ref.extra?.ooType ?? inferTypeFromName(ooName));
    if (!dep.members.some((m) => m.memberType === "constructor")) {
      dep.members.push({
        memberName: "CONSTRUCTOR",
        memberType: "constructor",
        line: ref.position.getStart().getRow(),
      });
    }
    return;
  }

  // Void type references — only keep those that look like class/interface names
  // (TYPE REF TO zcl_something, etc.). Skip data elements, table types, etc.
  if (refType === ReferenceType.VoidType) {
    const typeName = ref.extra?.ooName ?? ref.position.getName();
    if (!typeName || typeName.toUpperCase() === selfName.toUpperCase()) return;

    const upper = typeName.toUpperCase();
    // Skip interface component references (e.g. ZIF_FOO~TY_BAR)
    if (upper.includes("~")) return;
    // Determine type from name pattern: IF_ prefix → INTF, otherwise CLAS
    if (upper.match(/^[YZ]?IF_/) || upper.match(/^IF_/)) {
      getOrCreateDep(depMap, typeName, "INTF");
    } else if (upper.match(/^[YZ]?C[LX]_/) || upper.match(/^CL_/) || upper.match(/^CX_/)) {
      getOrCreateDep(depMap, typeName, "CLAS");
    }
    return;
  }

  // Table references
  if (refType === ReferenceType.TableReference || refType === ReferenceType.TableVoidReference) {
    const tableName = ref.position.getName();
    if (!tableName) return;

    getOrCreateDep(depMap, tableName, "TABL");
    return;
  }
}

// ─── AST-based reference collection (CALL FUNCTION, PERFORM, SUBMIT) ───

function collectAstReferences(
  obj: ABAPObject,
  selfName: string,
  depMap: Map<string, ParsedDependency>
): void {
  for (const file of obj.getABAPFiles()) {
    const structure = file.getStructure();
    if (!structure) continue;

    // CALL FUNCTION 'FM_NAME'
    for (const stmt of structure.findAllStatements(Statements.CallFunction)) {
      const nameExpr = stmt.findFirstExpression(Expressions.FunctionName);
      if (!nameExpr) continue;

      const constant = nameExpr.findFirstExpression(Expressions.Constant);
      if (!constant) continue; // skip dynamic calls

      const fmName = nameExpr.concatTokens().replace(/'/g, "").toUpperCase();
      if (!fmName || fmName === selfName.toUpperCase()) continue;

      const dep = getOrCreateDep(depMap, fmName, "FUGR");
      if (!dep.members.some((m) => m.memberName === fmName && m.memberType === "form")) {
        dep.members.push({
          memberName: fmName,
          memberType: "form",
          line: stmt.getStart().getRow(),
        });
      }
    }

    // PERFORM form_name IN PROGRAM program_name
    for (const stmt of structure.findAllStatements(Statements.Perform)) {
      // Only external PERFORMs (with IN PROGRAM or program name in parentheses)
      const includeName = stmt.findDirectExpression(Expressions.IncludeName);
      if (!includeName) continue;

      const progName = includeName.concatTokens().toUpperCase();
      if (!progName || progName === selfName.toUpperCase()) continue;

      const formExpr = stmt.findFirstExpression(Expressions.FormName);
      const formName = formExpr?.concatTokens().toUpperCase() ?? "UNKNOWN";

      const dep = getOrCreateDep(depMap, progName, "PROG");
      if (!dep.members.some((m) => m.memberName === formName && m.memberType === "form")) {
        dep.members.push({
          memberName: formName,
          memberType: "form",
          line: stmt.getStart().getRow(),
        });
      }
    }

    // SUBMIT program_name
    for (const stmt of structure.findAllStatements(Statements.Submit)) {
      const progExpr = stmt.findFirstExpression(Expressions.IncludeName);
      if (!progExpr) continue; // skip dynamic

      const progName = progExpr.concatTokens().toUpperCase();
      if (!progName || progName === selfName.toUpperCase()) continue;

      getOrCreateDep(depMap, progName, "PROG");
    }
  }
}

// ─── Helpers ───

function inferTypeFromName(name: string): string {
  const upper = name.toUpperCase();
  if (upper.match(/^[YZ]?IF_/) || upper.match(/^IF_/)) return "INTF";
  if (upper.match(/^[YZ]?C[LX]_/) || upper.match(/^CL_/) || upper.match(/^CX_/)) return "CLAS";
  return "CLAS";
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
    case "FUGR":
      return "FUGR";
    case "PROG":
      return "PROG";
    default:
      return "UNKNOWN";
  }
}
