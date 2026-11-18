import {
  boxColorIndex,
  COMMENT_BOX_COLORS,
  computeNodeGeometry,
  extractReroutes,
  isAdvancedPin,
  isCompact,
  literalWidth,
  NODE_METRICS,
  noReroutesKey,
  pinKey,
  pinLabel,
  reroutePatch,
  wiredNodes,
  withImplicitSelf,
} from '@vizscript/core';
import type {
  GraphDocument,
  GraphEdge,
  GraphNode,
  LayoutPatch,
  MeasureText,
  NodeGeometry,
  PinGeometry,
  Point,
  Positions,
} from '@vizscript/core';
import type { AlignNode } from './align';
import { levelEdge } from './align';
import { distanceToShape, reroutedShapes, wireShape } from './bezier';
import type { WireShape } from './bezier';
import { BUBBLE_GAP, bubbleText, layoutBubble } from './bubble';
import { rectContains, unionRect } from './camera';
import type { Rect } from './camera';
import {
  ADVANCED_ROW,
  BANNER_GAP,
  BANNER_HEIGHT,
  COMMENT_HEADER,
  COMMENT_PADDING,
  FRAME_HEADER,
  FRAME_PADDING,
  parseKnotId,
} from './graph-view-constants';
import type {
  FrameState,
  Hit,
  NodeBannerKind,
  NodeState,
  WireHit,
} from './graph-view-types';
import { hitTest, topFirst } from './hit-test';
import type { PinRef } from './pin-ref';
import { SpatialIndex } from './spatial-index';

/** What a hit test needs to know of the view besides the scene. */
export interface HitView {
  zoom: number;
  editable: boolean;
  /** Selected nodes are drawn on top. */
  selection: ReadonlySet<string>;
}

/**
 * The shown document as the canvas draws it: nodes with their geometry
 * and positions, wires, reroute points, function frames and comment boxes,
 * and where each of them is.
 */
export class Scene {
  public doc: GraphDocument | null = null;
  public nodes = new Map<string, NodeState>();
  public edges: Array<{ edge: GraphEdge; fnId: string }> = [];
  public edgesById = new Map<string, GraphEdge>();
  public edgesByNode = new Map<string, GraphEdge[]>();
  /** Pins with a wire (`pinKey`): they show no inline value. */
  public connectedPins = new Set<string>();
  /** Reroute points per edge id (mutable while dragging). */
  public reroutes = new Map<string, Point[]>();
  public frames: FrameState[] = [];
  /** Frame bounds must be computed again (`updateFrames`). */
  public framesDirty = true;
  /** Colors of comment boxes by box id (from the layout). */
  public boxColors = new Map<string, string>();
  public readonly index = new SpatialIndex<string>(256);
  /** Nodes whose advanced pins are shown (UE's ▲). */
  public readonly expandedNodes = new Set<string>();
  /** Nodes with problems (worst severity), shown as banners like UE. */
  public problems = new Map<string, NodeBannerKind>();

  public constructor(private readonly measure: MeasureText) {}

