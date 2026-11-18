import type { Point } from '@vizscript/core';
import type { Drag } from './graph-view-types';
import type { PinRef } from './pin-ref';

/**
 * What the user picked, points at and drags: shared by the view's API,
 * the pointer and key handlers (`Controller`) and the `Renderer`.
 */
export interface Interaction {
  selection: Set<string>;
  /** Selected reroute points (`knotId`). */
  knotSelection: Set<string>;
  /** Nodes highlighted from outside (e.g. the code editor cursor). */
  highlight: Set<string>;
  hoverNode: string | null;
  hoverPin: string | null;
  /** The node whose "Add pin +" button is under the cursor. */
  hoverAddPin: string | null;
  /** The wire under the pointer (only over empty space). */
  hoverEdge: string | null;
  drag: Drag | null;
  /** Wire dropped on empty space, drawn while its menu is open. */
  pendingWire: { from: PinRef; world: Point } | null;
}

/** Nothing selected, hovered or dragged. */
export function newInteraction(): Interaction {
  return {
    selection: new Set(),
    knotSelection: new Set(),
    highlight: new Set(),
    hoverNode: null,
    hoverPin: null,
    hoverAddPin: null,
    hoverEdge: null,
    drag: null,
    pendingWire: null,
  };
}
