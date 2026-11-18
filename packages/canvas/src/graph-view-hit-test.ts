import type { PinGeometry, Point } from '@vizscript/core';
import { rectContains, screenToWorld } from './camera';
import { GraphViewBase } from './graph-view-base';
import { PIN_MENU_ZOOM } from './graph-view-constants';
import type { ContextTarget, Hit, NodeState } from './graph-view-types';
import { hitTest, topFirst } from './hit-test';

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

  /** What is under a world point (`hitTest` of `hit-test.ts`). */
  protected hitTest(world: Point): Hit | null {
    this.updateFrames();
    return hitTest(
      {
        zoom: this.camera.zoom,
        editable: this.editable,
        nodesAt: (rect) =>
          topFirst(this.index.query(rect), this.selection)
            .map((id) => this.nodes.get(id))
            .filter((ns): ns is NodeState => ns !== undefined),
        nodes: this.nodes.values(),
        reroutes: this.reroutes,
        frames: this.frames,
        literalRect: (ns, pg) => this.literalRect(ns, pg),
        bubbleRect: (ns) => this.bubbleRect(ns),
      },
      world
    );
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