  /**
   * Shows a document at saved `positions`: its functions with UE's
   * implicit `self`, saved reroute points and generated ones for wrapped
   * exec chains. Returns the nodes shown before (to continue their moves).
   */
  public load(
    source: GraphDocument,
    positions: Positions
  ): ReadonlyMap<string, NodeState> {
    // Drawn with UE's implicit `self` (Target boxes instead of wires).
    const doc = {
      ...source,
      functions: source.functions.map(withImplicitSelf),
    };
    this.doc = doc;
    const previous = this.nodes;
    this.nodes = new Map();
    this.edges = [];
    this.edgesById = new Map();
    this.edgesByNode = new Map();
    this.connectedPins = new Set();
    this.frames = [];

    for (const fn of doc.functions) {
      for (const node of fn.nodes) {
        const p = positions[node.id] ?? { x: 0, y: 0 };
        const shown = this.nodeGeometry(node);
        const comment = bubbleText(node.comment);
        this.nodes.set(node.id, {
          node: shown.node,
          full: node,
          advanced: shown.advanced,
          fnId: fn.id,
          geom: shown.geom,
          x: p.x,
          y: p.y,
          bubble: comment ? layoutBubble(comment, this.measure) : null,
        });
      }

      for (const edge of fn.edges) {
        this.edges.push({ edge, fnId: fn.id });
        this.edgesById.set(edge.id, edge);
        for (const id of [edge.from.node, edge.to.node]) {
          const list = this.edgesByNode.get(id) ?? [];
          list.push(edge);
          this.edgesByNode.set(id, list);
        }

        this.connectedPins.add(pinKey(edge.from));
        this.connectedPins.add(pinKey(edge.to));
      }

      const wired = wiredNodes(fn);
      this.frames.push({
        kind: 'function',
        fnId: fn.id,
        name: fn.name,
        // Nodes not wired in yet (a Get just placed, floating nodes) stay
        // outside the frame, so moving them never moves the frame.
        nodeIds: fn.nodes
          .filter((n) => !n.floating && wired.has(n.id))
          .map((n) => n.id),
        bounds: null,
      });
      for (const box of fn.comments ?? []) {
        this.frames.push({
          kind: 'comment',
          fnId: fn.id,
          boxId: box.id,
          name: box.title,
          nodeIds: box.nodes,
          bounds: null,
        });
      }
    }

    this.boxColors = new Map();
    for (const frame of this.frames) {
      const index = frame.boxId ? boxColorIndex(positions, frame.boxId) : 0;
      const color = COMMENT_BOX_COLORS[index]?.color;
      if (frame.boxId && color) {
        this.boxColors.set(frame.boxId, color);
      }
    }

    this.reroutes = new Map();
    for (const [edgeId, points] of Object.entries(extractReroutes(positions))) {
      if (this.edgesById.has(edgeId) && points.length > 0) {
        this.reroutes.set(
          edgeId,
          points.map((p) => ({ ...p }))
        );
      }
    }

    // Exec chains wrapped to a lower row get two reroute points in the gap
    // above it, like one would route them in UE. They follow the nodes
    // until the user moves or removes one (then they are saved).
    for (const { edge } of this.edges) {
      const knots =
        edge.kind === 'exec' &&
        !this.reroutes.has(edge.id) &&
        !positions[noReroutesKey(edge.id)]
          ? this.wrapKnots(edge)
          : undefined;
      if (knots) {
        this.reroutes.set(edge.id, knots);
      }
    }

    this.rebuildIndex();
    return previous;
  }

  /**
   * Sets the nodes with problems; nodes that got or lost a banner change
   * their height. True if one did.
   */
  public setProblems(problems: ReadonlyMap<string, NodeBannerKind>): boolean {
    const before = this.problems;
    this.problems = new Map(problems);
    let resized = false;
    for (const [id, ns] of this.nodes) {
      if (before.has(id) !== this.problems.has(id)) {
        this.reshape(ns);
        resized = true;
      }
    }

    if (resized) {
      this.rebuildIndex();
    }

    this.framesDirty = true;
    return resized;
  }

  /** Shows or hides the advanced pins of a node (UE's ▼ / ▲). */
  public toggleAdvanced(ns: NodeState): void {
    if (this.expandedNodes.has(ns.full.id)) {
      this.expandedNodes.delete(ns.full.id);
    } else {
      this.expandedNodes.add(ns.full.id);
    }

    this.reshape(ns);
    this.rebuildIndex();
  }

  private reshape(ns: NodeState): void {
    const shown = this.nodeGeometry(ns.full);
    ns.node = shown.node;
    ns.geom = shown.geom;
  }

  /** Where each node goes (a sliding node's target). */
  public positions(): Positions {
    const result: Positions = {};
    for (const [id, ns] of this.nodes) {
      result[id] = ns.tween ? { ...ns.tween.to } : { x: ns.x, y: ns.y };
    }

    return result;
  }

  /** A copy of a wire's reroute points. */
  public reroutesOf(edgeId: string): Point[] {
    return (this.reroutes.get(edgeId) ?? []).map((p) => ({ ...p }));
  }

