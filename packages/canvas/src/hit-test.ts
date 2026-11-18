import { NODE_METRICS } from '@vizscript/core';
import type { PinGeometry, Point } from '@vizscript/core';
import type { Rect } from './camera';
import { rectContains, rectsIntersect } from './camera';
import {
  ADVANCED_ROW,
  COMMENT_HEADER,
  FRAME_HEADER,
  KNOT_RADIUS,
} from './graph-view-constants';
import type { FrameState, Hit, NodeState } from './graph-view-types';

/** What `hitTest` looks at. */
export interface HitScene {
  zoom: number;
  editable: boolean;
  /** Nodes whose rectangles meet `rect`, the one drawn on top first. */
  nodesAt: (rect: Rect) => ReadonlyArray<NodeState>;
  /** All nodes (for comment bubbles, which lie above them). */
  nodes: Iterable<NodeState>;
  /** Reroute points by edge id. */
  reroutes: ReadonlyMap<string, ReadonlyArray<Point>>;
  frames: ReadonlyArray<FrameState>;
  /** Where an unwired input's inline value is drawn, if it has one. */
  literalRect: (ns: NodeState, pg: PinGeometry) => Rect | null;
  /** Where a node's comment bubble is drawn, if it has one. */
  bubbleRect: (ns: NodeState) => Rect | null;
}

/**
 * Ids in drawing order (`SpatialIndex.query`), turned top first: the
 * reverse, with the `selected` ones, drawn last, before the others.
 */
export function topFirst(
  ids: ReadonlyArray<string>,
  selected: ReadonlySet<string>
): string[] {
  return ids
    .toReversed()
    .toSorted((a, b) => Number(selected.has(b)) - Number(selected.has(a)));
}

/** Whether `world` is on the node's "Add pin +" button (its row). */
function onAddPin(ns: NodeState, world: Point): boolean {
  const button = ns.geom.addPin;
  if (!button) {
    return false;
  }

  const x = world.x - ns.x - button.x;
  const y = world.y - ns.y - button.y;
  return (
    x >= -2 &&
    x <= button.width + 2 &&
    Math.abs(y) <= NODE_METRICS.rowHeight / 2
  );
}

/** What a click at a world point lands on, in the order it is drawn. */
function nodeHit(
  scene: HitScene,
  candidates: ReadonlyArray<NodeState>,
  world: Point
): Hit | null {
  // Pins stick out of their node: they go first, with some slack.
  const pinRadius = Math.max(9, 7 / scene.zoom);
  for (const ns of candidates) {
    for (const pg of ns.geom.pins.values()) {
      const p = { x: ns.x + pg.x, y: ns.y + pg.y };
      if (Math.hypot(p.x - world.x, p.y - world.y) <= pinRadius) {
        return { type: 'pin', ns, pg };
      }
    }
  }

  const point = { x: world.x, y: world.y, width: 0.01, height: 0.01 };
  for (const ns of candidates) {
    const rect = {
      x: ns.x,
      y: ns.y,
      width: ns.geom.width,
      height: ns.geom.height,
    };
    if (!rectsIntersect(rect, point)) {
      continue;
    }

    for (const pg of ns.geom.pins.values()) {
      const r = scene.literalRect(ns, pg);
      if (r && rectContains(r, world)) {
        return { type: 'literal', ns, pg };
      }
    }

    if (scene.editable && onAddPin(ns, world)) {
      return { type: 'node', ns, addPin: true };
    }

    const advanced =
      ns.advanced > 0 && world.y >= ns.y + ns.geom.height - ADVANCED_ROW;
    return advanced ? { type: 'node', ns, advanced } : { type: 'node', ns };
  }

  return null;
}

/**
 * What is under a world point, the way it is drawn: pins, then nodes
 * (inline values, "Add pin +", the ▼ row), the top one first; reroute
 * points (on wires, under the nodes); comment bubbles; frame headers, inner
 * comment boxes before function frames. `null`: empty space or a wire.
 */
export function hitTest(scene: HitScene, world: Point): Hit | null {
  const pad = Math.max(9, 7 / scene.zoom);
  const candidates = scene.nodesAt({
    x: world.x - pad,
    y: world.y - pad,
    width: pad * 2,
    height: pad * 2,
  });
  const onNode = nodeHit(scene, candidates, world);
  if (onNode) {
    return onNode;
  }

  const knotRadius = Math.max(KNOT_RADIUS + 3, 8 / scene.zoom);
  for (const [edgeId, points] of scene.reroutes) {
    for (const [index, p] of points.entries()) {
      if (Math.hypot(p.x - world.x, p.y - world.y) <= knotRadius) {
        return { type: 'knot', edgeId, index };
      }
    }
  }

  for (const ns of scene.nodes) {
    const r = scene.bubbleRect(ns);
    if (r && rectContains(r, world)) {
      return { type: 'bubble', ns };
    }
  }

  const frames = scene.frames.toSorted(
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
