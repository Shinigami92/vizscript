import type {
  FunctionGraph,
  GraphDocument,
  GraphEdge,
  GraphNode,
  Pin,
} from '@vizscript/core';
import {
  isMapType,
  isSetType,
  mapKeyType,
  mapValueType,
  pinKey,
  setElementType,
} from '@vizscript/core';

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

const TYPE_NAMES: Record<string, string> = {
  any: 'Any',
  bool: 'Boolean',
  number: 'Number',
  bigint: 'BigInt',
  string: 'String',
  object: 'Object',
  array: 'Array',
  map: 'Map',
  set: 'Set',
  function: 'Function',
  null: 'Null',
  void: 'Void',
  regexp: 'RegExp',
};

/**
 * A type's name for people (`number` → Number, `Item[]` → Array of Item,
 * `Map<string, number>` → Map of String to Number).
 */
function typeName(type: string): string {
  if (type.endsWith('[]')) {
    return `Array of ${typeName(type.slice(0, -2))}`;
  }

  if (type !== 'map' && isMapType(type)) {
    return `Map of ${typeName(mapKeyType(type))} to ${typeName(mapValueType(type))}`;
  }

  if (type !== 'set' && isSetType(type)) {
    return `Set of ${typeName(setElementType(type))}`;
  }

  return TYPE_NAMES[type] ?? type;
}

/**
 * What a wire carries, like UE's wire tooltip: the type's name, then the
 * type as the language writes it (when a checker gave a more exact one).
 */
export function wireType(
  index: DocIndex,
  edge: GraphEdge
): { name: string; detail?: string } {
  if (edge.kind === 'exec') {
    return { name: 'Exec' };
  }

  const pinOf = (ref: GraphEdge['from']): Pin | undefined =>
    index.nodes.get(ref.node)?.node.pins.find((p) => p.id === ref.pin);
  const from = pinOf(edge.from);
  const to = pinOf(edge.to);
  // The value's own type; an untyped output takes the input's.
  const pin =
    from && (from.type !== 'any' || from.typeText) ? from : (to ?? from);
  if (!pin) {
    return { name: 'Value' };
  }

  const type = String(pin.type);
  const name = typeName(type);
  const detail = pin.typeText?.trim();
  return detail && detail !== type && detail !== name
    ? { name, detail }
    : { name };
}