  /** A wire's reroute points with one more at `world`, on its segment. */
  public withReroute(edgeId: string, world: Point): Point[] {
    const segment = this.hitWire(world, Number.POSITIVE_INFINITY, edgeId);
    const points = this.reroutesOf(edgeId);
    points.splice(segment?.segment ?? points.length, 0, {
      x: Math.round(world.x),
      y: Math.round(world.y),
    });
    return points;
  }

  /** Sets a wire's reroute points; returns the change of the layout. */
  public setReroutes(
    edgeId: string,
    points: ReadonlyArray<Point>
  ): LayoutPatch {
    const before = this.reroutesOf(edgeId);
    if (points.length > 0) {
      this.reroutes.set(
        edgeId,
        points.map((p) => ({ ...p }))
      );
    } else {
      this.reroutes.delete(edgeId);
    }

    return reroutePatch(edgeId, before, points);
  }

  /** Removes reroute points (`knotId`s); returns the change of the layout. */
  public removeKnots(ids: Iterable<string>): LayoutPatch {
    const byEdge = new Map<string, Set<number>>();
    for (const id of ids) {
      const { edgeId, index } = parseKnotId(id);
      const set = byEdge.get(edgeId) ?? new Set();
      set.add(index);
      byEdge.set(edgeId, set);
    }

    const patch: LayoutPatch = {};
    for (const [edgeId, indices] of byEdge) {
      const after = this.reroutesOf(edgeId).filter((_, i) => !indices.has(i));
      Object.assign(patch, this.setReroutes(edgeId, after));
    }

    return patch;
  }

  /** The wire Straighten levels for a node, as `alignNodes` takes it. */
  public levelOf(ns: NodeState): Pick<AlignNode, 'level'> {
    const fn = this.doc?.functions.find((f) => f.id === ns.fnId);
    const edge = levelEdge(fn?.edges ?? [], ns.node.id);
    if (!edge) {
      return {};
    }

    const [mine, other] =
      edge.to.node === ns.node.id ? [edge.to, edge.from] : [edge.from, edge.to];
    const otherNs = this.nodes.get(other.node);
    const otherPg = otherNs?.geom.pins.get(other.pin);
    const minePg = ns.geom.pins.get(mine.pin);
    return otherNs && otherPg && minePg
      ? {
          level: {
            pinY: minePg.y,
            other: other.node,
            otherY: otherNs.y,
            otherPinY: otherPg.y,
          },
        }
      : {};
  }

  /** Rendered size of a node; use it for layout so both agree. */
  public sizeOf(node: GraphNode): { width: number; height: number } {
    const { geom } = this.nodeGeometry(node);
    return { width: geom.width, height: geom.height };
  }

  /** Room a node needs above it (its comment bubble); use it for layout. */
  public spaceAbove(node: GraphNode): number {
    const text = bubbleText(node.comment);
    return text ? layoutBubble(text, this.measure).height + BUBBLE_GAP : 0;
  }

  /**
   * A node as drawn: advanced pins (arguments left at their default) fold
   * behind a ▼ row like UE's, unless the node was expanded.
   */
  public nodeGeometry(node: GraphNode): {
    node: GraphNode;
    geom: NodeGeometry;
    advanced: number;
  } {
    const advanced = node.pins.filter(isAdvancedPin).length;
    const shown =
      advanced === 0 || this.expandedNodes.has(node.id)
        ? node
        : { ...node, pins: node.pins.filter((p) => !isAdvancedPin(p)) };
    let geom = computeNodeGeometry(shown, this.measure);
    // UE's ERROR! / WARNING! band sits under the header: the rows move down.
    if (this.problems.has(node.id) && !isCompact(shown)) {
      geom = {
        ...geom,
        height: geom.height + BANNER_HEIGHT,
        pins: new Map(
          [...geom.pins].map(([id, pg]) => [
            id,
            { ...pg, y: pg.y + BANNER_HEIGHT },
          ])
        ),
        ...(geom.addPin
          ? { addPin: { ...geom.addPin, y: geom.addPin.y + BANNER_HEIGHT } }
          : {}),
      };
    }

    return {
      node: shown,
      advanced,
      geom: advanced ? { ...geom, height: geom.height + ADVANCED_ROW } : geom,
    };
  }

