import { isCompact } from './geometry';
import type { FunctionGraph, GraphEdge, GraphNode, Pin } from './ir';

/** Names of the object a method runs on. */
const SELF_NAMES = new Set(['self', 'this']);

/**
 * UE's implicit `self`: a Target fed by the function's own object (the
 * entry's `self` pin, or a `self` / `this` Get used only there) shows a
 * `self` box instead of a wire. Compact nodes (`.price`) drop the pin, like
 * UE's Get of a member variable. Only the drawing changes; ops still use
 * the real graph.
 */
export function withImplicitSelf(fn: FunctionGraph): FunctionGraph {
  const byId = new Map(fn.nodes.map((n) => [n.id, n]));
  const uses = new Map<string, number>();
  for (const edge of fn.edges) {
    uses.set(edge.from.node, (uses.get(edge.from.node) ?? 0) + 1);
  }

  const hiddenEdges = new Set<GraphEdge>();
  const hiddenNodes = new Set<string>();
  // Node id → target pin id → the word to show (`self`, `this`).
  const targets = new Map<string, Map<string, string>>();
  for (const edge of fn.edges) {
    if (edge.kind !== 'data' || edge.to.pin !== 'target') {
      continue;
    }

    const source = byId.get(edge.from.node);
    const word = source ? selfWord(source, edge.from.pin, uses) : undefined;
    if (!source || !word) {
      continue;
    }

    hiddenEdges.add(edge);
    if (source.kind === 'getVar') {
      hiddenNodes.add(source.id);
    }

    const pins = targets.get(edge.to.node) ?? new Map<string, string>();
    pins.set(edge.to.pin, word);
    targets.set(edge.to.node, pins);
  }

  if (hiddenEdges.size === 0) {
    return fn;
  }

  return {
    ...fn,
    nodes: fn.nodes
      .filter((n) => !hiddenNodes.has(n.id))
      .map((n) => {
        const pins = targets.get(n.id);
        return pins ? withSelfPins(n, pins) : n;
      }),
    edges: fn.edges.filter((e) => !hiddenEdges.has(e)),
  };
}

function selfWord(
  source: GraphNode,
  pinId: string,
  uses: ReadonlyMap<string, number>
): string | undefined {
  if (source.kind === 'entry') {
    const name = source.pins.find((p) => p.id === pinId)?.name ?? '';
    return SELF_NAMES.has(name) ? name : undefined;
  }

  return source.kind === 'getVar' &&
    SELF_NAMES.has(source.title) &&
    uses.get(source.id) === 1
    ? source.title
    : undefined;
}

function withSelfPins(
  node: GraphNode,
  pins: ReadonlyMap<string, string>
): GraphNode {
  const compact = isCompact(node);
  return {
    ...node,
    pins: node.pins.flatMap((pin): Pin[] => {
      const word = pins.get(pin.id);
      if (word === undefined) {
        return [pin];
      }

      return compact
        ? []
        : [
            {
              ...pin,
              literal: {
                kind: 'undefined',
                value: word,
                raw: word,
                editable: false,
              },
            },
          ];
    }),
  };
}
