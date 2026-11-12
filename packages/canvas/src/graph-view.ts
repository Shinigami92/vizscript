import type {
  GraphDocument,
  GraphEdge,
  GraphNode,
  GraphOp,
  LayoutPatch,
  LiteralKind,
  MeasureText,
  NodeGeometry,
  Pin,
  PinGeometry,
  PinRef,
  Point,
  Positions,
  TextStyle,
} from '@vizscript/core';
import {
  computeNodeGeometry,
  extractReroutes,
  isArrayType,
  isTypeCompatible,
  literalWidth,
  NODE_METRICS,
  pinColor,
  pinKey,
  reroutePatch,
} from '@vizscript/core';
import type { WireShape } from './bezier';
import {
  distanceToShape,
  reroutedShapes,
  wireCurve,
  wireShape,
} from './bezier';
import type { BubbleLayout } from './bubble';
import {
  BUBBLE_GAP,
  BUBBLE_LINE_HEIGHT,
  BUBBLE_PADDING_X,
  BUBBLE_PADDING_Y,
  bubbleText,
  COMMENT_BOX_HEADER,
  COMMENT_BOX_PADDING,
  layoutBubble,
} from './bubble';
import type { Camera, Rect } from './camera';
import {
  fitCamera,
  normalizeRect,
  rectContains,
  rectsIntersect,
  screenToWorld,
  unionRect,
  visibleWorldRect,
  worldToScreen,
  zoomAt,
} from './camera';
import { Emitter } from './emitter';
import type { SelectionModifiers } from './selection';
import { clickSelection, marqueeSelection } from './selection';
import { SpatialIndex } from './spatial-index';
import type { Theme } from './theme';
import { DARK_THEME } from './theme';

/** What a context menu was opened on. */
export type ContextTarget =
  | { kind: 'background' }
  | { kind: 'node'; nodeId: string }
  | { kind: 'pin'; pin: PinRef }
  | { kind: 'wire'; edge: GraphEdge }
  | { kind: 'knot'; edgeId: string; index: number }
  | { kind: 'function'; fnId: string }
  | { kind: 'comment'; boxId: string; fnId: string };

/** A comment that can be edited in place. */
export type CommentTarget =
  | { kind: 'node'; nodeId: string }
  | { kind: 'box'; boxId: string };

export interface GraphViewEvents {
  selectionChange: { nodeIds: string[] };
  hoverChange: { nodeId: string | null; pin: string | null };
  /**
   * Fired once at the end of a drag or when reroute points change. Node ids
   * map to positions; reroute keys (see `rerouteKey`) to knot positions.
   */
  layoutChange: { patch: LayoutPatch };
  op: GraphOp;
  editLiteral: {
    node: string;
    pin: string;
    value: string;
    kind: LiteralKind;
    /** Client (viewport) coordinates of the literal box. */
    rect: Rect;
  };
  contextMenu: {
    world: Point;
    client: Point;
    target: ContextTarget;
    /** Set when a wire dragged out of this pin was dropped on empty space. */
    from?: PinRef;
  };
  activate: { nodeId: string };
  /** Double-click on a comment bubble or comment box title. */
  editComment: {
    target: CommentTarget;
    value: string;
    /** Client (viewport) coordinates of the edited text. */
    rect: Rect;
  };
  cameraChange: Camera;
  message: { text: string };
}

export interface GraphViewOptions {
  /** Allow graph edits (wiring, deleting, literal edits). */
  editable?: boolean;
  theme?: Theme;
}

interface NodeState {
  node: GraphNode;
  fnId: string;
  geom: NodeGeometry;
  x: number;
  y: number;
  /** Comment bubble above the node. */
  bubble: BubbleLayout | null;
}

interface FrameState {
  /** A function frame, or a comment box (code region) inside one. */
  kind: 'function' | 'comment';
  fnId: string;
  /** Comment box id (for `comment` frames). */
  boxId?: string;
  name: string;
  nodeIds: string[];
  bounds: Rect | null;
}

type Hit =
  | { type: 'pin'; ns: NodeState; pg: PinGeometry }
  | { type: 'literal'; ns: NodeState; pg: PinGeometry }
  | { type: 'node'; ns: NodeState }
  | { type: 'bubble'; ns: NodeState }
  | { type: 'knot'; edgeId: string; index: number }
  | { type: 'frame'; frame: FrameState };

interface WireHit {
  edge: GraphEdge;
  /** Index of the wire segment (between two knots) that was hit. */
  segment: number;
}

type Drag =
  | {
      type: 'pan';
      startClient: Point;
      startCamera: Camera;
      moved: boolean;
      button: number;
      tapNode: string | null;
    }
  | {
      type: 'nodes';
      ids: string[];
      startWorld: Point;
      origins: Map<string, Point>;
      knotOrigins: Map<string, Point>;
      moved: boolean;
    }
  | {
      type: 'marquee';
      startWorld: Point;
      currentWorld: Point;
      base: Set<string>;
      baseKnots: Set<string>;
      mods: SelectionModifiers;
    }
  | {
      type: 'wire';
      from: { ns: NodeState; pg: PinGeometry };
      currentWorld: Point;
      target: { ns: NodeState; pg: PinGeometry } | null;
    }
  | {
      type: 'pinch';
      startDistance: number;
      startMid: Point;
      startCamera: Camera;
    };

const FRAME_PADDING = 32;
const FRAME_HEADER = 34;
/** Height of the ERROR / WARNING banner below a node, and its gap. */
const BANNER_HEIGHT = 17;
const BANNER_GAP = 3;
const COMMENT_PADDING = COMMENT_BOX_PADDING;
const COMMENT_HEADER = COMMENT_BOX_HEADER;
const DRAG_THRESHOLD = 3;
const KNOT_RADIUS = 6;

function knotId(edgeId: string, index: number): string {
  return `${edgeId}\u0000${index}`;
}

function parseKnotId(id: string): { edgeId: string; index: number } {
  const separator = id.lastIndexOf('\u0000');
  return {
    edgeId: id.slice(0, separator),
    index: Number(id.slice(separator + 1)),
  };
}

/**
 * Framework-agnostic Canvas2D renderer and interaction controller for
 * Blueprint-style graphs.
 */
export class GraphView {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly measureCtx: CanvasRenderingContext2D;
  private readonly emitter = new Emitter<GraphViewEvents>();
  private readonly textCache = new Map<string, number>();
  private readonly index = new SpatialIndex<string>(256);
  private readonly resizeObserver: ResizeObserver;
  private readonly pointers = new Map<number, Point>();
  private readonly disposers: Array<() => void> = [];

  private theme: Theme;
  private editable: boolean;
  private doc: GraphDocument | null = null;
  private nodes = new Map<string, NodeState>();
  private edges: Array<{ edge: GraphEdge; fnId: string }> = [];
  private edgesById = new Map<string, GraphEdge>();
  private edgesByNode = new Map<string, GraphEdge[]>();
  /** Reroute points per edge id (mutable while dragging). */
  private reroutes = new Map<string, Point[]>();
  private knotSelection = new Set<string>();
  private hoverEdge: string | null = null;
  /** Wire dropped on empty space, drawn while its menu is open. */
  private pendingWire: {
    from: { ns: NodeState; pg: PinGeometry };
    world: Point;
  } | null = null;
  private connectedPins = new Set<string>();
  private frames: FrameState[] = [];
  private framesDirty = true;

  private camera: Camera = { x: -40, y: -40, zoom: 1 };
  private width = 0;
  private height = 0;
  private dpr = 1;

