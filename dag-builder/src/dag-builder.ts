import { AdtClientWrapper } from "./adt-client";
import { extractDependencies } from "./abap-parser";
import { isCustomObject } from "./classifier";
import { DagInput, DagResult, DagNode, DagEdge, ParsedDependency } from "./types";

const MAX_NODES = 50;

function log(msg: string): void {
  process.stderr.write(`[dag-builder] ${msg}\n`);
}

/**
 * Builds a dependency DAG for an ABAP object by:
 * 1. Fetching the target object's source via ADT REST
 * 2. Parsing it with abaplint to find dependencies
 * 3. Recursively traversing custom (Z/Y) dependencies
 * 4. Recording standard dependencies as leaf nodes (source fetched later by agent)
 */
export async function buildDag(input: DagInput): Promise<DagResult> {
  const client = new AdtClientWrapper(input.systemUrl, input.username, input.password, input.client);
  const errors: string[] = [];

  try {
    log(`Connecting to ${input.systemUrl}...`);
    await client.connect();
    log("Connected. Starting traversal...");
    const result = await traverse(client, input.objectName, input.objectType, errors);
    log(`Done. ${result.nodes.length} nodes, ${result.edges.length} edges.`);
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
  rootType: string,
  errors: string[]
): Promise<DagResult> {
  const nodes = new Map<string, DagNode>();
  const edges: DagEdge[] = [];
  const visited = new Set<string>();
  const queue: Array<{ name: string; type: string }> = [{ name: rootName, type: rootType }];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const key = current.name.toUpperCase();

    if (visited.has(key)) continue;
    visited.add(key);

    if (nodes.size >= MAX_NODES) {
      log(`Reached max node limit (${MAX_NODES}). Stopping traversal.`);
      errors.push(`Traversal stopped: reached maximum of ${MAX_NODES} nodes. Remaining queue: ${queue.length} objects.`);
      break;
    }

    log(`[${nodes.size + 1}/${MAX_NODES}] Fetching ${key}...`);

    // Fetch source for custom objects (needed for dependency parsing)
    let source: string;
    try {
      source = await client.fetchSource(current.name);
    } catch (err) {
      errors.push(`Failed to fetch source for ${current.name}: ${String(err)}`);
      continue;
    }

    // Add node (without source in output)
    nodes.set(key, {
      name: key,
      type: current.type,
      isCustom: isCustomObject(current.name),
      sourceAvailable: true,
      usedBy: [],
    });

    // Parse dependencies
    let deps: ParsedDependency[];
    try {
      deps = extractDependencies(source, current.name, current.type as any);
    } catch (err) {
      errors.push(`Failed to parse dependencies for ${current.name}: ${String(err)}`);
      continue;
    }

    log(`  Found ${deps.length} dependencies for ${key}`);

    for (const dep of deps) {
      edges.push({ from: key, to: dep.objectName, references: dep.members });

      if (!nodes.has(dep.objectName) && !visited.has(dep.objectName)) {
        if (isCustomObject(dep.objectName)) {
          // Custom: resolve type and enqueue for recursive traversal
          const resolvedType = await resolveType(client, dep, errors);
          queue.push({ name: dep.objectName, type: resolvedType });
        } else {
          // Standard: record as leaf node, don't fetch source
          nodes.set(dep.objectName, {
            name: dep.objectName,
            type: dep.objectType || "UNKNOWN",
            isCustom: false,
            sourceAvailable: false,
            usedBy: [],
          });
        }
      }

      // Update usedBy on existing nodes
      const depNode = nodes.get(dep.objectName);
      if (depNode && !depNode.usedBy.includes(key)) {
        depNode.usedBy.push(key);
      }
    }
  }

  // Fix usedBy for edges added after node creation
  for (const edge of edges) {
    const depNode = nodes.get(edge.to);
    if (depNode && !depNode.usedBy.includes(edge.from)) {
      depNode.usedBy.push(edge.from);
    }
  }

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
): Promise<string> {
  if (dep.objectType === "CLAS" || dep.objectType === "INTF") {
    return dep.objectType;
  }

  try {
    const resolved = await client.resolveObjectType(dep.objectName);
    if (resolved) {
      return resolved.type;
    }
  } catch (err) {
    errors.push(`Failed to resolve type for ${dep.objectName}: ${String(err)}`);
  }

  return "CLAS";
}

/**
 * Kahn's algorithm for topological sort.
 * Returns nodes in bottom-up order (leaves first).
 */
function topologicalSort(nodes: Map<string, DagNode>, edges: DagEdge[]): string[] {
  const reverseInDegree = new Map<string, number>();
  const reverseAdj = new Map<string, string[]>();

  for (const name of nodes.keys()) {
    reverseInDegree.set(name, 0);
    reverseAdj.set(name, []);
  }

  for (const edge of edges) {
    if (nodes.has(edge.from) && nodes.has(edge.to)) {
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

  for (const name of nodes.keys()) {
    if (!result.includes(name)) {
      result.push(name);
    }
  }

  return result;
}
