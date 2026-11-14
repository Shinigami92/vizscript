import { edgeId } from './ids';
import type {
  FunctionGraph,
  GraphDocument,
  GraphEdge,
  GraphNode,
  Positions,
} from './ir';
import type { TextChange } from './reconcile';
import { renamedNodes } from './reconcile';

/**
 * UE wires a SET node's output straight into other inputs. In code that is
 * a read of the variable, which the graph shows as a Get node; a Get the
 * user wired from a SET is remembered in the layout (`~via|<getId>`, like
 * comment box colors) and drawn as a wire from that SET's output instead.
 * The code is the same either way.
 */
export const VIA_PREFIX = '~via|';

export function viaKey(getId: string): string {
  return `${VIA_PREFIX}${getId}`;
}

export function isViaKey(key: string): boolean {
  return key.startsWith(VIA_PREFIX);
}

/** The Get node ids drawn as wires from their SET. */
export function viaGets(positions: Positions): Set<string> {
  return new Set(
    Object.keys(positions)
      .filter((key) => isViaKey(key))
      .map((key) => key.slice(VIA_PREFIX.length))
  );
}

/** The layout entries of `~via|` keys (kept apart from node positions). */
export function viaEntries(positions: Positions): Positions {
  return Object.fromEntries(
    Object.entries(positions).filter(([key]) => isViaKey(key))
  );
}

/** `~via|` entries follow their Get node when its id changes with an edit. */
export function reconcileVias(
  previous: GraphDocument | undefined,
  next: GraphDocument,
  positions: Positions,
  change?: TextChange
): Positions {
  const entries = viaEntries(positions);
  if (!previous || Object.keys(entries).length === 0) {
    return entries;
  }

  const rename = renamedNodes(previous, next, change);
  const result: Positions = {};
  for (const [key, point] of Object.entries(entries)) {
    const id = key.slice(VIA_PREFIX.length);
    result[viaKey(rename.get(id) ?? id)] = point;
  }

  return result;
}

/**
 * The SET a Get reads from: the nearest setter of the same variable before
 * it in the same function, with an output to wire from.
 */
export function viaSetter(
  fn: FunctionGraph,
  get: GraphNode
): GraphNode | undefined {
  if (get.kind !== 'getVar') {
    return undefined;
  }

  const title = `Set ${get.title}`;
  let best: GraphNode | undefined;
  for (const node of fn.nodes) {
    if (
      node.kind === 'setVar' &&
      node.title === title &&
      node.range.end <= get.range.start &&
      node.pins.some((p) => p.id === 'out') &&
      (!best || node.range.start > best.range.start)
    ) {
      best = node;
    }
  }

  return best;
}

/**
 * The graph as drawn: remembered Gets become wires from their SET's output
 * (`GraphEdge.via` names the hidden Get). Gets without a SET before them
 * stay nodes.
 */
export function foldVias(
  doc: GraphDocument,
  gets: ReadonlySet<string>
): GraphDocument {
  if (gets.size === 0) {
    return doc;
  }

  let changed = false;
  const functions = doc.functions.map((fn) => {
    const hidden = new Map<string, GraphNode>();
    for (const node of fn.nodes) {
      const setter = gets.has(node.id) ? viaSetter(fn, node) : undefined;
      if (setter) {
        hidden.set(node.id, setter);
      }
    }

    if (hidden.size === 0) {
      return fn;
    }

    changed = true;
    const edges: GraphEdge[] = fn.edges.map((edge) => {
      const setter = hidden.get(edge.from.node);
      if (!setter) {
        return edge;
      }

      const from = { node: setter.id, pin: 'out' };
      return { ...edge, id: edgeId(from, edge.to), from, via: edge.from.node };
    });
    return {
      ...fn,
      nodes: fn.nodes.filter((n) => !hidden.has(n.id)),
      edges: edges.filter((e) => !hidden.has(e.to.node)),
    };
  });
  return changed ? { ...doc, functions } : doc;
}
