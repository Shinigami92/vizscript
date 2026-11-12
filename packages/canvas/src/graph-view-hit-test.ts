import { isTypeCompatible } from '@vizscript/core';
import type { PinGeometry, Point } from '@vizscript/core';
import { rectContains, rectsIntersect, screenToWorld } from './camera';
import { GraphViewBase } from './graph-view-base';
import {
  ADVANCED_ROW,
  COMMENT_HEADER,
  FRAME_HEADER,
  KNOT_RADIUS,
  PIN_MENU_ZOOM,
} from './graph-view-constants';
import type { ContextTarget, Hit, NodeState } from './graph-view-types';

/** What is under a point: pins, nodes, reroute points, frames, wires. */
export abstract class GraphViewHitTest extends GraphViewBase {
  /** World point under a client (viewport) position, e.g. of a drop. */
  public worldAt(clientX: number, clientY: number): Point {
    const rect = this.canvas.getBoundingClientRect();
    return screenToWorld(this.camera, {
      x: clientX - rect.left,
      y: clientY - rect.top,
    });
  }

  /** No node, pin, reroute point or frame title at a world point. */
  public isEmptyAt(world: Point): boolean {
    return (
      this.hitTest(world) === null &&
      this.hitWire(world, this.wireTolerance()) === null
    );
  }

  /** The function whose frame contains a world point (innermost). */
  public functionAt(world: Point): string | undefined {
    this.updateFrames();
    return this.frames
      .filter(
        (f) =>
          f.kind === 'function' &&
          f.bounds !== null &&
          rectContains(f.bounds, world)
      )
      .toSorted(
        (a, b) =>
          (a.bounds?.width ?? 0) * (a.bounds?.height ?? 0) -
          (b.bounds?.width ?? 0) * (b.bounds?.height ?? 0)
      )[0]?.fnId;
  }

  private orderedCandidates(world: Point, pad: number): NodeState[] {
    const ids = this.index.query({
      x: world.x - pad,
      y: world.y - pad,
      width: pad * 2,
      height: pad * 2,
    });
    const states = ids
      .map((id) => this.nodes.get(id))
      .filter((ns): ns is NodeState => ns !== undefined);
    // Selected nodes are drawn on top, so they are hit first.
    return states.toSorted(
      (a, b) =>
        Number(this.selection.has(b.node.id)) -
        Number(this.selection.has(a.node.id))
    );
  }

  protected hitTest(world: Point): Hit | null {
    const pinRadius = Math.max(9, 7 / this.camera.zoom);
    const candidates = this.orderedCandidates(world, pinRadius);

    for (const ns of candidates) {
      for (const pg of ns.geom.pins.values()) {
        const p = this.pinWorld(ns, pg);
        if (Math.hypot(p.x - world.x, p.y - world.y) <= pinRadius) {
          return { type: 'pin', ns, pg };
        }
      }
    }

    const knotRadius = Math.max(KNOT_RADIUS + 3, 8 / this.camera.zoom);
    for (const [edgeId, points] of this.reroutes) {
      for (const [index, p] of points.entries()) {
        if (Math.hypot(p.x - world.x, p.y - world.y) <= knotRadius) {
          return { type: 'knot', edgeId, index };
        }
      }
    }

    for (const ns of candidates) {
      if (
        !rectsIntersect(this.nodeRect(ns), {
          x: world.x,
          y: world.y,
          width: 0.01,
          height: 0.01,
        })
      ) {
        continue;
      }

      for (const pg of ns.geom.pins.values()) {
        const r = this.literalRect(ns, pg);
        if (
          r &&
          world.x >= r.x &&
          world.x <= r.x + r.width &&
          world.y >= r.y &&
          world.y <= r.y + r.height
        ) {
          return { type: 'literal', ns, pg };
        }
      }

      const advanced =
        ns.advanced > 0 && world.y >= ns.y + ns.geom.height - ADVANCED_ROW;
      return advanced ? { type: 'node', ns, advanced } : { type: 'node', ns };
    }

    for (const ns of this.nodes.values()) {
      const r = this.bubbleRect(ns);
      if (r && rectContains(r, world)) {
        return { type: 'bubble', ns };
      }
    }

    this.updateFrames();
    // Inner comment boxes first, function frames last.
    const frames = this.frames.toSorted(
      (a, b) =>
        Number(a.kind === 'function') - Number(b.kind === 'function') ||
        a.nodeIds.length - b.nodeIds.length
    );
    for (const frame of frames) {
      const b = frame.bounds;
      const header = frame.kind === 'comment' ? COMMENT_HEADER : FRAME_HEADER;
      if (
        b &&
        world.x >= b.x &&
        world.x <= b.x + b.width &&
        world.y >= b.y &&
        world.y <= b.y + header
      ) {
        return { type: 'frame', frame };
      }
    }

    return null;
  }

