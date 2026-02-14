import { AdtClientWrapper } from "./adt-client";
import { extractDependencies } from "./abap-parser";
import { isCustomObject } from "./classifier";
import { UnionFind } from "./union-find";
import { PackageObject, PackageGraph, Cluster, DagEdge, DagNode, SubPackageNode } from "./types";

const RELEVANT_TYPES = new Set([
  "CLAS", "INTF", "PROG", "FUGR",
  "TABL", "DDLS", "VIEW",
  "DTEL", "DOMA", "TTYP", "TYPE",
  "DCLS", "DDLX", "BDEF", "SRVD",
  "ENHO", "ENHS",
  "XSLT",
  "MSAG", "TRAN",
]);

/**
 * Fetches package contents from ADT and filters to relevant custom objects.
 */
export async function fetchPackageObjects(
  client: AdtClientWrapper,
  packageName: string,
  errors: string[],
): Promise<PackageObject[]> {
  const contents = await client.getPackageContents(packageName);

  // Exclude sub-package programs (DEVC objects that also appear as PROG)
  const subPackageNames = new Set(
    contents.filter((o) => o.objectType.split("/")[0] === "DEVC")
      .map((o) => o.objectName.toUpperCase()),
  );

  return contents
    .filter((obj) => {
      const type = obj.objectType.split("/")[0];
      const nameUpper = obj.objectName.toUpperCase();
      return RELEVANT_TYPES.has(type) && isCustomObject(obj.objectName)
        && !subPackageNames.has(nameUpper)
        && nameUpper !== packageName.toUpperCase();
    })
    .map((obj) => ({
      name: obj.objectName.toUpperCase(),
      type: obj.objectType.split("/")[0],
      description: obj.description,
      uri: obj.objectUri,
    }));
}

/**
 * Builds the package-internal dependency graph.
 * For each object, parses source to find dependencies,
 * keeps edges where both endpoints are in the package.
 */
export function buildPackageGraph(
  objects: PackageObject[],
  sources: Map<string, string>,
  errors: string[],
): PackageGraph {
  const objectNames = new Set(objects.map((o) => o.name));
  const internalEdges: DagEdge[] = [];
  const externalDependencies: PackageGraph["externalDependencies"] = [];

  for (const obj of objects) {
    const source = sources.get(obj.name);
    if (!source) continue;

    let deps;
    try {
      deps = extractDependencies(source, obj.name, obj.type);
    } catch (err) {
      errors.push(`Failed to parse dependencies for ${obj.name}: ${String(err)}`);
      continue;
    }

    for (const dep of deps) {
      const depName = dep.objectName.toUpperCase();
      if (depName.includes("~")) continue;
      if (depName === obj.name) continue;

      if (objectNames.has(depName)) {
        internalEdges.push({
          from: obj.name,
          to: depName,
          references: dep.members,
        });
      } else {
        externalDependencies.push({
          from: obj.name,
          to: depName,
          toType: dep.objectType,
          references: dep.members,
        });
      }
    }
  }

  return { objects, internalEdges, externalDependencies };
}

/**
 * Detects connected components using Union-Find.
 * Returns clusters with internal edges and topological order.
 * Singletons (no internal connections) are grouped into a "Standalone Objects" cluster.
 */
export function detectClusters(graph: PackageGraph): Cluster[] {
  const names = graph.objects.map((o) => o.name);
  const uf = new UnionFind(names);

  for (const edge of graph.internalEdges) {
    uf.union(edge.from, edge.to);
  }

  const components = uf.getComponents();
  const objectMap = new Map(graph.objects.map((o) => [o.name, o]));
  const clusters: Cluster[] = [];
  const singletons: PackageObject[] = [];
  let clusterId = 0;

  for (const [, members] of components) {
    const clusterObjects = members.map((m) => objectMap.get(m)!).filter(Boolean);

    // Check if this is a singleton with no internal edges
    if (clusterObjects.length === 1) {
      const name = clusterObjects[0].name;
      const hasEdges = graph.internalEdges.some((e) => e.from === name || e.to === name);
      if (!hasEdges) {
        singletons.push(clusterObjects[0]);
        continue;
      }
    }

    const memberSet = new Set(members);
    const clusterEdges = graph.internalEdges.filter(
      (e) => memberSet.has(e.from) && memberSet.has(e.to),
    );

    const topoOrder = topologicalSortCluster(clusterObjects, clusterEdges);

    clusters.push({
      id: clusterId++,
      name: "",
      objects: clusterObjects,
      internalEdges: clusterEdges,
      topologicalOrder: topoOrder,
    });
  }

  if (singletons.length > 0) {
    clusters.push({
      id: clusterId,
      name: "Standalone Objects",
      objects: singletons,
      internalEdges: [],
      topologicalOrder: singletons.map((s) => s.name),
    });
  }

  return clusters;
}

function pkgLog(msg: string): void {
  process.stderr.write(`[package-doc] ${msg}\n`);
}

/** Wraps a promise with a timeout. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * Recursively discovers the package hierarchy by fetching sub-packages (DEVC type)
 * from ADT nodeContents. Returns a tree rooted at the given package.
 */
