import type { Point } from '@vizscript/core';
import type { Rect } from './camera';

export interface Wire {
  p0: Point;
  c0: Point;
  c1: Point;
  p1: Point;
}

/**
 * UE's wire spline (`FConnectionDrawingPolicy::ComputeSplineTangent` with
 * the default graph editor settings): both ends leave horizontally, with a
 * tangent growing with the distance. Going backwards the tangent is larger
 * and reaches its full size sooner, so the wire loops out of its pin and
 * into the other in an S, like in Blueprints.
 */
export function wireCurve(
  from: Point,
  to: Point,
  /** -1: the wire leaves `from` to the left (a reversed reroute knot). */
  startDirection: 1 | -1 = 1,
  /** -1: the wire enters `to` from the right (a reversed reroute knot). */
  endDirection: 1 | -1 = 1
): Wire {
  const dx = to.x - from.x;
  const dy = Math.abs(to.y - from.y);
  const tangent =
    dx >= 0
      ? Math.min(dx, 1000) + Math.min(dy, 1000)
      : 3 * Math.min(-dx, 200) + 1.5 * Math.min(dy, 200);
  // A Hermite spline as a Bezier curve: control points a third along.
  const offset = tangent / 3;
  return {
    p0: from,
    c0: { x: from.x + startDirection * offset, y: from.y },
    c1: { x: to.x - endDirection * offset, y: to.y },
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

/** A wire: UE's spline with its bounds. */
export interface WireShape {
  curve: Wire;
  bounds: Rect;
}

/** Shape for a wire between two pins: UE's spline, also backwards. */
export function wireShape(from: Point, to: Point): WireShape {
  const curve = wireCurve(from, to);
  return { curve, bounds: wireBounds(curve) };
}

/** Distance from `p` to a wire shape. */
export function distanceToShape(shape: WireShape, p: Point): number {
  return distanceToWire(shape.curve, p);
}

/**
 * Shape through reroute points: one UE spline per segment, horizontal at
 * each knot. Like UE's `ShouldChangeTangentForKnot`, a knot feeding a point
 * left of the one feeding it is reversed: the wire passes it right to left,
 * so it turns outside the knot instead of sticking out of it.
 */
export function reroutedShapes(
  from: Point,
  to: Point,
  knots: ReadonlyArray<Point>
): WireShape[] {
  const points = [from, ...knots, to];
  const direction = (i: number): 1 | -1 => {
    const before = points[i - 1];
    const after = points[i + 1];
    // The pins at both ends always face their own way.
    return before && after && after.x < before.x ? -1 : 1;
  };
  const shapes: WireShape[] = [];
  for (let i = 1; i < points.length; i++) {
    const curve = wireCurve(
      points[i - 1] as Point,
      points[i] as Point,
      direction(i - 1),
      direction(i)
    );
    shapes.push({ curve, bounds: wireBounds(curve) });
  }

  return shapes;
}
