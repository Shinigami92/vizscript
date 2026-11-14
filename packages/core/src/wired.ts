import type { FunctionGraph } from './ir';

/**
 * The nodes wired into a function: connected to its entry node by any
 * wires. Its frame encloses only these; a node not wired in yet (a Get
 * just placed) can sit anywhere without moving the frame, like UE's nodes.
 */
export function wiredNodes(fn: FunctionGraph): Set<string> {
  const entries = fn.nodes.filter((n) => n.kind === 'entry').map((n) => n.id);
  if (entries.length === 0) {
    return new Set(fn.nodes.map((n) => n.id));
  }

  const neighbors = new Map<string, string[]>();
  for (const edge of fn.edges) {
    neighbors.set(edge.from.node, [
      ...(neighbors.get(edge.from.node) ?? []),
      edge.to.node,
    ]);
    neighbors.set(edge.to.node, [
      ...(neighbors.get(edge.to.node) ?? []),
      edge.from.node,
    ]);
  }

  const result = new Set(entries);
  const queue = [...entries];
  for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
    for (const next of neighbors.get(id) ?? []) {
      if (!result.has(next)) {
        result.add(next);
        queue.push(next);
      }
    }
  }

  return result;
}