  public nodeRect(ns: NodeState): Rect {
    return { x: ns.x, y: ns.y, width: ns.geom.width, height: ns.geom.height };
  }

  public rebuildIndex(): void {
    this.index.clear();
    for (const [id, ns] of this.nodes) {
      this.index.insert(id, this.nodeRect(ns));
    }

    this.framesDirty = true;
  }

  /**
   * Bounds of nodes where they go (a sliding node's target), with their
   * comment bubbles and the banners under compact nodes.
   */
  public boundsOf(ids: Iterable<string>): Rect | null {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const id of ids) {
      const ns = this.nodes.get(id);
      if (!ns) {
        continue;
      }

      const top = ns.bubble ? ns.bubble.height + BUBBLE_GAP : 0;
      const { x, y } = ns.tween?.to ?? ns;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y - top);
      maxX = Math.max(maxX, x + Math.max(ns.geom.width, ns.bubble?.width ?? 0));
      maxY = Math.max(
        maxY,
        y +
          ns.geom.height +
          (this.problems.has(id) && isCompact(ns.node)
            ? BANNER_GAP + BANNER_HEIGHT
            : 0)
      );
    }

    if (!Number.isFinite(minX)) {
      return null;
    }

    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  /** Bounds of comment boxes and function frames around their nodes. */
  public updateFrames(): void {
    if (!this.framesDirty) {
      return;
    }

    // Comment boxes, inner (fewer nodes) first so outer boxes contain them.
    const boxes = this.frames
      .filter((f) => f.kind === 'comment')
      .toSorted((a, b) => a.nodeIds.length - b.nodeIds.length);
    const done: FrameState[] = [];
    for (const box of boxes) {
      const members = new Set(box.nodeIds);
      let b = this.boundsOf(box.nodeIds);
      for (const inner of done) {
        if (inner.bounds && inner.nodeIds.every((id) => members.has(id))) {
          b = b ? unionRect(b, inner.bounds) : inner.bounds;
        }
      }

      box.bounds = b
        ? {
            x: b.x - COMMENT_PADDING,
            y: b.y - COMMENT_PADDING - COMMENT_HEADER,
            width: b.width + COMMENT_PADDING * 2,
            height: b.height + COMMENT_PADDING * 2 + COMMENT_HEADER,
          }
        : null;
      done.push(box);
    }

    for (const frame of this.frames) {
      if (frame.kind !== 'function') {
        continue;
      }

      let b = this.boundsOf(frame.nodeIds);
      for (const box of done) {
        if (box.fnId === frame.fnId && box.bounds) {
          b = b ? unionRect(b, box.bounds) : box.bounds;
        }
      }

      frame.bounds = b
        ? {
            x: b.x - FRAME_PADDING,
            y: b.y - FRAME_PADDING - FRAME_HEADER,
            width: b.width + FRAME_PADDING * 2,
            height: b.height + FRAME_PADDING * 2 + FRAME_HEADER,
          }
        : null;
    }

    this.framesDirty = false;
  }

  /** World rectangle of a node's comment bubble. */
  public bubbleRect(ns: NodeState): Rect | null {
    if (!ns.bubble) {
      return null;
    }

    return {
      x: ns.x,
      y: ns.y - BUBBLE_GAP - ns.bubble.height,
      width: ns.bubble.width,
      height: ns.bubble.height,
    };
  }

  public pinWorld(ns: NodeState, pg: PinGeometry): Point {
    return { x: ns.x + pg.x, y: ns.y + pg.y };
  }

  /** Where an unwired input's inline value is drawn, if it has one. */
  public literalRect(ns: NodeState, pg: PinGeometry): Rect | null {
    const pin = pg.pin;
    if (
      !pin.literal ||
      pg.side !== 'left' ||
      this.connectedPins.has(pinKey({ node: ns.node.id, pin: pin.id }))
    ) {
      return null;
    }

    const text = pinLabel(ns.node, pin);
    const label = text ? this.measure(text, 'label') : 0;
    const x =
      ns.x +
      pg.x +
      NODE_METRICS.pinRadius +
      NODE_METRICS.pinLabelGap +
      label +
      (label ? 6 : 0);
    const width = literalWidth(pin, this.measure);
    return {
      x,
      y: ns.y + pg.y - NODE_METRICS.literalHeight / 2,
      width,
      height: NODE_METRICS.literalHeight,
    };
  }

  /** The curves of a wire, one per segment between reroute points. */
  public edgeWire(edge: GraphEdge): WireShape[] | null {
    const from = this.nodes.get(edge.from.node);
    const to = this.nodes.get(edge.to.node);
    const fromPin = from?.geom.pins.get(edge.from.pin);
    const toPin = to?.geom.pins.get(edge.to.pin);
    if (!from || !to || !fromPin || !toPin) {
      return null;
    }

    const knots = this.reroutes.get(edge.id);
    if (knots && knots.length > 0) {
      return reroutedShapes(
        this.pinWorld(from, fromPin),
        this.pinWorld(to, toPin),
        knots
      );
    }

    // UE's spline, also backwards (an S-loop) and for wrapped exec chains.
    return [wireShape(this.pinWorld(from, fromPin), this.pinWorld(to, toPin))];
  }

  /**
   * Reroute points for a wire running back to a lower row (a wrapped exec
   * chain): one right of its output, one left of its input, both in the
   * gap above the lower row. `undefined` for other wires.
   */
  public wrapKnots(edge: GraphEdge): Point[] | undefined {
    const from = this.nodes.get(edge.from.node);
    const to = this.nodes.get(edge.to.node);
    const fromPin = from?.geom.pins.get(edge.from.pin);
    const toPin = to?.geom.pins.get(edge.to.pin);
    if (!from || !to || !fromPin || !toPin) {
      return undefined;
    }

    const start = this.pinWorld(from, fromPin);
    const end = this.pinWorld(to, toPin);
    if (end.x > start.x - 60 || to.y < from.y + from.geom.height + 24) {
      return undefined;
    }

    const laneY = Math.round(to.y - 22);
    return [
      { x: Math.round(start.x + 40), y: laneY },
      { x: Math.round(end.x - 40), y: laneY },
    ];
  }

  /** Nearest wire within `tolerance` (world units), optionally of one edge. */
  public hitWire(
    world: Point,
    tolerance: number,
    onlyEdge?: string
  ): WireHit | null {
    let best: WireHit | null = null;
    let bestDistance = tolerance;
    const candidates = onlyEdge
      ? [this.edgesById.get(onlyEdge)].filter(
          (e): e is GraphEdge => e !== undefined
        )
      : this.edges.map((e) => e.edge);
    for (const edge of candidates) {
      const shapes = this.edgeWire(edge);
      if (!shapes) {
        continue;
      }

      for (const [segment, shape] of shapes.entries()) {
        const b = shape.bounds;
        if (
          Number.isFinite(tolerance) &&
          (world.x < b.x - tolerance ||
            world.x > b.x + b.width + tolerance ||
            world.y < b.y - tolerance ||
            world.y > b.y + b.height + tolerance)
        ) {
          continue;
        }

        const distance = distanceToShape(shape, world);
        if (distance <= bestDistance) {
          bestDistance = distance;
          best = { edge, segment };
        }
      }
    }

    return best;
  }

  /** What is under a world point (`hitTest` of `hit-test.ts`). */
  public hitTest(world: Point, view: HitView): Hit | null {
    this.updateFrames();
    return hitTest(
      {
        zoom: view.zoom,
        editable: view.editable,
        nodesAt: (rect) =>
          topFirst(this.index.query(rect), view.selection)
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

  /** The pins at the other end of a pin's wires. */
  public wireEnds(ns: NodeState, pg: PinGeometry): PinRef[] {
    const fn = this.doc?.functions.find((f) => f.id === ns.fnId);
    const ends: PinRef[] = [];
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
}
