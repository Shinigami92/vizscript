import type { Conversion, GraphOp, Point } from '@vizscript/core';
import { snapToGrid } from '@vizscript/core';
import type { Camera, Rect } from './camera';
import { rectContains, zoomAt } from './camera';
import { DRAG_THRESHOLD, knotId } from './graph-view-constants';
import type { Hit } from './graph-view-types';
import type { PinRef } from './pin-ref';
import { samePin } from './pin-ref';
import { connectProblem, conversionOf, moveProblem } from './wire-rules';

/** Whether a press moved far enough (screen pixels) to be a drag. */
export function pastThreshold(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) >= DRAG_THRESHOLD;
}

/** The camera of a pan by a screen offset from where it started. */
export function panCamera(start: Camera, dx: number, dy: number): Camera {
  return {
    zoom: start.zoom,
    x: start.x - dx / start.zoom,
    y: start.y - dy / start.zoom,
  };
}

/**
 * The camera of a two-finger pinch: zoomed by how far the fingers spread
 * around where they started, and moved with their midpoint.
 */
export function pinchCamera(
  start: { camera: Camera; mid: Point; distance: number },
  a: Point,
  b: Point
): Camera {
  const distance = Math.hypot(a.x - b.x, a.y - b.y);
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const camera = zoomAt(
    start.camera,
    start.mid,
    distance / Math.max(start.distance, 1)
  );
  return {
    ...camera,
    x: camera.x - (mid.x - start.mid.x) / camera.zoom,
    y: camera.y - (mid.y - start.mid.y) / camera.zoom,
  };
}

/**
 * How far dragged nodes move: the grabbed one (at `anchor`) snaps to the
 * grid, the others keep their distance to it.
 */
export function snappedOffset(anchor: Point, dx: number, dy: number): Point {
  const snapped = snapToGrid({ x: anchor.x + dx, y: anchor.y + dy });
  return { x: snapped.x - anchor.x, y: snapped.y - anchor.y };
}

/** Reroute points (knot ids) inside a marquee rectangle. */
export function knotsInRect(
  reroutes: ReadonlyMap<string, ReadonlyArray<Point>>,
  rect: Rect
): string[] {
  const found: string[] = [];
  for (const [edgeId, points] of reroutes) {
    for (const [index, p] of points.entries()) {
      if (rectContains(rect, p)) {
        found.push(knotId(edgeId, index));
      }
    }
  }

  return found;
}

/** What a wire drag would do if released over `hit`. */
export interface WireDrop {
  target: PinRef | null;
  /** Why the pin under the cursor doesn't fit (UE's red ✕ message). */
  problem: string | null;
  /** The wire replaces one: a data input and an exec output take one. */
  replaces: 'input' | 'output' | null;
  /** Over empty space (or a frame title): dropping opens the actions. */
  empty: boolean;
  /** The conversion the wire goes through (UE's autocast node). */
  convert: Conversion | null;
}

/**
 * What dragging a new wire from `from` over `hit` would do. `wired` tells
 * whether a pin has a wire already.
 */
export function wireDropTarget(
  from: PinRef,
  hit: Hit | null,
  conversions: ReadonlyArray<Conversion> | undefined,
  wired: (end: PinRef) => boolean
): WireDrop {
  const onPin = hit?.type === 'pin' && !samePin(hit, from) ? hit : null;
  const problem = onPin ? connectProblem(from, onPin, conversions) : null;
  const target = onPin && !problem ? { ns: onPin.ns, pg: onPin.pg } : null;
  const [output, input] =
    target?.pg.pin.direction === 'in' ? [from, target] : [target, from];
  const replaces =
    target === null
      ? null
      : input?.pg.pin.kind === 'data' && wired(input)
        ? 'input'
        : output?.pg.pin.kind === 'exec' && wired(output)
          ? 'output'
          : null;
  return {
    target,
    problem,
    replaces,
    empty: (hit?.type ?? 'frame') === 'frame',
    convert: target ? (conversionOf(from, target, conversions) ?? null) : null,
  };
}

/** Where the wires of a Ctrl+drag would go if released over `hit`. */
export function moveDropTarget(
  drag: { from: PinRef; ends: ReadonlyArray<PinRef> },
  hit: Hit | null
): { target: PinRef | null; problem: string | null } {
  const onPin = hit?.type === 'pin' && !samePin(hit, drag.from) ? hit : null;
  const problem = onPin ? moveProblem(drag, onPin) : null;
  return {
    target: onPin && !problem ? { ns: onPin.ns, pg: onPin.pg } : null,
    problem,
  };
}

/** The op a wire dropped from `from` on `target` sends, output first. */
export function connectOp(
  from: PinRef,
  target: PinRef,
  convert: Conversion | null
): Extract<GraphOp, { type: 'connect' }> {
  const [out, input] =
    from.pg.pin.direction === 'out' ? [from, target] : [target, from];
  return {
    type: 'connect',
    from: { node: out.ns.node.id, pin: out.pg.pin.id },
    to: { node: input.ns.node.id, pin: input.pg.pin.id },
    ...(convert ? { convert: convert.template } : {}),
  };
}

/** What hovering shows: the cursor and what is highlighted. */
export interface Hover {
  cursor: string;
  node: string | null;
  pin: string | null;
  /** The wire under the pointer (only over empty space). */
  edge: string | null;
  /** The node whose "Add pin +" is under the pointer. */
  addPin: string | null;
}

/**
 * What the pointer over `hit` (or `edge`, the wire under it on empty space)
 * shows, like UE: a crosshair on pins, a text cursor on values, a pointer
 * on buttons, checkboxes and wires, move elsewhere; Space held: grab.
 */
export function hoverOf(
  hit: Hit | null,
  edge: string | null,
  editable: boolean,
  spaceDown: boolean
): Hover {
  const hover: Hover = {
    cursor: 'default',
    node: null,
    pin: null,
    edge: hit ? null : edge,
    addPin: hit?.type === 'node' && hit.addPin ? hit.ns.node.id : null,
  };
  if (!hit) {
    hover.cursor = edge ? 'pointer' : 'default';
  } else if (hit.type === 'frame' || hit.type === 'knot') {
    hover.cursor = 'move';
  } else {
    hover.node = hit.ns.node.id;
    hover.pin = hit.type === 'pin' ? hit.pg.pin.id : null;
    hover.cursor =
      hit.type === 'node' && (hit.advanced || hit.addPin)
        ? 'pointer'
        : hit.type === 'pin' && editable
          ? 'crosshair'
          : hit.type === 'literal' &&
              editable &&
              hit.pg.pin.literal?.editable !== false
            ? hit.pg.pin.literal?.kind === 'boolean'
              ? 'pointer'
              : 'text'
            : 'move';
  }

  if (spaceDown) {
    hover.cursor = 'grab';
  }

  return hover;
}
