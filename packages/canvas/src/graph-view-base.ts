import {
  computeNodeGeometry,
  isAdvancedPin,
  literalWidth,
  NODE_METRICS,
  pinKey,
  pinLabel,
} from '@vizscript/core';
import type {
  GraphDocument,
  GraphEdge,
  GraphNode,
  MeasureText,
  NodeGeometry,
  PinGeometry,
  Point,
  TextStyle,
} from '@vizscript/core';
import { distanceToShape, reroutedShapes, wireShape } from './bezier';
import type { WireShape } from './bezier';
import { BUBBLE_GAP } from './bubble';
import { screenToWorld, unionRect } from './camera';
import type { Camera, Rect } from './camera';
import { Emitter } from './emitter';
import {
  ADVANCED_ROW,
  BANNER_GAP,
  BANNER_HEIGHT,
  COMMENT_HEADER,
  COMMENT_PADDING,
  FRAME_HEADER,
  FRAME_PADDING,
} from './graph-view-constants';
import type {
  Drag,
  FrameState,
  GraphViewEvents,
  GraphViewOptions,
  NodeBannerKind,
  NodeState,
  Tween,
  WireHit,
} from './graph-view-types';
import { SpatialIndex } from './spatial-index';
import { DARK_THEME } from './theme';
import type { Theme } from './theme';

/** State of a `GraphView` and the geometry all its parts share. */
export abstract class GraphViewBase {
  protected readonly ctx: CanvasRenderingContext2D;
  private readonly measureCtx: CanvasRenderingContext2D;
  protected readonly emitter = new Emitter<GraphViewEvents>();
  private readonly textCache = new Map<string, number>();
  protected readonly index = new SpatialIndex<string>(256);

  protected theme: Theme;
  protected editable: boolean;
  protected doc: GraphDocument | null = null;
  /** Colors of comment boxes by box id (from the layout). */
  protected boxColors = new Map<string, string>();
  protected nodes = new Map<string, NodeState>();
  protected edges: Array<{ edge: GraphEdge; fnId: string }> = [];
  protected edgesById = new Map<string, GraphEdge>();
  protected edgesByNode = new Map<string, GraphEdge[]>();
  /** Reroute points per edge id (mutable while dragging). */
  protected reroutes = new Map<string, Point[]>();
  protected knotSelection = new Set<string>();
  protected hoverEdge: string | null = null;
  /** Wire dropped on empty space, drawn while its menu is open. */
  protected pendingWire: {
    from: { ns: NodeState; pg: PinGeometry };
    world: Point;
  } | null = null;
  protected connectedPins = new Set<string>();
  /** Nodes whose advanced pins are shown (UE's ▲). */
  protected expandedNodes = new Set<string>();
  protected frames: FrameState[] = [];
  protected framesDirty = true;

  protected camera: Camera = { x: -40, y: -40, zoom: 1 };
  protected motion: boolean;
  protected cameraTween: Tween<Camera> | null = null;
  /** Time of the frame being drawn (for fades and pulses). */
  protected frameTime = 0;
  protected width = 0;
  protected height = 0;
  protected dpr = 1;

  protected selection = new Set<string>();
  protected highlight = new Set<string>();
  /** Nodes with problems (worst severity), shown as banners like UE. */
  protected problems = new Map<string, NodeBannerKind>();
  protected hoverNode: string | null = null;
  protected hoverPin: string | null = null;
  protected drag: Drag | null = null;
  private frameRequested = false;
  protected hasFramed = false;

  public constructor(
    protected readonly canvas: HTMLCanvasElement,
    options: GraphViewOptions = {}
  ) {
    const ctx = canvas.getContext('2d');
    const measureCtx = document.createElement('canvas').getContext('2d');
    if (!ctx || !measureCtx) {
      throw new Error('Canvas 2D is not supported');
    }

    this.ctx = ctx;
    this.measureCtx = measureCtx;
    this.theme = options.theme ?? DARK_THEME;
    this.editable = options.editable ?? true;
    this.motion = options.motion ?? false;
  }

  public on<K extends keyof GraphViewEvents>(
    event: K,
    handler: (payload: GraphViewEvents[K]) => void
  ): () => void {
    return this.emitter.on(event, handler);
  }

  /** Draws a frame; `requestRender` schedules one. */
  protected abstract render(): void;

