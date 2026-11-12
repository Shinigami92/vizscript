import type { Point } from '@vizscript/core';
import { COMMENT_BOX_HEADER, COMMENT_BOX_PADDING } from './bubble';

/** Below this zoom, right-clicking a pin opens its node's menu. */
export const PIN_MENU_ZOOM = 0.5;
export const FRAME_PADDING = 32;
export const FRAME_HEADER = 34;
/** Height of the ERROR / WARNING banner below a node, and its gap. */
export const BANNER_HEIGHT = 17;
export const BANNER_GAP = 3;
export const COMMENT_PADDING = COMMENT_BOX_PADDING;
export const COMMENT_HEADER = COMMENT_BOX_HEADER;
export const DRAG_THRESHOLD = 3;
/** Durations of eased camera and node moves, in ms. */
export const CAMERA_MOTION_MS = 250;
export const NODE_MOTION_MS = 200;
export const NODE_APPEAR_MS = 180;
export const NODE_PULSE_MS = 700;
export const KNOT_RADIUS = 6;
/** Row under a node with folded advanced pins (UE's ▼). */
export const ADVANCED_ROW = 14;

/** Closer than half a pixel: not worth a slide. */
export function samePoint(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;
}

export function knotId(edgeId: string, index: number): string {
  return `${edgeId}\u0000${index}`;
}

export function parseKnotId(id: string): { edgeId: string; index: number } {
  const separator = id.lastIndexOf('\u0000');
  return {
    edgeId: id.slice(0, separator),
    index: Number(id.slice(separator + 1)),
  };
}

/** Whether a boolean value is true (`true`, Python's `True`). */
export function isChecked(value: string): boolean {
  return value.trim().toLowerCase() === 'true';
}
