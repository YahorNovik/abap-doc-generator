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
  CDSParser,
} from "@abaplint/core";
import { ParsedDependency, MemberReference } from "./types";

// Import CDS expression types for AST traversal
const CDSExpressions = require("@abaplint/core/build/src/cds/expressions");
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

const CDS_TYPES = new Set(["DDLS", "DDLX", "BDEF", "SRVD", "DCLS"]);

/**
 * Parses ABAP source code using abaplint and extracts external object dependencies
 * with member-level reference information.
 * For CDS-family objects (DDLS, DDLX, BDEF, SRVD, DCLS), uses pre-fetched ADT
 * CDS dependencies instead of abaplint parsing.
 */
export function extractDependencies(
  source: string,
  objectName: string,
  objectType: string,
): ParsedDependency[] {
  // CDS-family objects: parse with abaplint CDS parser or regex
  if (CDS_TYPES.has(objectType)) {
    return extractCdsFamilyDependencies(source, objectName, objectType);
  }
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

    getOrCreateDep(depMap, ooName, resolveOoType(ref.extra?.ooType, ooName));
    return;
  }

  // Method references
  if (refType === ReferenceType.MethodReference) {
    const ooName = ref.extra?.ooName;
    if (!ooName || ooName.toUpperCase() === selfName.toUpperCase()) return;

    const dep = getOrCreateDep(depMap, ooName, resolveOoType(ref.extra?.ooType, ooName));
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

    const dep = getOrCreateDep(depMap, ooName, resolveOoType(ref.extra?.ooType, ooName));
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

/** Resolve OO type: use abaplint's type if concrete, otherwise infer from name. */
function resolveOoType(ooType: string | undefined, name: string): string {
  if (ooType && ooType !== "Void") return ooType;
  return inferTypeFromName(name);
}

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

// ─── CDS family dependency extraction ───

/**
 * Extracts dependencies from CDS-family objects (DDLS, DDLX, BDEF, SRVD, DCLS).
 * Uses abaplint CDSParser for DDLS/DDLX, regex for BDEF/SRVD/DCLS.
 */
function extractCdsFamilyDependencies(
  source: string,
  objectName: string,
  objectType: string,
): ParsedDependency[] {
  switch (objectType) {
    case "DDLS":
      return extractDdlsDependencies(source, objectName);
    case "DDLX":
      return []; // Metadata extensions only add UI annotations — no data flow dependencies
    case "BDEF":
      return extractBdefDependencies(source, objectName);
    case "SRVD":
      return extractSrvdDependencies(source, objectName);
    case "DCLS":
      return extractDclsDependencies(source, objectName);
    default:
      return [];
  }
}

/** Helper to add a dependency to a map, avoiding duplicates. */
function addDep(
  depMap: Map<string, ParsedDependency>,
  name: string,
  objectType: string,
  memberName: string,
  memberType: MemberReference["memberType"],
): void {
  const key = name.toUpperCase();
  let dep = depMap.get(key);
  if (!dep) {
    dep = { objectName: key, objectType, members: [] };
    depMap.set(key, dep);
  }
  if (!dep.members.some((m) => m.memberName === memberName && m.memberType === memberType)) {
    dep.members.push({ memberName, memberType });
  }
}

/**
 * Extract entity name from a CDSSource or CDSRelation expression node.
 * CDSSource: CDSName [CDSParametersSelect] [CDSAs | CDSName]
 * CDSRelation: [/ns/] name [CDSAs]
 * The entity name is the first CDSName child's first token.
 */
function extractEntityName(node: any): string | undefined {
  // Try CDSName first child
  const cdsName = node.findDirectExpression?.(CDSExpressions.CDSName);
  if (cdsName) {
    return cdsName.concatTokens().replace(/^:/, "").toUpperCase();
  }
  // Fallback: first token
  try {
    return node.getFirstToken().getStr().toUpperCase();
  } catch {
    return undefined;
  }
}

/**
 * Parses DDLS (CDS view) source using abaplint's CDSParser.
 * Extracts: data sources (FROM), joins, associations, compositions, projections.
 */
function extractDdlsDependencies(source: string, objectName: string): ParsedDependency[] {
  const depMap = new Map<string, ParsedDependency>();
  const selfName = objectName.toUpperCase();

  const file = new MemoryFile("source.ddls.asddls", source);
  const parser = new CDSParser();
  const tree = parser.parse(file);
  if (!tree) return [];

  // Data sources (FROM clause) — works for regular CDS views
  const sources = tree.findAllExpressionsRecursive(CDSExpressions.CDSSource);
  for (const src of sources) {
    const name = extractEntityName(src);
    if (name && name !== selfName) {
      addDep(depMap, name, "DDLS", name, "datasource");
    }
  }

  // Projection source: "as projection on <entity>"
  // CDSDefineProjection uses CDSName directly, not CDSSource
  const projMatch = source.match(/as\s+projection\s+on\s+(\S+)/i);
  if (projMatch) {
    const name = projMatch[1].toUpperCase();
    if (name !== selfName) {
      addDep(depMap, name, "DDLS", name, "datasource");
    }
  }

  // Joins
  const joins = tree.findAllExpressionsRecursive(CDSExpressions.CDSJoin);
  for (const join of joins) {
    const joinSources = join.findAllExpressionsRecursive(CDSExpressions.CDSSource);
    for (const src of joinSources) {
      const name = extractEntityName(src);
      if (name && name !== selfName) {
        addDep(depMap, name, "DDLS", name, "datasource");
      }
    }
  }

  // Associations
  const associations = tree.findAllExpressionsRecursive(CDSExpressions.CDSAssociation);
  for (const assoc of associations) {
    const relation = assoc.findDirectExpression?.(CDSExpressions.CDSRelation);
    if (relation) {
      const name = extractEntityName(relation);
      if (name && name !== selfName) {
        const alias = relation.findDirectExpression?.(CDSExpressions.CDSAs);
        const aliasName = alias ? alias.concatTokens().replace(/^AS\s+/i, "").trim() : name;
        addDep(depMap, name, "DDLS", aliasName, "association");
      }
    }
  }

  // Compositions
  const compositions = tree.findAllExpressionsRecursive(CDSExpressions.CDSComposition);
  for (const comp of compositions) {
    const relation = comp.findDirectExpression?.(CDSExpressions.CDSRelation);
    if (relation) {
      const name = extractEntityName(relation);
      if (name && name !== selfName) {
        addDep(depMap, name, "DDLS", name, "association");
      }
    }
  }

  // Redirected compositions in projections: "redirected to composition child/parent <entity>"
  // These appear inside CDSElement nodes, not CDSComposition
  const redirectMatches = source.matchAll(/redirected\s+to\s+(?:composition\s+child|parent)\s+(\S+)/gi);
  for (const m of redirectMatches) {
    const name = m[1].toUpperCase();
    if (name !== selfName) {
      addDep(depMap, name, "DDLS", name, "association");
    }
  }

  return Array.from(depMap.values());
}

/**
 * Parses DDLX (metadata extension) source using abaplint's CDSParser.
 * Extracts: target view being annotated.
 */
function extractDdlxDependencies(source: string, objectName: string): ParsedDependency[] {
  const depMap = new Map<string, ParsedDependency>();
  const selfName = objectName.toUpperCase();

  const file = new MemoryFile("source.ddlx.asddlxs", source);
  const parser = new CDSParser();
  const tree = parser.parse(file);

  if (tree) {
    // CDSAnnotate: ANNOTATE (ENTITY|VIEW) CDSName WITH { ... }
    const cdsNames = tree.findAllExpressionsRecursive(CDSExpressions.CDSName);
    // The first CDSName after ANNOTATE ENTITY/VIEW is the target
    if (cdsNames.length > 0) {
      const name = cdsNames[0].concatTokens().replace(/^:/, "").toUpperCase();
      if (name && name !== selfName) {
        addDep(depMap, name, "DDLS", name, "datasource");
      }
    }
  } else {
    // Fallback: regex
    const match = source.match(/annotate\s+(?:view|entity)\s+(\S+)/i);
    if (match) {
      const name = match[1].toUpperCase();
      if (name !== selfName) {
        addDep(depMap, name, "DDLS", name, "datasource");
      }
    }
  }

  return Array.from(depMap.values());
}

/**
 * Parses BDEF (behavior definition) source using regex.
 * Extracts: implementation class, CDS entity references.
 */
function extractBdefDependencies(source: string, objectName: string): ParsedDependency[] {
  const depMap = new Map<string, ParsedDependency>();
  const selfName = objectName.toUpperCase();

  // implementation in class <class_name> [unique]
  const implMatches = source.matchAll(/implementation\s+in\s+class\s+(\S+)/gi);
  for (const m of implMatches) {
    const name = m[1].toUpperCase();
    if (name !== selfName) {
      addDep(depMap, name, "CLAS", name, "datasource");
    }
  }

  // define behavior for <entity_name>
  const behaviorMatches = source.matchAll(/define\s+behavior\s+for\s+(\S+)/gi);
  for (const m of behaviorMatches) {
    const name = m[1].toUpperCase();
    if (name !== selfName) {
      addDep(depMap, name, "DDLS", name, "association");
    }
  }

  // use draft; / with draft; references — extract draft table if present
  const draftMatches = source.matchAll(/draft\s+table\s+(\S+)/gi);
  for (const m of draftMatches) {
    const name = m[1].toUpperCase();
    if (name !== selfName) {
      addDep(depMap, name, "TABL", name, "datasource");
    }
  }

  // persistent table <table_name>
  const persistentMatches = source.matchAll(/persistent\s+table\s+(\S+)/gi);
  for (const m of persistentMatches) {
    const name = m[1].toUpperCase();
    if (name !== selfName) {
      addDep(depMap, name, "TABL", name, "datasource");
    }
  }

  return Array.from(depMap.values());
}

/**
 * Parses SRVD (service definition) source using regex.
 * Extracts: exposed CDS entities.
 */
function extractSrvdDependencies(source: string, objectName: string): ParsedDependency[] {
  const depMap = new Map<string, ParsedDependency>();
  const selfName = objectName.toUpperCase();

  // expose <entity_name> [as <alias>]
  const exposeMatches = source.matchAll(/expose\s+(\S+)/gi);
  for (const m of exposeMatches) {
    const name = m[1].toUpperCase();
    if (name !== selfName && name !== "AS") {
      addDep(depMap, name, "DDLS", name, "datasource");
    }
  }

  return Array.from(depMap.values());
}

/**
 * Parses DCLS (access control) source using regex.
 * Extracts: protected CDS entity.
 */
function extractDclsDependencies(source: string, objectName: string): ParsedDependency[] {
  const depMap = new Map<string, ParsedDependency>();
  const selfName = objectName.toUpperCase();

  // grant select on <entity_name>
  const grantMatches = source.matchAll(/grant\s+select\s+on\s+(\S+)/gi);
  for (const m of grantMatches) {
    const name = m[1].toUpperCase();
    if (name !== selfName) {
      addDep(depMap, name, "DDLS", name, "datasource");
    }
  }

  return Array.from(depMap.values());
}