  private selection = new Set<string>();
  private highlight = new Set<string>();
  /** Nodes with problems (worst severity), shown as banners like UE. */
  private problems = new Map<string, 'error' | 'warning' | 'info'>();
  private hoverNode: string | null = null;
  private hoverPin: string | null = null;
  private drag: Drag | null = null;
  private spaceDown = false;
  private frameRequested = false;
  private hasFramed = false;

  public constructor(
    private readonly canvas: HTMLCanvasElement,
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

    canvas.tabIndex = 0;
    canvas.style.touchAction = 'none';
    canvas.style.outline = 'none';

    this.listen(canvas, 'pointerdown', (e) => this.onPointerDown(e));
    this.listen(canvas, 'pointermove', (e) => this.onPointerMove(e));
    this.listen(canvas, 'pointerup', (e) => this.onPointerUp(e));
    this.listen(canvas, 'pointercancel', (e) => this.onPointerUp(e));
    this.listen(canvas, 'pointerleave', () => {
      this.hoverEdge = null;
      this.setHover(null, null);
    });
    this.listen(canvas, 'dblclick', (e) => this.onDoubleClick(e));
    this.listen(canvas, 'wheel', (e) => this.onWheel(e), { passive: false });
    this.listen(canvas, 'contextmenu', (e) => e.preventDefault());
    this.listen(canvas, 'keydown', (e) => this.onKeyDown(e));
    this.listen(canvas, 'keyup', (e) => {
      if (e.code === 'Space') {
        this.spaceDown = false;
      }
    });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
  }

  // ------------------------------------------------------------ public API

  public on<K extends keyof GraphViewEvents>(
    event: K,
    handler: (payload: GraphViewEvents[K]) => void
  ): () => void {
    return this.emitter.on(event, handler);
  }

  public destroy(): void {
    this.resizeObserver.disconnect();
    for (const dispose of this.disposers) {
      dispose();
    }

    this.emitter.clear();
  }

  /** Switches colors, e.g. between `DARK_THEME` and `LIGHT_THEME`. */
  public setTheme(theme: Theme): void {
    this.theme = theme;
    this.requestRender();
  }

  public setEditable(editable: boolean): void {
    this.editable = editable;
  }