  /** The pins at the other end of a pin's wires. */
  protected wireEnds(
    ns: NodeState,
    pg: PinGeometry
  ): Array<{ ns: NodeState; pg: PinGeometry }> {
    const fn = this.doc?.functions.find((f) => f.id === ns.fnId);
    const ends: Array<{ ns: NodeState; pg: PinGeometry }> = [];
    for (const edge of fn?.edges ?? []) {
      const [mine, other] =
        pg.pin.direction === 'out'
          ? [edge.from, edge.to]
          : [edge.to, edge.from];
      if (mine.node !== ns.node.id || mine.pin !== pg.pin.id) {
        continue;
      }

      const otherNs = this.nodes.get(other.node);
      const otherPg = otherNs?.geom.pins.get(other.pin);
      if (otherNs && otherPg) {
        ends.push({ ns: otherNs, pg: otherPg });
      }
    }

    return ends;
  }

  /** Why the wires of a Ctrl+drag can't move to `target`. */
  protected moveProblem(
    drag: {
      from: { ns: NodeState; pg: PinGeometry };
      ends: ReadonlyArray<{ ns: NodeState; pg: PinGeometry }>;
    },
    target: { ns: NodeState; pg: PinGeometry }
  ): string | null {
    const from = drag.from.pg.pin;
    const to = target.pg.pin;
    if (from.kind === 'exec') {
      return 'Only data wires can be moved together';
    }

    if (to.kind !== from.kind || to.direction !== from.direction) {
      return from.direction === 'out'
        ? 'Move the wires to another output'
        : 'Move the wire to another input';
    }

    for (const end of drag.ends) {
      const problem = this.connectProblem(end, target);
      if (problem) {
        return problem;
      }
    }

    return null;
  }

  /** Why two pins can't be wired, like UE's messages; `null` if they can. */
  protected connectProblem(
    a: { ns: NodeState; pg: PinGeometry },
    b: { ns: NodeState; pg: PinGeometry }
  ): string | null {
    const pa = a.pg.pin;
    const pb = b.pg.pin;
    if (a.ns === b.ns) {
      return 'Both pins are on the same node';
    }

    if (a.ns.fnId !== b.ns.fnId) {
      return 'The pins are in different functions';
    }

    if (pa.kind !== pb.kind) {
      return 'Exec and data pins don’t connect';
    }

    if (pa.direction === pb.direction) {
      return pa.direction === 'in' ? 'Both are inputs' : 'Both are outputs';
    }

    if (pa.kind === 'data') {
      const out = pa.direction === 'out' ? pa : pb;
      const input = pa.direction === 'out' ? pb : pa;
      if (!isTypeCompatible(out.type, input.type)) {
        return `${String(out.type)} is not compatible with ${String(input.type)}`;
      }
    }

    return null;
  }

  protected contextTarget(world: Point): ContextTarget {
    const hit = this.hitTest(world);
    // Zoomed out, pins are too small to aim at: the node's menu instead.
    const pinTarget =
      (hit?.type === 'pin' || hit?.type === 'literal') &&
      this.camera.zoom >= PIN_MENU_ZOOM;
    switch (hit?.type) {
      case 'pin':
      case 'literal':
      case 'node':
      case 'bubble': {
        if (pinTarget && (hit.type === 'pin' || hit.type === 'literal')) {
          return {
            kind: 'pin',
            pin: { node: hit.ns.node.id, pin: hit.pg.pin.id },
          };
        }

        // Like UE: right-clicking an unselected node selects it.
        const id = hit.ns.node.id;
        if (!this.selection.has(id)) {
          this.knotSelection.clear();
          this.setSelectionInternal(new Set([id]));
        }

        return { kind: 'node', nodeId: id };
      }

      case 'knot': {
        return { kind: 'knot', edgeId: hit.edgeId, index: hit.index };
      }

      case 'frame': {
        return hit.frame.kind === 'comment' && hit.frame.boxId
          ? { kind: 'comment', boxId: hit.frame.boxId, fnId: hit.frame.fnId }
          : { kind: 'function', fnId: hit.frame.fnId };
      }

      case undefined: {
        const wire = this.hitWire(world, this.wireTolerance());
        return wire
          ? { kind: 'wire', edge: wire.edge }
          : { kind: 'background' };
      }
    }
  }
}
