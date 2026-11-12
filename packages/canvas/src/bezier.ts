import type { Point } from '@vizscript/core';
import type { Rect } from './camera';

export interface Wire {
  p0: Point;
  c0: Point;
  c1: Point;
  p1: Point;
}

/** Blueprint-style wire: horizontal tangents growing with the distance. */
export function wireCurve(from: Point, to: Point): Wire {
  const dx = Math.abs(to.x - from.x);
  const offset =
    Math.max(50, dx * 0.5) +
    (to.x < from.x ? Math.min(150, Math.abs(to.y - from.y) * 0.25) : 0);
  return {
    p0: from,
    c0: { x: from.x + offset, y: from.y },
    c1: { x: to.x - offset, y: to.y },
    p1: to,
  };
}

export function pointOnWire(w: Wire, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * w.p0.x + b * w.c0.x + c * w.c1.x + d * w.p1.x,
    y: a * w.p0.y + b * w.c0.y + c * w.c1.y + d * w.p1.y,
  };
}

export function wireBounds(w: Wire): Rect {
  const xs = [w.p0.x, w.c0.x, w.c1.x, w.p1.x];
  const ys = [w.p0.y, w.c0.y, w.c1.y, w.p1.y];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** Approximate distance from `p` to the wire by sampling. */
export function distanceToWire(w: Wire, p: Point, samples = 24): number {
  let best = Number.POSITIVE_INFINITY;
  let prev = w.p0;
  for (let i = 1; i <= samples; i++) {
    const next = pointOnWire(w, i / samples);
    best = Math.min(best, distanceToSegment(p, prev, next));
    prev = next;
  }

  return best;
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  const t =
    lengthSq === 0
      ? 0
      : Math.max(
          0,
          Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq)
        );
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** A wire is either a bezier curve or an orthogonal route with round corners. */
export type WireShape =
  | { type: 'curve'; curve: Wire; bounds: Rect }
  | { type: 'route'; points: Point[]; bounds: Rect };

function pointsBounds(points: ReadonlyArray<Point>): Rect {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/**
 * Shape for a wire between two pins. Wires that run backwards to a lower row
 * (wrapped exec chains) are routed through the gap at `laneY` instead of
 * cutting diagonally across other nodes.
 */
export function wireShape(from: Point, to: Point, laneY?: number): WireShape {
  const backwards = to.x < from.x - 60;
  if (backwards && laneY !== undefined) {
    const out = 28;
    const points = [
      from,
      { x: from.x + out, y: from.y },
      { x: from.x + out, y: laneY },
      { x: to.x - out, y: laneY },
      { x: to.x - out, y: to.y },
      to,
    ];
    return { type: 'route', points, bounds: pointsBounds(points) };
  }

  const curve = wireCurve(from, to);
  return { type: 'curve', curve, bounds: wireBounds(curve) };
}

/** Distance from `p` to a wire shape (curve or orthogonal route). */
export function distanceToShape(shape: WireShape, p: Point): number {
  if (shape.type === 'curve') {
    return distanceToWire(shape.curve, p);
  }

  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < shape.points.length; i++) {
    const a = shape.points[i - 1];
    const b = shape.points[i];
    if (a && b) {
      best = Math.min(best, distanceToSegment(p, a, b));
    }
  }

  return best;
}

/**
 * Shape through reroute points: one curve per segment, so each knot keeps
 * the horizontal tangents of a Blueprint reroute node.
 */
export function reroutedShapes(
  from: Point,
  to: Point,
  knots: ReadonlyArray<Point>
): WireShape[] {
  const points = [from, ...knots, to];
  const shapes: WireShape[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as Point;
    const b = points[i] as Point;
    const curve = wireCurve(a, b);
    shapes.push({ type: 'curve', curve, bounds: wireBounds(curve) });
  }

  return shapes;
}
