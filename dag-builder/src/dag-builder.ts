import { AdtClientWrapper } from "./adt-client";
import { extractDependencies } from "./abap-parser";
import { isCustomObject } from "./classifier";
import { DagInput, DagResult, DagNode, DagEdge, AbapObjectType, ParsedDependency } from "./types";

/**
 * Builds a dependency DAG for an ABAP object by:
 * 1. Fetching the target object's source via ADT REST
 * 2. Parsing it with abaplint to find dependencies
 * 3. Recursively traversing custom (Z/Y) dependencies
 * 4. Fetching source for standard dependencies (depth 1) without further traversal
 */
export async function buildDag(input: DagInput): Promise<DagResult> {
  const client = new AdtClientWrapper(input.systemUrl, input.username, input.password, input.client);
  const errors: string[] = [];

  try {
    await client.connect();
    const result = await traverse(client, input.objectName, input.objectType, errors);
    return result;
  } finally {
    try {
      await client.disconnect();
    } catch {
      // ignore disconnect errors
    }
  }
}

async function traverse(
  client: AdtClientWrapper,
  rootName: string,
  rootType: AbapObjectType,
  errors: string[]
): Promise<DagResult> {
  const nodes = new Map<string, DagNode>();
  const edges: DagEdge[] = [];
  const visited = new Set<string>();
  const queue: Array<{ name: string; type: AbapObjectType }> = [{ name: rootName, type: rootType }];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const key = current.name.toUpperCase();

    if (visited.has(key)) continue;
    visited.add(key);

    let source: string;
    try {
      source = await client.fetchSource(current.name, current.type);
    } catch (err) {
      errors.push(`Failed to fetch source for ${current.name}: ${String(err)}`);
      continue;
    }

    // Add node
    nodes.set(key, {
      name: key,
      type: current.type,
      isCustom: isCustomObject(current.name),
      source,
      usedBy: [],
    });

    // Parse dependencies
    let deps: ParsedDependency[];
    try {
      deps = extractDependencies(source, current.name, current.type);
    } catch (err) {
      errors.push(`Failed to parse dependencies for ${current.name}: ${String(err)}`);
      continue;
    }

    for (const dep of deps) {
      // Add edge
      edges.push({
        from: key,
        to: dep.objectName,
        references: dep.members,
      });

      // Track reverse reference
      if (!nodes.has(dep.objectName)) {
        if (isCustomObject(dep.objectName)) {
          // Custom: resolve type and enqueue for recursive traversal
          const resolvedType = await resolveType(client, dep, errors);
          queue.push({ name: dep.objectName, type: resolvedType });
        } else {
          // Standard: fetch source but don't traverse further
          let stdSource = "";
          try {
            const resolvedType = await resolveType(client, dep, errors);
            stdSource = await client.fetchSource(dep.objectName, resolvedType);
          } catch (err) {
            errors.push(`Failed to fetch standard source for ${dep.objectName}: ${String(err)}`);
          }

          nodes.set(dep.objectName, {
            name: dep.objectName,
            type: dep.objectType,
            isCustom: false,
            source: stdSource,
            usedBy: [],
          });
        }
      }

      // Update usedBy on the dependency node
      const depNode = nodes.get(dep.objectName);
      if (depNode && !depNode.usedBy.includes(key)) {
        depNode.usedBy.push(key);
      }
    }
  }

  // Topological sort (bottom-up: leaves first)
  const topologicalOrder = topologicalSort(nodes, edges);

  return {
    root: rootName.toUpperCase(),
    nodes: Array.from(nodes.values()),
    edges,
    topologicalOrder,
    errors,
  };
}

async function resolveType(
  client: AdtClientWrapper,
  dep: ParsedDependency,
  errors: string[]
): Promise<AbapObjectType> {
  // If we already know the type from abaplint
  if (dep.objectType === "CLAS" || dep.objectType === "INTF") {
    return dep.objectType;
  }

  // Try to resolve via ADT search
  try {
    const resolved = await client.resolveObjectType(dep.objectName);
    if (resolved) {
      const type = resolved.type as AbapObjectType;
      if (["CLAS", "INTF", "PROG", "FUGR"].includes(type)) {
        return type;
      }
    }
  } catch (err) {
    errors.push(`Failed to resolve type for ${dep.objectName}: ${String(err)}`);
  }

  // Default to CLAS if we can't determine
  return "CLAS";
}

/**
 * Kahn's algorithm for topological sort.
 * Returns nodes in bottom-up order (leaves first).
 */
function topologicalSort(nodes: Map<string, DagNode>, edges: DagEdge[]): string[] {
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const name of nodes.keys()) {
    inDegree.set(name, 0);
    adjacency.set(name, []);
  }

  for (const edge of edges) {
    if (nodes.has(edge.from) && nodes.has(edge.to)) {
      adjacency.get(edge.from)!.push(edge.to);
      inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
    }
  }

  // Start with leaf nodes (no outgoing deps that are in our graph)
  // We want bottom-up, so we reverse: start with nodes that have no incoming edges from deps perspective
  // Actually for Kahn's: nodes with in-degree 0 are leaves (nothing depends on them as a dep)
  // We need to reverse the edges: "from uses to" becomes "to is used by from"
  // For bottom-up processing, we want leaves first

  const reverseInDegree = new Map<string, number>();
  const reverseAdj = new Map<string, string[]>();

  for (const name of nodes.keys()) {
    reverseInDegree.set(name, 0);
    reverseAdj.set(name, []);
  }

  for (const edge of edges) {
    if (nodes.has(edge.from) && nodes.has(edge.to)) {
      // Reverse: "to" -> "from" (dependency points to dependent)
      reverseAdj.get(edge.to)!.push(edge.from);
      reverseInDegree.set(edge.from, (reverseInDegree.get(edge.from) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const [name, degree] of reverseInDegree.entries()) {
    if (degree === 0) {
      queue.push(name);
    }
  }

  const result: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    result.push(current);

    for (const neighbor of reverseAdj.get(current) ?? []) {
      const newDegree = (reverseInDegree.get(neighbor) ?? 1) - 1;
      reverseInDegree.set(neighbor, newDegree);
      if (newDegree === 0) {
        queue.push(neighbor);
      }
    }
  }

  // If there are cycles, add remaining nodes at the end
  for (const name of nodes.keys()) {
    if (!result.includes(name)) {
      result.push(name);
    }
  }

  return result;
}