  public requestRender(): void {
    if (this.frameRequested) {
      return;
    }

    this.frameRequested = true;
    requestAnimationFrame(() => {
      this.frameRequested = false;
      this.render();
    });
  }

  protected font(style: TextStyle): string {
    const family = this.theme.fontFamily;
    switch (style) {
      case 'title': {
        return `600 13px ${family}`;
      }

      case 'subtitle': {
        return `italic 11px ${family}`;
      }

      case 'label': {
        return `12px ${family}`;
      }

      case 'literal': {
        return `12px ${this.theme.monoFontFamily}`;
      }

      case 'compact': {
        return `600 14px ${family}`;
      }

      case 'glyph': {
        return `700 26px ${family}`;
      }
    }
  }

  protected readonly measure: MeasureText = (text, style) => {
    const key = `${style}\u0000${text}`;
    let width = this.textCache.get(key);
    if (width === undefined) {
      this.measureCtx.font = this.font(style);
      width = this.measureCtx.measureText(text).width;
      this.textCache.set(key, width);
    }

    return width;
  };

  /**
   * A node as drawn: advanced pins (arguments left at their default) fold
   * behind a ▼ row like UE's, unless the node was expanded.
   */
  protected nodeGeometry(node: GraphNode): {
    node: GraphNode;
    geom: NodeGeometry;
    advanced: number;
  } {
    const advanced = node.pins.filter(isAdvancedPin).length;
    const shown =
      advanced === 0 || this.expandedNodes.has(node.id)
        ? node
        : { ...node, pins: node.pins.filter((p) => !isAdvancedPin(p)) };
    const geom = computeNodeGeometry(shown, this.measure);
    return {
      node: shown,
      advanced,
      geom: advanced ? { ...geom, height: geom.height + ADVANCED_ROW } : geom,
    };
  }

  protected nodeRect(ns: NodeState): Rect {
    return { x: ns.x, y: ns.y, width: ns.geom.width, height: ns.geom.height };
  }

  protected rebuildIndex(): void {
    this.index.clear();
    for (const [id, ns] of this.nodes) {
      this.index.insert(id, this.nodeRect(ns));
    }

    this.framesDirty = true;
  }

  protected boundsOf(ids: Iterable<string>): Rect | null {
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
          (this.problems.has(id) ? BANNER_GAP + BANNER_HEIGHT : 0)
      );
    }

    if (!Number.isFinite(minX)) {
      return null;
    }

    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  protected updateFrames(): void {
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
  protected bubbleRect(ns: NodeState): Rect | null {
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

  protected pinWorld(ns: NodeState, pg: PinGeometry): Point {
    return { x: ns.x + pg.x, y: ns.y + pg.y };
  }

  protected literalRect(ns: NodeState, pg: PinGeometry): Rect | null {
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

  protected edgeWire(edge: GraphEdge): WireShape[] | null {
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

    // Route backward wires through the gap above the lower node's row.
    const fromBottom = from.y + from.geom.height;
    const toBottom = to.y + to.geom.height;
    const laneY =
      to.y > fromBottom + 24
        ? to.y - 22
        : from.y > toBottom + 24
          ? from.y - 22
          : Math.max(fromBottom, toBottom) + 22;
    return [
      wireShape(this.pinWorld(from, fromPin), this.pinWorld(to, toPin), laneY),
    ];
  }

  /** Nearest wire within `tolerance` (world units), optionally of one edge. */
  protected hitWire(
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

  protected wireTolerance(): number {
    return 8 / this.camera.zoom;
  }

  protected setSelectionInternal(selection: Set<string>): void {
    const changed =
      selection.size !== this.selection.size ||
      [...selection].some((id) => !this.selection.has(id));
    this.selection = selection;
    if (changed) {
      this.emitter.emit('selectionChange', { nodeIds: [...selection] });
    }

    this.requestRender();
  }

  protected setHover(nodeId: string | null, pin: string | null): void {
    if (nodeId === this.hoverNode && pin === this.hoverPin) {
      return;
    }

    this.hoverNode = nodeId;
    this.hoverPin = pin;
    this.emitter.emit('hoverChange', { nodeId, pin });
    this.requestRender();
  }

  protected clientPoint(e: MouseEvent): Point {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  protected toWorld(e: MouseEvent): Point {
    return screenToWorld(this.camera, this.clientPoint(e));
  }
}
