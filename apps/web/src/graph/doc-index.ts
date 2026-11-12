import type {
  FunctionGraph,
  GraphDocument,
  GraphEdge,
  GraphNode,
  Pin,
} from '@vizscript/core';
import { pinKey } from '@vizscript/core';

export interface IndexedNode {
  node: GraphNode;
  fn: FunctionGraph;
}

/** Lookup tables for UI panels (tooltips, details, menus). */
export interface DocIndex {
  nodes: Map<string, IndexedNode>;
  /** Edges by `pinKey` of their input pin. */
  incoming: Map<string, GraphEdge[]>;
  /** Edges by `pinKey` of their output pin. */
  outgoing: Map<string, GraphEdge[]>;
}

export function indexDocument(doc: GraphDocument | null): DocIndex {
  const index: DocIndex = {
    nodes: new Map(),
    incoming: new Map(),
    outgoing: new Map(),
  };
  for (const fn of doc?.functions ?? []) {
    for (const node of fn.nodes) {
      index.nodes.set(node.id, { node, fn });
    }

    for (const edge of fn.edges) {
      const to = pinKey(edge.to);
      const from = pinKey(edge.from);
      index.incoming.set(to, [...(index.incoming.get(to) ?? []), edge]);
      index.outgoing.set(from, [...(index.outgoing.get(from) ?? []), edge]);
    }
  }

  return index;
}

/** Edges attached to a pin, in either direction. */
export function pinEdges(
  index: DocIndex,
  nodeId: string,
  pin: Pin
): GraphEdge[] {
  const key = pinKey({ node: nodeId, pin: pin.id });
  return pin.direction === 'in'
    ? (index.incoming.get(key) ?? [])
    : (index.outgoing.get(key) ?? []);
}

/** The node on the other end of each edge of a pin. */
export function pinPeers(
  index: DocIndex,
  nodeId: string,
  pin: Pin
): Array<{ node: GraphNode; pin: Pin | undefined }> {
  return pinEdges(index, nodeId, pin)
    .map((edge) => (pin.direction === 'in' ? edge.from : edge.to))
    .map((ref) => {
      const node = index.nodes.get(ref.node)?.node;
      return node
        ? { node, pin: node.pins.find((p) => p.id === ref.pin) }
        : undefined;
    })
    .filter((peer) => peer !== undefined);
}

export function describeType(pin: Pin): string {
  return pin.kind === 'exec' ? 'exec' : String(pin.type);
}
