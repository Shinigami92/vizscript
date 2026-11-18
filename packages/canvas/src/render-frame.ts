import type { Point } from '@vizscript/core';
import type { Drag } from './graph-view-types';
import type { PinRef } from './pin-ref';

/**
 * What a frame shows besides the scene and the camera: selection, hover,
 * the drag in progress, and the time (for fades and pulses).
 */
export interface RenderFrame {
  time: number;
  editable: boolean;
  selection: ReadonlySet<string>;
  /** Selected reroute points (`knotId`). */
  knotSelection: ReadonlySet<string>;
  /** Nodes highlighted from outside (e.g. the code editor cursor). */
  highlight: ReadonlySet<string>;
  hoverNode: string | null;
  hoverPin: string | null;
  /** The node whose "Add pin +" button is under the cursor. */
  hoverAddPin: string | null;
  hoverEdge: string | null;
  drag: Drag | null;
  /** Wire dropped on empty space, drawn while its menu is open. */
  pendingWire: { from: PinRef; world: Point } | null;
}