export async function discoverPackageTree(
  client: AdtClientWrapper,
  packageName: string,
  maxDepth: number,
  errors: string[],
  currentDepth: number = 0,
): Promise<SubPackageNode> {
  pkgLog(`  Fetching contents of ${packageName}...`);
  const contents = await withTimeout(
    client.getPackageContents(packageName),
    30_000,
    `getPackageContents(${packageName})`,
  );
  pkgLog(`  ${packageName}: ${contents.length} entries returned.`);

  // Separate sub-packages from code objects
  const subPackageEntries = contents.filter(
    (obj) => obj.objectType.split("/")[0] === "DEVC" && isCustomObject(obj.objectName),
  );
  const subPackageNames = new Set(subPackageEntries.map((sp) => sp.objectName.toUpperCase()));

  const objects = contents
    .filter((obj) => {
      const type = obj.objectType.split("/")[0];
      const nameUpper = obj.objectName.toUpperCase();
      return RELEVANT_TYPES.has(type) && isCustomObject(obj.objectName)
        && !subPackageNames.has(nameUpper)
        && nameUpper !== packageName.toUpperCase(); // exclude package's own internal program
    })
    .map((obj) => ({
      name: obj.objectName.toUpperCase(),
      type: obj.objectType.split("/")[0],
      description: obj.description,
      uri: obj.objectUri,
    }));

  pkgLog(`  ${packageName}: ${objects.length} objects, ${subPackageEntries.length} sub-packages.`);

  // Recurse into sub-packages if within depth limit
  const children: SubPackageNode[] = [];
  if (currentDepth < maxDepth && subPackageEntries.length > 0) {
    for (const sp of subPackageEntries) {
      pkgLog(`  Recursing into sub-package ${sp.objectName}...`);
      try {
        const child = await discoverPackageTree(
          client, sp.objectName.toUpperCase(), maxDepth, errors, currentDepth + 1,
        );
        child.description = sp.description;
        children.push(child);
      } catch (err) {
        errors.push(`Failed to fetch sub-package ${sp.objectName}: ${String(err)}`);
        pkgLog(`  WARN: Sub-package ${sp.objectName} failed: ${String(err)}`);
      }
    }
  } else if (subPackageEntries.length > 0) {
    errors.push(
      `Sub-packages of ${packageName} skipped (depth limit ${maxDepth}): `
      + subPackageEntries.map((sp) => sp.objectName).join(", "),
    );
  }

  return {
    name: packageName,
    description: "",
    depth: currentDepth,
    objects,
    children,
  };
}

/**
 * Lightweight discovery: discovers the package tree and returns a flat object list
 * with sub-package attribution. No source fetching, no LLM calls.
 */
export async function listPackageObjects(
  client: AdtClientWrapper,
  packageName: string,
  maxDepth: number,
): Promise<{ objects: Array<{ name: string; type: string; description: string; subPackage: string }>;
             subPackages: string[];
             errors: string[] }> {
  const errors: string[] = [];

  pkgLog(`Discovering package tree for ${packageName} (max depth: ${maxDepth})...`);
  const tree = await discoverPackageTree(client, packageName, maxDepth, errors);
  const allNodes = flattenPackageTree(tree);

  const objects: Array<{ name: string; type: string; description: string; subPackage: string }> = [];
  const subPackages: string[] = [];

  for (const node of allNodes) {
    if (node.depth > 0 && node.objects.length > 0) {
      subPackages.push(node.name);
    }
    const subPkgLabel = node.depth === 0 ? "" : node.name;
    for (const obj of node.objects) {
      objects.push({
        name: obj.name,
        type: obj.type,
        description: obj.description,
        subPackage: subPkgLabel,
      });
    }
  }

  pkgLog(`Total: ${objects.length} objects across ${allNodes.length} package(s).`);
  return { objects, subPackages, errors };
}

/** Flattens a package tree into BFS order. */
export function flattenPackageTree(root: SubPackageNode): SubPackageNode[] {
  const result: SubPackageNode[] = [];
  const queue: SubPackageNode[] = [root];
  while (queue.length > 0) {
    const node = queue.shift()!;
    result.push(node);
    queue.push(...node.children);
  }
  return result;
}

/**
 * Kahn's algorithm for topological sort within a cluster.
 * Returns nodes in bottom-up order (leaves first).
 */
function topologicalSortCluster(objects: PackageObject[], edges: DagEdge[]): string[] {
  const nodeNames = new Set(objects.map((o) => o.name));
  const reverseInDegree = new Map<string, number>();
  const reverseAdj = new Map<string, string[]>();

  for (const name of nodeNames) {
    reverseInDegree.set(name, 0);
    reverseAdj.set(name, []);
  }

  for (const edge of edges) {
    if (nodeNames.has(edge.from) && nodeNames.has(edge.to)) {
      reverseAdj.get(edge.to)!.push(edge.from);
      reverseInDegree.set(edge.from, (reverseInDegree.get(edge.from) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const [name, degree] of reverseInDegree.entries()) {
    if (degree === 0) queue.push(name);
  }

  const result: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    result.push(current);
    for (const neighbor of reverseAdj.get(current) ?? []) {
      const newDegree = (reverseInDegree.get(neighbor) ?? 1) - 1;
      reverseInDegree.set(neighbor, newDegree);
      if (newDegree === 0) queue.push(neighbor);
    }
  }

  // Add any remaining nodes (cycle handling)
  for (const name of nodeNames) {
    if (!result.includes(name)) result.push(name);
  }

  return result;
}