  public setDocument(doc: GraphDocument, positions: Positions): void {
    this.doc = doc;
    this.nodes = new Map();
    this.edges = [];
    this.edgesById = new Map();
    this.edgesByNode = new Map();
    this.connectedPins = new Set();
    this.frames = [];

    for (const fn of doc.functions) {
      for (const node of fn.nodes) {
        const p = positions[node.id] ?? { x: 0, y: 0 };
        this.nodes.set(node.id, {
          node,
          fnId: fn.id,
          geom: computeNodeGeometry(node, this.measure),
          x: p.x,
          y: p.y,
          bubble: bubbleText(node.comment)
            ? layoutBubble(bubbleText(node.comment), this.measure)
            : null,
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

      this.frames.push({
        kind: 'function',
        fnId: fn.id,
        name: fn.name,
        nodeIds: fn.nodes.map((n) => n.id),
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

    this.reroutes = new Map();
    for (const [edgeId, points] of Object.entries(extractReroutes(positions))) {
      if (this.edgesById.has(edgeId) && points.length > 0) {
        this.reroutes.set(
          edgeId,
          points.map((p) => ({ ...p }))
        );
      }
    }

    this.selection = new Set(
      [...this.selection].filter((id) => this.nodes.has(id))
    );
    this.knotSelection = new Set(
      [...this.knotSelection].filter((id) => {
        const { edgeId, index } = parseKnotId(id);
        return (this.reroutes.get(edgeId)?.length ?? 0) > index;
      })
    );
    this.highlight = new Set(
      [...this.highlight].filter((id) => this.nodes.has(id))
    );
    if (this.hoverNode && !this.nodes.has(this.hoverNode)) {
      this.hoverNode = null;
      this.hoverPin = null;
    }

    if (this.hoverEdge && !this.edgesById.has(this.hoverEdge)) {
      this.hoverEdge = null;
    }

    this.rebuildIndex();
    if (!this.hasFramed && this.nodes.size > 0 && this.width > 0) {
      this.hasFramed = true;
      this.initialView();
    }

    this.requestRender();
  }

  /** Rendered size of a node; use it for layout so both agree. */
  public readonly sizeOf = (
    node: GraphNode
  ): { width: number; height: number } => {
    const geom = computeNodeGeometry(node, this.measure);
    return { width: geom.width, height: geom.height };
  };

  /** Room a node needs above it (its comment bubble); use it for layout. */
  public readonly spaceAbove = (node: GraphNode): number => {
    const text = bubbleText(node.comment);
    return text ? layoutBubble(text, this.measure).height + BUBBLE_GAP : 0;
  };

  public getPositions(): Positions {
    const result: Positions = {};
    for (const [id, ns] of this.nodes) {
      result[id] = { x: ns.x, y: ns.y };
    }

    return result;
  }

  public getSelection(): string[] {
    return [...this.selection];
  }

  public setSelection(ids: ReadonlyArray<string>): void {
    this.selection = new Set(ids.filter((id) => this.nodes.has(id)));
    this.knotSelection.clear();
    this.requestRender();
  }

  public selectAll(): void {
    this.knotSelection = new Set(
      [...this.reroutes].flatMap(([edgeId, points]) =>
        points.map((_, i) => knotId(edgeId, i))
      )
    );
    this.setSelectionInternal(new Set(this.nodes.keys()));
  }

  /** Selects every node of a function (like clicking its frame title). */
  public selectFunction(fnId: string): void {
    const frame = this.frames.find((f) => f.fnId === fnId);
    if (frame) {
      this.knotSelection.clear();
      this.setSelectionInternal(new Set(frame.nodeIds));
    }
  }

  /** Zooms to the selection, or to everything when nothing is selected. */
  public frameSelection(): void {
    const bounds = this.boundsOf(this.selection);
    if (bounds) {
      this.setCameraInternal(fitCamera(bounds, this.width, this.height, 80, 1));
    } else {
      this.frameAll();
    }
  }

  /** Centers the given nodes at a readable zoom. */
  public focusNodes(ids: ReadonlyArray<string>): void {
    const bounds = this.boundsOf(ids);
    if (!bounds || this.width === 0) {
      return;
    }

    const zoom = Math.max(this.camera.zoom, 0.8);
    const fit = fitCamera(bounds, this.width, this.height, 80, zoom);
    this.setCameraInternal(
      fit.zoom < zoom * 0.99
        ? fit
        : {
            zoom,
            x: bounds.x + bounds.width / 2 - this.width / 2 / zoom,
            y: bounds.y + bounds.height / 2 - this.height / 2 / zoom,
          }
    );
  }

  /** Removes the wire left over from a drop on empty space. */
  public clearPendingWire(): void {
    if (this.pendingWire) {
      this.pendingWire = null;
      this.requestRender();
    }
  }

  public getEdge(edgeId: string): GraphEdge | undefined {
    return this.edgesById.get(edgeId);
  }

  public getReroutes(edgeId: string): Point[] {
    return (this.reroutes.get(edgeId) ?? []).map((p) => ({ ...p }));
  }

  /** Adds a reroute point on the wire, at the segment nearest to `world`. */
  public addReroute(edgeId: string, world: Point): void {
    const segment = this.hitWire(world, Number.POSITIVE_INFINITY, edgeId);
    const before = this.getReroutes(edgeId);
    const after = [...before];
    after.splice(segment?.segment ?? before.length, 0, {
      x: Math.round(world.x),
      y: Math.round(world.y),
    });
    this.commitReroutes(edgeId, before, after);
  }

  public removeReroute(edgeId: string, index: number): void {
    const before = this.getReroutes(edgeId);
    this.commitReroutes(
      edgeId,
      before,
      before.filter((_, i) => i !== index)
    );
  }

  public clearReroutes(edgeId: string): void {
    this.commitReroutes(edgeId, this.getReroutes(edgeId), []);
  }

  private commitReroutes(
    edgeId: string,
    before: ReadonlyArray<Point>,
    after: ReadonlyArray<Point>
  ): void {
    if (after.length > 0) {
      this.reroutes.set(
        edgeId,
        after.map((p) => ({ ...p }))
      );
    } else {
      this.reroutes.delete(edgeId);
    }

    this.knotSelection.clear();
    this.emitter.emit('layoutChange', {
      patch: reroutePatch(edgeId, before, after),
    });
    this.requestRender();
  }

  private deleteSelectedKnots(): void {
    const byEdge = new Map<string, Set<number>>();
    for (const id of this.knotSelection) {
      const { edgeId, index } = parseKnotId(id);
      const set = byEdge.get(edgeId) ?? new Set();
      set.add(index);
      byEdge.set(edgeId, set);
    }

    const patch: LayoutPatch = {};
    for (const [edgeId, indices] of byEdge) {
      const before = this.getReroutes(edgeId);
      const after = before.filter((_, i) => !indices.has(i));
      Object.assign(patch, reroutePatch(edgeId, before, after));
      if (after.length > 0) {
        this.reroutes.set(edgeId, after);
      } else {
        this.reroutes.delete(edgeId);
      }
    }

    this.knotSelection.clear();
    this.emitter.emit('layoutChange', { patch });
    this.requestRender();
  }

  /** Nodes highlighted from outside (e.g. the code editor cursor). */
  /** Marks nodes with an ERROR / WARNING banner, like Blueprint nodes. */
  public setProblems(
    problems: ReadonlyMap<string, 'error' | 'warning' | 'info'>
  ): void {
    this.problems = new Map(problems);
    this.framesDirty = true;
    this.requestRender();
  }

  public setHighlight(ids: ReadonlyArray<string>): void {
    this.highlight = new Set(ids);
    this.requestRender();
  }

  public getCamera(): Camera {
    return { ...this.camera };
  }

  public setCamera(camera: Camera): void {
    this.camera = { ...camera };
    this.hasFramed = true;
    this.requestRender();
  }

  /**
   * First view of a document: fit everything if it stays readable, otherwise
   * start at the top-left (module entry) at a readable zoom.
   */
  private initialView(): void {
    const bounds = this.boundsOf([...this.nodes.keys()]);
    if (!bounds) {
      return;
    }

    const fit = fitCamera(bounds, this.width, this.height, 48, 1);
    if (fit.zoom >= 0.55) {
      this.setCameraInternal(fit);
      return;
    }

    const zoom = 0.85;
    this.setCameraInternal({
      zoom,
      x: bounds.x - 48 / zoom,
      y: bounds.y - 48 / zoom,
    });
  }

  /** Zooms around the center of the view (`factor` > 1 zooms in). */
  public zoomBy(factor: number): void {
    const center = { x: this.width / 2, y: this.height / 2 };
    this.setCameraInternal(zoomAt(this.camera, center, factor));
  }

  /** Sets the zoom level, keeping the center of the view in place. */
  public setZoom(zoom: number): void {
    this.zoomBy(zoom / this.camera.zoom);
  }

  public frameAll(): void {
    const bounds = this.boundsOf([...this.nodes.keys()]);
    if (bounds) {
      this.setCameraInternal(fitCamera(bounds, this.width, this.height, 48, 1));
    }
  }

  /** Pans (and zooms out if needed) so that the given nodes are visible. */
  public revealNodes(ids: ReadonlyArray<string>): void {
    const bounds = this.boundsOf(ids);
    if (!bounds || this.width === 0) {
      return;
    }

    const view = visibleWorldRect(this.camera, this.width, this.height);
    const inside =
      bounds.x >= view.x &&
      bounds.y >= view.y &&
      bounds.x + bounds.width <= view.x + view.width &&
      bounds.y + bounds.height <= view.y + view.height;
    if (inside) {
      return;
    }

    const fitsAtZoom =
      bounds.width * this.camera.zoom < this.width - 80 &&
      bounds.height * this.camera.zoom < this.height - 80;
    if (fitsAtZoom) {
      this.setCameraInternal({
        zoom: this.camera.zoom,
        x: bounds.x + bounds.width / 2 - this.width / 2 / this.camera.zoom,
        y: bounds.y + bounds.height / 2 - this.height / 2 / this.camera.zoom,
      });
    } else {
      this.setCameraInternal(
        fitCamera(bounds, this.width, this.height, 48, this.camera.zoom)
      );
    }
  }

  public resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = Math.max(1, Math.round(rect.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * this.dpr));
    if (!this.hasFramed && this.nodes.size > 0 && this.width > 0) {
      this.hasFramed = true;
      this.initialView();
    }

    this.render();
  }

  // --------------------------------------------------------------- helpers

  private listen<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    handler: (e: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions
  ): void {
    target.addEventListener(type, handler, options);
    this.disposers.push(() =>
      target.removeEventListener(type, handler, options)
    );
  }

  private font(style: TextStyle): string {
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
    }
  }

  private readonly measure: MeasureText = (text, style) => {
    const key = `${style}\u0000${text}`;
    let width = this.textCache.get(key);
    if (width === undefined) {
      this.measureCtx.font = this.font(style);
      width = this.measureCtx.measureText(text).width;
      this.textCache.set(key, width);
    }

    return width;
  };

  private nodeRect(ns: NodeState): Rect {
    return { x: ns.x, y: ns.y, width: ns.geom.width, height: ns.geom.height };
  }

  private rebuildIndex(): void {
    this.index.clear();
    for (const [id, ns] of this.nodes) {
      this.index.insert(id, this.nodeRect(ns));
    }

    this.framesDirty = true;
  }

  private boundsOf(ids: Iterable<string>): Rect | null {
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
      minX = Math.min(minX, ns.x);
      minY = Math.min(minY, ns.y - top);
      maxX = Math.max(
        maxX,
        ns.x + Math.max(ns.geom.width, ns.bubble?.width ?? 0)
      );
      maxY = Math.max(
        maxY,
        ns.y +
          ns.geom.height +
          (this.problems.has(id) ? BANNER_GAP + BANNER_HEIGHT : 0)
      );
    }

    if (!Number.isFinite(minX)) {
      return null;
    }

    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  private updateFrames(): void {
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
  private bubbleRect(ns: NodeState): Rect | null {
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

  private pinWorld(ns: NodeState, pg: PinGeometry): Point {
    return { x: ns.x + pg.x, y: ns.y + pg.y };
  }

  private literalRect(ns: NodeState, pg: PinGeometry): Rect | null {
    const pin = pg.pin;
    if (
      !pin.literal ||
      pg.side !== 'left' ||
      this.connectedPins.has(pinKey({ node: ns.node.id, pin: pin.id }))
    ) {
      return null;
    }

    const label =
      ns.node.compact || !pin.name ? 0 : this.measure(pin.name, 'label');
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

  private edgeWire(edge: GraphEdge): WireShape[] | null {
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
  private hitWire(
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

  private wireTolerance(): number {
    return 8 / this.camera.zoom;
  }

  private setCameraInternal(camera: Camera): void {
    this.camera = camera;
    this.emitter.emit('cameraChange', { ...camera });
    this.requestRender();
  }

  private setSelectionInternal(selection: Set<string>): void {
    const changed =
      selection.size !== this.selection.size ||
      [...selection].some((id) => !this.selection.has(id));
    this.selection = selection;
    if (changed) {
      this.emitter.emit('selectionChange', { nodeIds: [...selection] });
    }

    this.requestRender();
  }

  private setHover(nodeId: string | null, pin: string | null): void {
    if (nodeId === this.hoverNode && pin === this.hoverPin) {
      return;
    }

    this.hoverNode = nodeId;
    this.hoverPin = pin;
    this.emitter.emit('hoverChange', { nodeId, pin });
    this.requestRender();
  }

  private clientPoint(e: MouseEvent): Point {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private toWorld(e: MouseEvent): Point {
    return screenToWorld(this.camera, this.clientPoint(e));
  }

  // ----------------------------------------------------------- hit testing

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

  private hitTest(world: Point): Hit | null {
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

      return { type: 'node', ns };
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

  private canConnect(
    a: { ns: NodeState; pg: PinGeometry },
    b: { ns: NodeState; pg: PinGeometry }
  ): boolean {
    if (a.ns === b.ns || a.ns.fnId !== b.ns.fnId) {
      return false;
    }

    const pa = a.pg.pin;
    const pb = b.pg.pin;
    if (pa.kind !== pb.kind || pa.direction === pb.direction) {
      return false;
    }

    if (pa.kind === 'data') {
      const out = pa.direction === 'out' ? pa : pb;
      const input = pa.direction === 'out' ? pb : pa;
      return isTypeCompatible(out.type, input.type);
    }

    return true;
  }

  // ----------------------------------------------------------------- input

  private mods(e: MouseEvent | KeyboardEvent): SelectionModifiers {
    return { add: e.shiftKey, toggle: e.ctrlKey || e.metaKey };
  }

  private onPointerDown(e: PointerEvent): void {
    this.canvas.focus({ preventScroll: true });
    this.canvas.setPointerCapture(e.pointerId);
    const client = this.clientPoint(e);
    this.pointers.set(e.pointerId, client);

    if (e.pointerType === 'touch' && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()] as [Point, Point];
      this.drag = {
        type: 'pinch',
        startDistance: Math.hypot(a.x - b.x, a.y - b.y),
        startMid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        startCamera: { ...this.camera },
      };
      return;
    }

    if (this.pointers.size > 1) {
      return;
    }

    const world = this.toWorld(e);
    const hit = this.hitTest(world);

    if (
      e.button === 1 ||
      e.button === 2 ||
      (e.button === 0 && this.spaceDown) ||
      e.pointerType === 'touch'
    ) {
      this.drag = {
        type: 'pan',
        startClient: client,
        startCamera: { ...this.camera },
        moved: false,
        button: e.button,
        tapNode:
          hit &&
          (hit.type === 'node' ||
            hit.type === 'bubble' ||
            hit.type === 'pin' ||
            hit.type === 'literal')
            ? hit.ns.node.id
            : null,
      };
      return;
    }

    if (e.button !== 0) {
      return;
    }

    if (hit?.type === 'knot') {
      const id = knotId(hit.edgeId, hit.index);
      if (e.altKey) {
        this.removeReroute(hit.edgeId, hit.index);
        return;
      }

      const mods = this.mods(e);
      if (mods.toggle && this.knotSelection.has(id)) {
        this.knotSelection.delete(id);
      } else if (mods.add || mods.toggle) {
        this.knotSelection.add(id);
      } else if (!this.knotSelection.has(id)) {
        this.knotSelection = new Set([id]);
        this.setSelectionInternal(new Set());
      }

      if (this.knotSelection.has(id)) {
        this.startNodeDrag([...this.selection], world);
      }

      this.requestRender();
      return;
    }

    if (hit?.type === 'pin' && this.editable) {
      const ref = { node: hit.ns.node.id, pin: hit.pg.pin.id };
      if (e.altKey) {
        this.emitter.emit('op', { type: 'disconnect', pin: ref });
        return;
      }

      this.drag = {
        type: 'wire',
        from: { ns: hit.ns, pg: hit.pg },
        currentWorld: world,
        target: null,
      };
      this.requestRender();
      return;
    }

    if (hit && hit.type !== 'frame') {
      const id = hit.ns.node.id;
      const mods = this.mods(e);
      if (!mods.add && !mods.toggle && !this.selection.has(id)) {
        this.knotSelection.clear();
      }

      const selection = clickSelection(this.selection, id, mods);
      this.setSelectionInternal(selection);
      if (selection.has(id)) {
        this.startNodeDrag([...selection], world);
      }

      return;
    }

    if (hit?.type === 'frame') {
      const mods = this.mods(e);
      if (!mods.add && !mods.toggle) {
        this.knotSelection.clear();
      }

      const selection =
        mods.add || mods.toggle
          ? new Set([...this.selection, ...hit.frame.nodeIds])
          : new Set(hit.frame.nodeIds);
      this.setSelectionInternal(selection);
      this.startNodeDrag([...selection], world);
      return;
    }

    const mods = this.mods(e);
    const base =
      mods.add || mods.toggle ? new Set(this.selection) : new Set<string>();
    if (!mods.add && !mods.toggle) {
      this.knotSelection.clear();
      this.setSelectionInternal(new Set());
    }

    this.drag = {
      type: 'marquee',
      startWorld: world,
      currentWorld: world,
      base,
      baseKnots: new Set(this.knotSelection),
      mods,
    };
  }

  private startNodeDrag(ids: string[], world: Point): void {
    const origins = new Map<string, Point>();
    for (const id of ids) {
      const ns = this.nodes.get(id);
      if (ns) {
        origins.set(id, { x: ns.x, y: ns.y });
      }
    }

    const knotOrigins = new Map<string, Point>();
    for (const id of this.knotSelection) {
      const { edgeId, index } = parseKnotId(id);
      const p = this.reroutes.get(edgeId)?.[index];
      if (p) {
        knotOrigins.set(id, { ...p });
      }
    }

    this.drag = {
      type: 'nodes',
      ids,
      startWorld: world,
      origins,
      knotOrigins,
      moved: false,
    };
  }

  private onPointerMove(e: PointerEvent): void {
    const client = this.clientPoint(e);
    if (this.pointers.has(e.pointerId)) {
      this.pointers.set(e.pointerId, client);
    }

    const drag = this.drag;
    if (!drag) {
      this.updateHover(this.toWorld(e));
      return;
    }

    switch (drag.type) {
      case 'pinch': {
        if (this.pointers.size < 2) {
          return;
        }

        const [a, b] = [...this.pointers.values()] as [Point, Point];
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        let camera = zoomAt(
          drag.startCamera,
          drag.startMid,
          distance / Math.max(drag.startDistance, 1)
        );
        camera = {
          ...camera,
          x: camera.x - (mid.x - drag.startMid.x) / camera.zoom,
          y: camera.y - (mid.y - drag.startMid.y) / camera.zoom,
        };
        this.setCameraInternal(camera);
        return;
      }

      case 'pan': {
        const dx = client.x - drag.startClient.x;
        const dy = client.y - drag.startClient.y;
        if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) {
          return;
        }

        drag.moved = true;
        this.setCameraInternal({
          zoom: drag.startCamera.zoom,
          x: drag.startCamera.x - dx / drag.startCamera.zoom,
          y: drag.startCamera.y - dy / drag.startCamera.zoom,
        });
        return;
      }

      case 'nodes': {
        const world = this.toWorld(e);
        const dx = world.x - drag.startWorld.x;
        const dy = world.y - drag.startWorld.y;
        if (
          !drag.moved &&
          Math.hypot(dx, dy) * this.camera.zoom < DRAG_THRESHOLD
        ) {
          return;
        }

        drag.moved = true;
        for (const [id, origin] of drag.origins) {
          const ns = this.nodes.get(id);
          if (ns) {
            ns.x = Math.round(origin.x + dx);
            ns.y = Math.round(origin.y + dy);
          }
        }

        for (const [id, origin] of drag.knotOrigins) {
          const { edgeId, index } = parseKnotId(id);
          const p = this.reroutes.get(edgeId)?.[index];
          if (p) {
            p.x = Math.round(origin.x + dx);
            p.y = Math.round(origin.y + dy);
          }
        }

        this.framesDirty = true;
        this.requestRender();
        return;
      }

      case 'marquee': {
        drag.currentWorld = this.toWorld(e);
        const rect = normalizeRect(drag.startWorld, drag.currentWorld);
        const hits = this.index.query(rect);
        const knots: string[] = [];
        for (const [edgeId, points] of this.reroutes) {
          for (const [index, p] of points.entries()) {
            if (
              p.x >= rect.x &&
              p.x <= rect.x + rect.width &&
              p.y >= rect.y &&
              p.y <= rect.y + rect.height
            ) {
              knots.push(knotId(edgeId, index));
            }
          }
        }

        this.knotSelection = marqueeSelection(drag.baseKnots, knots, drag.mods);
        this.setSelectionInternal(marqueeSelection(drag.base, hits, drag.mods));
        return;
      }

      case 'wire': {
        const world = this.toWorld(e);
        drag.currentWorld = world;
        const hit = this.hitTest(world);
        drag.target =
          hit?.type === 'pin' && this.canConnect(drag.from, hit)
            ? { ns: hit.ns, pg: hit.pg }
            : null;
        this.requestRender();
      }
    }
  }

  private updateHover(world: Point): void {
    const hit = this.hitTest(world);
    let cursor = 'default';
    const edge = hit ? null : this.hitWire(world, this.wireTolerance());
    const hoverEdge = edge?.edge.id ?? null;
    if (hoverEdge !== this.hoverEdge) {
      this.hoverEdge = hoverEdge;
      this.requestRender();
    }

    if (!hit) {
      this.setHover(null, null);
      if (edge) {
        cursor = 'pointer';
      }
    } else if (hit.type === 'frame' || hit.type === 'knot') {
      this.setHover(null, null);
      cursor = 'move';
    } else {
      this.setHover(hit.ns.node.id, hit.type === 'pin' ? hit.pg.pin.id : null);
      cursor =
        hit.type === 'pin' && this.editable
          ? 'crosshair'
          : hit.type === 'literal' && this.editable
            ? 'text'
            : 'move';
    }

    if (this.spaceDown) {
      cursor = 'grab';
    }

    this.canvas.style.cursor = cursor;
  }

  private onPointerUp(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    if (this.canvas.hasPointerCapture(e.pointerId)) {
      this.canvas.releasePointerCapture(e.pointerId);
    }

    const drag = this.drag;
    if (!drag) {
      return;
    }

    if (drag.type === 'pinch') {
      if (this.pointers.size === 0) {
        this.drag = null;
      }

      return;
    }

    this.drag = null;

    switch (drag.type) {
      case 'pan': {
        if (!drag.moved) {
          if (drag.button === 2) {
            const world = this.toWorld(e);
            this.emitter.emit('contextMenu', {
              world,
              client: { x: e.clientX, y: e.clientY },
              target: this.contextTarget(world),
            });
          } else if (e.pointerType === 'touch') {
            this.setSelectionInternal(
              drag.tapNode ? new Set([drag.tapNode]) : new Set()
            );
          }
        }

        break;
      }

      case 'nodes': {
        if (drag.moved) {
          const patch: LayoutPatch = {};
          for (const id of drag.ids) {
            const ns = this.nodes.get(id);
            if (ns) {
              patch[id] = { x: ns.x, y: ns.y };
              this.index.insert(id, this.nodeRect(ns));
            }
          }

          const edges = new Set(
            [...drag.knotOrigins.keys()].map((id) => parseKnotId(id).edgeId)
          );
          for (const edgeId of edges) {
            const points = this.getReroutes(edgeId);
            Object.assign(patch, reroutePatch(edgeId, points, points));
          }

          this.framesDirty = true;
          this.emitter.emit('layoutChange', { patch });
        }

        break;
      }

      case 'marquee': {
        break;
      }

      case 'wire': {
        const from = drag.from;
        if (drag.target) {
          const outIsFrom = from.pg.pin.direction === 'out';
          const out = outIsFrom ? from : drag.target;
          const input = outIsFrom ? drag.target : from;
          this.emitter.emit('op', {
            type: 'connect',
            from: { node: out.ns.node.id, pin: out.pg.pin.id },
            to: { node: input.ns.node.id, pin: input.pg.pin.id },
          });
        } else if (!this.hitTest(drag.currentWorld)) {
          // Like Blueprints: dropping a wire on empty space opens the
          // actions for that pin; the wire stays until the menu closes.
          const ref = { node: from.ns.node.id, pin: from.pg.pin.id };
          this.pendingWire = { from, world: drag.currentWorld };
          this.emitter.emit('contextMenu', {
            world: drag.currentWorld,
            client: { x: e.clientX, y: e.clientY },
            target: { kind: 'pin', pin: ref },
            from: ref,
          });
        }

        break;
      }
    }

    this.requestRender();
  }

  /** Opens the inline value editor of an unconnected input pin. */
  /**
   * Starts editing a node comment (bubble) or a comment box title; the
   * `editComment` event carries where to show the editor.
   */
  public editComment(target: CommentTarget): void {
    if (!this.editable) {
      return;
    }

    let world: Rect;
    let value: string;
    if (target.kind === 'node') {
      const ns = this.nodes.get(target.nodeId);
      if (!ns) {
        return;
      }

      this.revealNodes([target.nodeId]);
      value = ns.node.comment?.text ?? '';
      world = this.bubbleRect(ns) ?? {
        x: ns.x,
        y: ns.y - BUBBLE_GAP - 60,
        width: Math.max(ns.geom.width, 220),
        height: 60,
      };
      world = {
        ...world,
        width: Math.max(world.width, 220),
        height: Math.max(world.height, 60),
      };
      world.y = Math.min(world.y, ns.y - BUBBLE_GAP - world.height);
    } else {
      this.updateFrames();
      const frame = this.frames.find((f) => f.boxId === target.boxId);
      if (!frame?.bounds) {
        return;
      }

      value = frame.name;
      world = {
        x: frame.bounds.x,
        y: frame.bounds.y,
        width: Math.max(frame.bounds.width, 160),
        height: COMMENT_HEADER,
      };
    }

    const bounds = this.canvas.getBoundingClientRect();
    const topLeft = worldToScreen(this.camera, { x: world.x, y: world.y });
    this.emitter.emit('editComment', {
      target,
      value,
      rect: {
        x: bounds.left + topLeft.x,
        y: bounds.top + topLeft.y,
        width: world.width * this.camera.zoom,
        height: world.height * this.camera.zoom,
      },
    });
  }

  public editLiteral(nodeId: string, pinId: string): void {
    const ns = this.nodes.get(nodeId);
    const pg = ns?.geom.pins.get(pinId);
    if (ns && pg && this.editable) {
      this.revealNodes([nodeId]);
      this.startLiteralEdit(ns, pg);
    }
  }

  private startLiteralEdit(ns: NodeState, pg: PinGeometry): void {
    const r = this.literalRect(ns, pg);
    const literal = pg.pin.literal;
    if (!r || !literal) {
      return;
    }

    const bounds = this.canvas.getBoundingClientRect();
    const topLeft = worldToScreen(this.camera, { x: r.x, y: r.y });
    this.emitter.emit('editLiteral', {
      node: ns.node.id,
      pin: pg.pin.id,
      value: literal.value,
      kind: literal.kind,
      rect: {
        x: bounds.left + topLeft.x,
        y: bounds.top + topLeft.y,
        width: r.width * this.camera.zoom,
        height: r.height * this.camera.zoom,
      },
    });
  }

  private contextTarget(world: Point): ContextTarget {
    const hit = this.hitTest(world);
    switch (hit?.type) {
      case 'pin':
      case 'literal': {
        return {
          kind: 'pin',
          pin: { node: hit.ns.node.id, pin: hit.pg.pin.id },
        };
      }

      case 'node':
      case 'bubble': {
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

  private onDoubleClick(e: MouseEvent): void {
    const world = this.toWorld(e);
    const hit = this.hitTest(world);
    if (!hit) {
      const wire = this.hitWire(world, this.wireTolerance());
      if (wire) {
        this.addReroute(wire.edge.id, world);
      }

      return;
    }

    if (hit.type === 'frame' && hit.frame.boxId) {
      this.editComment({ kind: 'box', boxId: hit.frame.boxId });
      return;
    }

    if (hit.type === 'bubble') {
      this.editComment({ kind: 'node', nodeId: hit.ns.node.id });
      return;
    }

    if (hit.type === 'frame' || hit.type === 'knot') {
      return;
    }

    if (hit.type === 'literal' && this.editable) {
      this.startLiteralEdit(hit.ns, hit.pg);
      return;
    }

    this.emitter.emit('activate', { nodeId: hit.ns.node.id });
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const anchor = this.clientPoint(e);
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.height : 1;
    const dx = e.deltaX * scale;
    const dy = e.deltaY * scale;
    // Pinch on trackpads arrives as ctrl+wheel; classic mouse wheels send
    // large discrete steps. Everything else (two finger scroll) pans.
    const isMouseWheel = dx === 0 && Math.abs(dy) >= 50 && Number.isInteger(dy);
    if (e.ctrlKey || e.metaKey || isMouseWheel) {
      const factor = Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015));
      this.setCameraInternal(zoomAt(this.camera, anchor, factor));
      return;
    }

    this.setCameraInternal({
      ...this.camera,
      x: this.camera.x + dx / this.camera.zoom,
      y: this.camera.y + dy / this.camera.zoom,
    });
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.code === 'Space') {
      this.spaceDown = true;
      e.preventDefault();
      return;
    }

    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (this.knotSelection.size > 0) {
        e.preventDefault();
        this.deleteSelectedKnots();
      }

      if (this.selection.size > 0 && this.editable) {
        e.preventDefault();
        this.emitter.emit('op', {
          type: 'deleteNodes',
          nodeIds: [...this.selection],
        });
      }

      return;
    }

    if (e.key === 'Escape') {
      if (this.drag?.type === 'wire') {
        this.drag = null;
      }

      this.knotSelection.clear();
      this.setSelectionInternal(new Set());
      return;
    }

    const command = e.ctrlKey || e.metaKey;
    if ((e.key === 'a' || e.key === 'A') && command) {
      e.preventDefault();
      this.selectAll();
      return;
    }

    if (command || e.altKey) {
      return;
    }

    if (e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      this.frameSelection();
    } else if (e.key === 'Home') {
      e.preventDefault();
      this.frameAll();
    }
  }

  // ------------------------------------------------------------- rendering

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

  private render(): void {
    const { ctx, camera, theme } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = theme.background;
    ctx.fillRect(0, 0, this.width, this.height);
    this.drawGrid();

    if (!this.doc) {
      return;
    }

    ctx.setTransform(
      this.dpr * camera.zoom,
      0,
      0,
      this.dpr * camera.zoom,
      -camera.x * camera.zoom * this.dpr,
      -camera.y * camera.zoom * this.dpr
    );

    const view = visibleWorldRect(camera, this.width, this.height);
    this.updateFrames();
    this.drawFrames(view);
    this.drawWires(view);

    const visible = this.index.query(view);
    const selected: NodeState[] = [];
    for (const id of visible) {
      const ns = this.nodes.get(id);
      if (!ns) {
        continue;
      }

      if (this.selection.has(id)) {
        selected.push(ns);
      } else {
        this.drawNode(ns);
      }
    }

    for (const ns of selected) {
      this.drawNode(ns);
    }

    this.drawOverlay();
  }

  private drawGrid(): void {
    const { ctx, camera, theme } = this;
    const minor = 16;
    const major = 128;

    const drawLines = (
      spacing: number,
      color: string,
      lineWidth: number
    ): void => {
      const step = spacing * camera.zoom;
      if (step < 6) {
        return;
      }

      ctx.beginPath();
      const startX = -((camera.x * camera.zoom) % step);
      const startY = -((camera.y * camera.zoom) % step);
      for (let x = startX; x < this.width; x += step) {
        ctx.moveTo(Math.round(x) + 0.5, 0);
        ctx.lineTo(Math.round(x) + 0.5, this.height);
      }

      for (let y = startY; y < this.height; y += step) {
        ctx.moveTo(0, Math.round(y) + 0.5);
        ctx.lineTo(this.width, Math.round(y) + 0.5);
      }

      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.stroke();
    };

    drawLines(minor, theme.gridMinor, 1);
    drawLines(major, theme.gridMajor, 1.5);
  }

  private drawFrames(view: Rect): void {
    const { ctx, theme } = this;
    // Function frames, then comment boxes from the outside in.
    const frames = this.frames.toSorted(
      (a, b) =>
        Number(a.kind === 'comment') - Number(b.kind === 'comment') ||
        b.nodeIds.length - a.nodeIds.length
    );
    for (const frame of frames) {
      const b = frame.bounds;
      if (!b || !rectsIntersect(b, view)) {
        continue;
      }

      if (frame.kind === 'comment') {
        this.drawCommentBox(frame, b);
        continue;
      }

      ctx.beginPath();
      ctx.roundRect(b.x, b.y, b.width, b.height, 12);
      ctx.fillStyle = theme.frameFill;
      ctx.fill();
      ctx.strokeStyle = theme.frameBorder;
      ctx.lineWidth = 1.5;
      ctx.stroke();

      if (this.camera.zoom > 0.15) {
        ctx.fillStyle = theme.frameTitle;
        ctx.font = `600 18px ${theme.fontFamily}`;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        ctx.fillText(frame.name, b.x + 16, b.y + FRAME_HEADER / 2 + 4);
      }
    }
  }

  private drawCommentBox(frame: FrameState, b: Rect): void {
    const { ctx, theme } = this;
    const selected =
      frame.nodeIds.length > 0 &&
      frame.nodeIds.every((id) => this.selection.has(id));
    ctx.beginPath();
    ctx.roundRect(b.x, b.y, b.width, b.height, 6);
    ctx.fillStyle = theme.commentFill;
    ctx.fill();
    ctx.save();
    ctx.clip();
    ctx.fillStyle = theme.commentHeader;
    ctx.fillRect(b.x, b.y, b.width, COMMENT_HEADER);
    ctx.restore();
    ctx.strokeStyle = selected ? theme.selection : theme.commentBorder;
    ctx.lineWidth = selected ? 2 : 1;
    ctx.stroke();

    if (this.camera.zoom > 0.15) {
      ctx.fillStyle = theme.commentTitle;
      ctx.font = `600 14px ${theme.fontFamily}`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      const title = frame.name || 'Comment';
      ctx.save();
      ctx.beginPath();
      ctx.rect(b.x, b.y, b.width - 8, COMMENT_HEADER);
      ctx.clip();
      ctx.globalAlpha = frame.name ? 1 : 0.5;
      ctx.fillText(title, b.x + 10, b.y + COMMENT_HEADER / 2 + 1);
      ctx.restore();
    }
  }

  private drawProblemBanner(ns: NodeState, lod: boolean): void {
    const severity = this.problems.get(ns.node.id);
    if (!severity) {
      return;
    }

    const { ctx, theme } = this;
    const y = ns.y + ns.geom.height + BANNER_GAP;
    const color =
      severity === 'error'
        ? theme.errorBanner
        : severity === 'warning'
          ? theme.warningBanner
          : theme.infoBanner;
    ctx.beginPath();
    ctx.roundRect(ns.x, y, ns.geom.width, BANNER_HEIGHT, 4);
    ctx.fillStyle = color;
    ctx.fill();
    if (lod) {
      return;
    }

    ctx.fillStyle = theme.bannerText;
    ctx.font = `700 10px ${theme.fontFamily}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(
      severity === 'error'
        ? 'ERROR!'
        : severity === 'warning'
          ? 'WARNING!'
          : 'NOTE',
      ns.x + 8,
      y + BANNER_HEIGHT / 2 + 0.5
    );
  }

  private drawBubble(ns: NodeState, lod: boolean): void {
    const r = this.bubbleRect(ns);
    const bubble = ns.bubble;
    if (!r || !bubble) {
      return;
    }

    const { ctx, theme } = this;
    ctx.beginPath();
    ctx.roundRect(r.x, r.y, r.width, r.height, 5);
    // Tail pointing at the node.
    const tailX = r.x + 16;
    ctx.moveTo(tailX - 6, r.y + r.height);
    ctx.lineTo(tailX, r.y + r.height + BUBBLE_GAP - 2);
    ctx.lineTo(tailX + 6, r.y + r.height);
    ctx.fillStyle = theme.bubbleFill;
    ctx.fill();

    if (lod) {
      return;
    }

    ctx.fillStyle = theme.bubbleText;
    ctx.font = this.font('label');
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    bubble.lines.forEach((line, i) => {
      ctx.fillText(
        line,
        r.x + BUBBLE_PADDING_X,
        r.y + BUBBLE_PADDING_Y + BUBBLE_LINE_HEIGHT * (i + 0.5)
      );
    });
  }

  private isEdgeHighlighted(edge: GraphEdge): boolean {
    if (edge.id === this.hoverEdge) {
      return true;
    }

    for (const id of [edge.from.node, edge.to.node]) {
      if (id === this.hoverNode || this.selection.has(id)) {
        return true;
      }
    }

    return false;
  }

  private drawWires(view: Rect): void {
    const highlighted: Array<{ edge: GraphEdge; wire: WireShape[] }> = [];
    for (const { edge } of this.edges) {
      const wire = this.edgeWire(edge);
      if (!wire || !wire.some((shape) => rectsIntersect(shape.bounds, view))) {
        continue;
      }

      if (this.isEdgeHighlighted(edge)) {
        highlighted.push({ edge, wire });
      } else {
        this.drawWire(edge, wire, false);
      }
    }

    for (const { edge, wire } of highlighted) {
      this.drawWire(edge, wire, true);
    }

    this.drawKnots(view);
  }

  private drawKnots(view: Rect): void {
    const { ctx, theme } = this;
    for (const [edgeId, points] of this.reroutes) {
      const edge = this.edgesById.get(edgeId);
      if (!edge) {
        continue;
      }

      const color = this.wireColor(edge);
      for (const [index, p] of points.entries()) {
        if (
          p.x < view.x - KNOT_RADIUS ||
          p.y < view.y - KNOT_RADIUS ||
          p.x > view.x + view.width + KNOT_RADIUS ||
          p.y > view.y + view.height + KNOT_RADIUS
        ) {
          continue;
        }

        const selected = this.knotSelection.has(knotId(edgeId, index));
        ctx.beginPath();
        ctx.arc(p.x, p.y, KNOT_RADIUS, 0, Math.PI * 2);
        ctx.fillStyle = theme.nodeBody;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = color;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(p.x, p.y, KNOT_RADIUS - 3, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        if (selected) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, KNOT_RADIUS + 3, 0, Math.PI * 2);
          ctx.strokeStyle = theme.selection;
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }
    }
  }

  private wireColor(edge: GraphEdge): string {
    if (edge.kind === 'exec') {
      return this.theme.exec;
    }

    const pin = this.nodes
      .get(edge.from.node)
      ?.geom.pins.get(edge.from.pin)?.pin;
    return pinColor(pin?.type ?? 'any', this.theme.scheme);
  }

  private drawWire(
    edge: GraphEdge,
    shapes: ReadonlyArray<WireShape>,
    highlighted: boolean
  ): void {
    const { ctx } = this;
    ctx.beginPath();
    for (const wire of shapes) {
      if (wire.type === 'curve') {
        const c = wire.curve;
        ctx.moveTo(c.p0.x, c.p0.y);
        ctx.bezierCurveTo(c.c0.x, c.c0.y, c.c1.x, c.c1.y, c.p1.x, c.p1.y);
        continue;
      }

      const [first, ...rest] = wire.points;
      if (first) {
        ctx.moveTo(first.x, first.y);
      }

      for (const [i, point] of rest.entries()) {
        const next = rest[i + 1];
        if (next) {
          ctx.arcTo(point.x, point.y, next.x, next.y, 14);
        } else {
          ctx.lineTo(point.x, point.y);
        }
      }
    }

    ctx.strokeStyle = this.wireColor(edge);
    const base = edge.kind === 'exec' ? 3 : 2.2;
    ctx.lineWidth = highlighted ? base + 1.5 : base;
    ctx.globalAlpha =
      highlighted || (this.selection.size === 0 && !this.hoverNode) ? 1 : 0.6;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  private drawNode(ns: NodeState): void {
    const { ctx, theme } = this;
    const { node, geom } = ns;
    const lod = this.camera.zoom < 0.4;
    const r = node.compact
      ? Math.min(geom.height / 2, 14)
      : NODE_METRICS.cornerRadius;
    const id = node.id;

    this.drawBubble(ns, lod);
    this.drawProblemBanner(ns, lod);

    // Body
    ctx.beginPath();
    ctx.roundRect(ns.x, ns.y, geom.width, geom.height, r);
    ctx.fillStyle = node.compact
      ? node.category === 'variable'
        ? theme.compactVariable
        : theme.compactPure
      : theme.nodeBody;
    ctx.fill();

    // Header
    if (!node.compact) {
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(ns.x, ns.y, geom.width, geom.headerHeight, [r, r, 0, 0]);
      ctx.clip();
      const gradient = ctx.createLinearGradient(
        ns.x,
        ns.y,
        ns.x + geom.width,
        ns.y
      );
      const color = theme.categories[node.category];
      gradient.addColorStop(0, color);
      gradient.addColorStop(1, `${color}${theme.headerFade}`);
      ctx.fillStyle = gradient;
      ctx.fillRect(ns.x, ns.y, geom.width, geom.headerHeight);
      ctx.restore();
    } else if (node.category !== 'variable') {
      ctx.beginPath();
      ctx.roundRect(ns.x, ns.y, geom.width, geom.height, r);
      ctx.strokeStyle = `${theme.categories[node.category]}cc`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // Outline
    const selected = this.selection.has(id);
    const highlighted = this.highlight.has(id);
    const hovered = this.hoverNode === id;
    ctx.beginPath();
    ctx.roundRect(ns.x, ns.y, geom.width, geom.height, r);
    if (selected || highlighted || hovered) {
      ctx.strokeStyle = selected
        ? theme.selection
        : highlighted
          ? theme.codeHighlight
          : theme.hover;
      ctx.lineWidth = selected || highlighted ? 2.5 : 1.5;
    } else {
      ctx.strokeStyle = theme.nodeBorder;
      ctx.lineWidth = 1.5;
    }

    ctx.stroke();

    // Title
    ctx.textBaseline = 'middle';
    if (node.compact) {
      ctx.font = this.font('compact');
      ctx.fillStyle = theme.nodeText;
      ctx.textAlign = 'center';
      const left =
        geom.leftColumn > 0 ? geom.leftColumn + 4 : NODE_METRICS.paddingX;
      const right =
        geom.rightColumn > 0 ? geom.rightColumn + 4 : NODE_METRICS.paddingX;
      ctx.fillText(
        node.title,
        ns.x + (left + geom.width - right) / 2,
        ns.y + geom.height / 2
      );
    } else {
      ctx.font = this.font('title');
      ctx.fillStyle = theme.nodeTitle;
      ctx.textAlign = 'left';
      ctx.fillText(
        node.title,
        ns.x + NODE_METRICS.paddingX,
        ns.y + NODE_METRICS.headerHeight / 2 + 1
      );
      if (node.subtitle && !lod) {
        ctx.font = this.font('subtitle');
        ctx.fillStyle = theme.nodeSubtext;
        ctx.fillText(
          node.subtitle,
          ns.x + NODE_METRICS.paddingX,
          ns.y + NODE_METRICS.headerHeight + NODE_METRICS.subtitleHeight / 2 - 4
        );
      }
    }

    // Pins
    for (const pg of geom.pins.values()) {
      this.drawPin(ns, pg, lod);
    }
  }

  private drawPin(ns: NodeState, pg: PinGeometry, lod: boolean): void {
    const { ctx, theme } = this;
    const pin: Pin = pg.pin;
    const p = this.pinWorld(ns, pg);
    const connected = this.connectedPins.has(
      pinKey({ node: ns.node.id, pin: pin.id })
    );
    const hovered = this.hoverNode === ns.node.id && this.hoverPin === pin.id;
    const r = NODE_METRICS.pinRadius + (hovered ? 1.5 : 0);

    if (pin.kind === 'exec') {
      ctx.beginPath();
      ctx.moveTo(p.x - r, p.y - r - 1);
      ctx.lineTo(p.x + 1, p.y - r - 1);
      ctx.lineTo(p.x + r + 1, p.y);
      ctx.lineTo(p.x + 1, p.y + r + 1);
      ctx.lineTo(p.x - r, p.y + r + 1);
      ctx.closePath();
      ctx.strokeStyle = theme.exec;
      ctx.lineWidth = 1.6;
      if (connected) {
        ctx.fillStyle = theme.exec;
        ctx.fill();
      }

      ctx.stroke();
    } else {
      const color = pinColor(pin.type, theme.scheme);
      if (isArrayType(pin.type)) {
        this.drawArrayPin(p, r, color, connected);
      } else {
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        if (connected) {
          ctx.fillStyle = color;
          ctx.fill();
        }

        ctx.stroke();
      }
    }

    if (lod) {
      return;
    }

    const labelX =
      pg.side === 'left'
        ? p.x + NODE_METRICS.pinRadius + NODE_METRICS.pinLabelGap
        : p.x - NODE_METRICS.pinRadius - NODE_METRICS.pinLabelGap;
    if (pin.name && !ns.node.compact) {
      ctx.font = this.font('label');
      ctx.fillStyle = theme.pinLabel;
      ctx.textAlign = pg.side === 'left' ? 'left' : 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(pin.name, labelX, p.y);
    }

    const lr = this.literalRect(ns, pg);
    if (lr && pin.literal) {
      ctx.beginPath();
      ctx.roundRect(lr.x, lr.y, lr.width, lr.height, 4);
      ctx.fillStyle = theme.literalBackground;
      ctx.fill();
      ctx.save();
      ctx.beginPath();
      ctx.rect(lr.x + 4, lr.y, lr.width - 8, lr.height);
      ctx.clip();
      ctx.font = this.font('literal');
      ctx.fillStyle =
        pin.literal.kind === 'string' || pin.literal.kind === 'template'
          ? theme.literalString
          : theme.literalText;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(
        pin.literal.value || ' ',
        lr.x + NODE_METRICS.literalPadding,
        p.y + 0.5
      );
      ctx.restore();
    }
  }

  private drawOverlay(): void {
    const { ctx, theme } = this;
    const drag = this.drag;
    if (drag?.type === 'marquee') {
      const rect = normalizeRect(drag.startWorld, drag.currentWorld);
      ctx.fillStyle = theme.marqueeFill;
      ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
      ctx.strokeStyle = theme.marqueeBorder;
      ctx.lineWidth = 1 / this.camera.zoom;
      ctx.setLineDash([6 / this.camera.zoom, 4 / this.camera.zoom]);
      ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
      ctx.setLineDash([]);
    }

    if (drag?.type === 'wire') {
      this.drawLooseWire(
        drag.from,
        drag.target
          ? this.pinWorld(drag.target.ns, drag.target.pg)
          : drag.currentWorld,
        drag.target !== null
      );
    } else if (this.pendingWire) {
      this.drawLooseWire(this.pendingWire.from, this.pendingWire.world, false);
    }
  }

  /**
   * Blueprint array pin: a 3×3 grid of squares in the element color,
   * filled when connected and outlined when not.
   */
  private drawArrayPin(
    center: Point,
    radius: number,
    color: string,
    connected: boolean
  ): void {
    const { ctx } = this;
    const size = radius * 2 + 2;
    const gap = size * 0.12;
    const cell = (size - gap * 2) / 3;
    const left = center.x - size / 2;
    const top = center.y - size / 2;
    ctx.beginPath();
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        ctx.rect(
          left + col * (cell + gap),
          top + row * (cell + gap),
          cell,
          cell
        );
      }
    }

    if (connected) {
      ctx.fillStyle = color;
      ctx.fill();
    } else {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  private drawLooseWire(
    from: { ns: NodeState; pg: PinGeometry },
    end: Point,
    attached: boolean
  ): void {
    const { ctx, theme } = this;
    const start = this.pinWorld(from.ns, from.pg);
    const pin = from.pg.pin;
    const wire =
      pin.direction === 'out' ? wireCurve(start, end) : wireCurve(end, start);
    ctx.beginPath();
    ctx.moveTo(wire.p0.x, wire.p0.y);
    ctx.bezierCurveTo(
      wire.c0.x,
      wire.c0.y,
      wire.c1.x,
      wire.c1.y,
      wire.p1.x,
      wire.p1.y
    );
    ctx.strokeStyle =
      pin.kind === 'exec' ? theme.exec : pinColor(pin.type, theme.scheme);
    ctx.lineWidth = pin.kind === 'exec' ? 3 : 2.2;
    ctx.setLineDash(attached ? [] : [8, 6]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}
