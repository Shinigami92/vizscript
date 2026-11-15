import type { PinGeometry } from '@vizscript/core';
import type { NodeState } from './graph-view-types';

/** A pin of a node as drawn. */
export interface PinRef {
  ns: NodeState;
  pg: PinGeometry;
}

/**
 * Whether two references mean the same pin. Compared by id: a new document
 * replaces every `NodeState`, also while a wire is being dragged.
 */
export function samePin(a: PinRef, b: PinRef): boolean {
  return a.ns.node.id === b.ns.node.id && a.pg.pin.id === b.pg.pin.id;
}

/** The pin in a new document's nodes, `null` when it is gone. */
export function resolvePin(
  nodes: ReadonlyMap<string, NodeState>,
  ref: PinRef
): PinRef | null {
  const ns = nodes.get(ref.ns.node.id);
  const pg = ns?.geom.pins.get(ref.pg.pin.id);
  return ns && pg ? { ns, pg } : null;
}
