import type { GraphDocument, GraphNode, Positions } from './ir';

function* allNodes(
  doc: GraphDocument
): Generator<[fnId: string, node: GraphNode]> {
  for (const fn of doc.functions) {
    for (const node of fn.nodes) {
      yield [fn.id, node];
    }
  }
}

/**
 * Pairs nodes that disappeared in `next` with the nodes that took their
 * place, in two passes:
 * 1. same function, structural path and kind (e.g. an edited literal),
 * 2. same function, kind and title, in document order (e.g. a call whose
 *    text changed *and* moved because a statement was inserted before it).
 */
export function renamedNodes(
  previous: GraphDocument,
  next: GraphDocument
): Map<string, string> {
  const previousIds = new Set<string>();
  for (const [, node] of allNodes(previous)) {
    previousIds.add(node.id);
  }

  const nextIds = new Set<string>();
  const added: Array<[string, GraphNode]> = [];
  for (const [fnId, node] of allNodes(next)) {
    nextIds.add(node.id);
    if (!previousIds.has(node.id)) {
      added.push([fnId, node]);
    }
  }

  const removed: Array<[string, GraphNode]> = [];
  for (const [fnId, node] of allNodes(previous)) {
    if (!nextIds.has(node.id)) {
      removed.push([fnId, node]);
    }
  }

  const result = new Map<string, string>();
  const taken = new Set<string>();
  const pass = (key: (fnId: string, node: GraphNode) => string): void => {
    const candidates = new Map<string, string[]>();
    for (const [fnId, node] of added) {
      if (!taken.has(node.id)) {
        const k = key(fnId, node);
        candidates.set(k, [...(candidates.get(k) ?? []), node.id]);
      }
    }

    for (const [fnId, node] of removed) {
      if (result.has(node.id)) {
        continue;
      }

      const match = candidates.get(key(fnId, node))?.shift();
      if (match) {
        result.set(node.id, match);
        taken.add(match);
      }
    }
  };

  pass((fnId, node) => `${fnId}|${node.path}|${node.kind}`);
  pass((fnId, node) => `${fnId}|${node.kind}|${node.title}`);
  return result;
}

/**
 * Carries positions over from a previous parse to a new one.
 *
 * Node ids are content based, so most nodes match by id directly. Nodes
 * whose own text changed get a new id; they are matched with
 * {@link renamedNodes}.
 */
export function reconcilePositions(
  previous: GraphDocument | undefined,
  next: GraphDocument,
  positions: Positions
): Positions {
  const result: Positions = {};
  const renamed = previous ? renamedNodes(previous, next) : new Map();
  for (const [oldId, newId] of renamed) {
    const p = positions[oldId];
    if (p) {
      result[newId] = p;
    }
  }

  for (const [, node] of allNodes(next)) {
    const own = positions[node.id];
    if (own) {
      result[node.id] = own;
    }
  }

  return result;
}

/** Returns the innermost node whose source range contains `offset`. */
export function findNodeAtOffset(
  doc: GraphDocument,
  offset: number
): GraphNode | undefined {
  let best: GraphNode | undefined;
  for (const [, node] of allNodes(doc)) {
    if (
      node.kind !== 'entry' &&
      node.range.start <= offset &&
      offset <= node.range.end &&
      (!best ||
        node.range.end - node.range.start < best.range.end - best.range.start)
    ) {
      best = node;
    }
  }

  return best;
}

export function findNode(
  doc: GraphDocument,
  nodeId: string
): GraphNode | undefined {
  for (const [, node] of allNodes(doc)) {
    if (node.id === nodeId) {
      return node;
    }
  }

  return undefined;
}
