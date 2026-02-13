import { AdtClientWrapper } from "./adt-client";
import { extractDependencies } from "./abap-parser";
import { isCustomObject } from "./classifier";
import { UnionFind } from "./union-find";
import { PackageObject, PackageGraph, Cluster, DagEdge, DagNode } from "./types";

const RELEVANT_TYPES = new Set([
  "CLAS", "INTF", "PROG", "FUGR",
  "TABL", "DDLS", "DCLS", "DDLX", "BDEF", "SRVD",
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

  return contents
    .filter((obj) => {
      const type = obj.objectType.split("/")[0];
      return RELEVANT_TYPES.has(type) && isCustomObject(obj.objectName);
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
