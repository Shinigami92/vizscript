import type {
  Conversion,
  GraphDocument,
  GraphEdge,
  GraphNode,
  LayoutPatch,
  PinGeometry,
  Point,
  Positions,
} from '@vizscript/core';
import { alignNodes } from './align';
import { screenToWorld } from './camera';
import type { Camera, Rect } from './camera';
import { Controller } from './controller';
import type { ControllerHost } from './controller-host';
import { Emitter } from './emitter';
import { FontMetrics } from './font-metrics';
import { knotId, parseKnotId, wireTolerance } from './graph-view-constants';
import type {
  AlignMode,
  CommentTarget,
  GraphViewEvents,
  GraphViewOptions,
  Hit,
  NodeBannerKind,
  NodeState,
} from './graph-view-types';
import { clientRect, commentEdit, literalEdit } from './inline-edit';
import { newInteraction } from './interaction';
import {
  continueMove,
  fadeInAdded,
  finishMoves,
  slideTo,
  stepNodes,
  stopMotion,
} from './node-motion';
import { resolvePin } from './pin-ref';
import { Renderer } from './renderer';
import { Scene } from './scene';
import { DARK_THEME } from './theme';
import type { Theme } from './theme';
import {
  fitAll,
  fitSelection,
  focusCamera,
  initialCamera,
  revealCamera,
  Viewport,
} from './viewport';

/**
 * Framework-agnostic Canvas2D renderer and interaction controller for
 * Blueprint-style graphs. It owns the parts and passes them to each other:
 * the shown document (`Scene`), the camera (`Viewport`), what the user
 * picked and drags (`Interaction`), the drawing (`Renderer`) and the input
 * (`Controller`).
 */
export class GraphView {
  private readonly emitter = new Emitter<GraphViewEvents>();
  private readonly metrics: FontMetrics;
  private readonly scene: Scene;
  private readonly viewport = new Viewport();
  private readonly ui = newInteraction();
  private readonly renderer: Renderer;
  private readonly controller: Controller;
  private readonly resizeObserver: ResizeObserver;
  private stopWatchingPixelRatio: (() => void) | undefined;

  private theme: Theme;
  private editable: boolean;
  private motion: boolean;
  private readonly conversions: () => ReadonlyArray<Conversion> | undefined;

  private frameRequest: number | null = null;
  /** Set by `destroy`: no more frames. */
  private destroyed = false;
  /** The camera was placed (first view of a document, or from outside). */
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

    this.theme = options.theme ?? DARK_THEME;
    this.editable = options.editable ?? true;
    this.motion = options.motion ?? false;
    this.conversions = options.conversions ?? ((): undefined => undefined);
    this.metrics = new FontMetrics(measureCtx, this.theme);
    this.scene = new Scene(this.metrics.measure);
    this.renderer = new Renderer(
      ctx,
      this.metrics,
      this.scene,
      this.viewport,
      this.theme
    );
    this.controller = new Controller(this.controllerHost());
    this.controller.attach();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.watchPixelRatio();
    this.resize();
  }

  public destroy(): void {
    this.destroyed = true;
    if (this.frameRequest !== null) {
      cancelAnimationFrame(this.frameRequest);
      this.frameRequest = null;
    }

    this.stopWatchingPixelRatio?.();
    this.resizeObserver.disconnect();
    this.controller.detach();
    this.emitter.clear();
  }

  public on<K extends keyof GraphViewEvents>(
    event: K,
    handler: (payload: GraphViewEvents[K]) => void
  ): () => void {
    return this.emitter.on(event, handler);
  }

  // --------------------------------------------------------------- drawing

  /** Schedules a frame. */
  public requestRender(): void {
    if (this.frameRequest !== null || this.destroyed) {
      return;
    }

    this.frameRequest = requestAnimationFrame(() => {
      this.frameRequest = null;
      this.render();
    });
  }

  /** Advances eased moves, then draws. */
  private render(): void {
    const time = performance.now();
    if (this.stepMotion(time)) {
      this.requestRender();
    }

    this.renderer.draw({ ...this.ui, time, editable: this.editable });
  }

  /** Switches colors, e.g. between `DARK_THEME` and `LIGHT_THEME`. */
  public setTheme(theme: Theme): void {
    this.theme = theme;
    this.metrics.setTheme(theme);
    this.renderer.setTheme(theme);
    this.requestRender();
  }

  /** Follows the canvas's size and the pixel ratio. */
  public resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.viewport.dpr = dpr;
    this.viewport.width = rect.width;
    this.viewport.height = rect.height;
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.frameFirstView();
    this.render();
  }

  /**
   * Redraws sharp when the pixel ratio changes (the window moved to another
   * screen, browser zoom): the canvas keeps its CSS size, so the resize
   * observer doesn't fire.
   */
  private watchPixelRatio(): void {
    const query = window.matchMedia(
      `(resolution: ${window.devicePixelRatio}dppx)`
    );
    const onChange = (): void => {
      this.resize();
      this.watchPixelRatio();
    };
    query.addEventListener('change', onChange, { once: true });
    this.stopWatchingPixelRatio = () =>
      query.removeEventListener('change', onChange);
  }

  // ---------------------------------------------------------------- camera

  /** Turns eased camera and node moves on or off (reduced motion). */
  public setMotion(motion: boolean): void {
    this.motion = motion;
    if (!motion) {
      this.viewport.tween = null;
      this.settle(stopMotion(this.scene.nodes.values()));
    }
  }

  /** The camera, or where an eased camera move ends. */
  public getCamera(): Camera {
    return this.viewport.target();
  }

  public setCamera(camera: Camera): void {
    this.viewport.set(camera);
    this.hasFramed = true;
    this.requestRender();
  }

  /** Zooms around the center of the view (`factor` > 1 zooms in). */
  public zoomBy(factor: number): void {
    this.moveCamera(this.viewport.zoomedBy(factor));
  }

  /** Sets the zoom level, keeping the center of the view in place. */
  public setZoom(zoom: number): void {
    this.zoomBy(zoom / this.getCamera().zoom);
  }

  public frameAll(): void {
    const bounds = this.scene.boundsOf(this.scene.nodes.keys());
    if (bounds) {
      const { width, height } = this.viewport;
      this.moveCamera(fitAll(bounds, width, height));
    }
  }

  /** Zooms to the selection, or to everything when nothing is selected. */
  public frameSelection(): void {
    const bounds = this.scene.boundsOf(this.ui.selection);
    if (bounds) {
      const { width, height } = this.viewport;
      this.moveCamera(fitSelection(bounds, width, height));
    } else {
      this.frameAll();
    }
  }

  /** Centers the given nodes at a readable zoom. */
  public focusNodes(ids: ReadonlyArray<string>): void {
    const bounds = this.scene.boundsOf(ids);
    const { camera, width, height } = this.viewport;
    if (bounds && width > 0) {
      this.moveCamera(focusCamera(bounds, camera, width, height));
    }
  }

  /** Pans (and zooms out if needed) so that the given nodes are visible. */
  public revealNodes(ids: ReadonlyArray<string>): void {
    const bounds = this.scene.boundsOf(ids);
    const { camera, width, height } = this.viewport;
    const to =
      bounds && width > 0 ? revealCamera(bounds, camera, width, height) : null;
    if (to) {
      this.moveCamera(to);
    }
  }

  /** Draws a short outline pulse around nodes, e.g. after jumping to them. */
  public pulseNodes(ids: ReadonlyArray<string>): void {
    if (!this.motion) {
      return;
    }

    const now = performance.now();
    for (const id of ids) {
      const ns = this.scene.nodes.get(id);
      if (ns) {
        ns.pulse = now;
      }
    }

    this.requestRender();
  }

  /** World point under a client (viewport) position, e.g. of a drop. */
  public worldAt(clientX: number, clientY: number): Point {
    const rect = this.canvas.getBoundingClientRect();
    return screenToWorld(this.viewport.camera, {
      x: clientX - rect.left,
      y: clientY - rect.top,
    });
  }

  /** First view of a document, once it has nodes and the canvas a size. */
  private frameFirstView(): void {
    if (this.hasFramed || this.scene.nodes.size === 0) {
      return;
    }

    const bounds = this.scene.boundsOf(this.scene.nodes.keys());
    const { width, height } = this.viewport;
    if (bounds && width > 0) {
      this.hasFramed = true;
      this.setCameraInternal(initialCamera(bounds, width, height));
    }
  }

  /** Sets the camera at once (panning, wheel, pinch), ending any easing. */
  private setCameraInternal(camera: Camera): void {
    this.viewport.set(camera);
    this.emitter.emit('cameraChange', { ...camera });
    this.requestRender();
  }

  /** Eases the camera to `camera` (fit, zoom to selection, reveal). */
  private moveCamera(camera: Camera): void {
    if (!this.motion || !this.viewport.ease(camera, performance.now())) {
      this.setCameraInternal(camera);
      return;
    }

    this.requestRender();
  }

  // ---------------------------------------------------------------- motion

  /** Moves a node, sliding there when motion is on. */
  private placeNode(ns: NodeState, to: Point): void {
    if (this.motion) {
      slideTo(ns, to, performance.now());
      return;
    }

    ns.x = to.x;
    ns.y = to.y;
    this.settle([ns]);
  }

  /** Puts sliding nodes at their targets (before the user acts on them). */
  private finishNodeMoves(): void {
    if (this.settle(finishMoves(this.scene.nodes.values()))) {
      this.requestRender();
    }
  }

  /** Indexes nodes where they are now; true if there were any. */
  private settle(nodes: ReadonlyArray<NodeState>): boolean {
    for (const ns of nodes) {
      this.scene.index.insert(ns.node.id, this.scene.nodeRect(ns));
    }

    if (nodes.length > 0) {
      this.scene.framesDirty = true;
    }

    return nodes.length > 0;
  }

  /** Advances eased moves; true while one is still running. */
  private stepMotion(now: number): boolean {
    const camera = this.viewport.step(now);
    if (camera.moved) {
      this.emitter.emit('cameraChange', { ...this.viewport.camera });
    }

    const nodes = stepNodes(this.scene.nodes.values(), now);
    if (nodes.moved) {
      this.scene.framesDirty = true;
    }

    this.settle(nodes.settled);
    return camera.running || nodes.running;
  }

  // -------------------------------------------------------------- document

  public setEditable(editable: boolean): void {
    this.editable = editable;
  }

  public setDocument(source: GraphDocument, positions: Positions): void {
    const now = performance.now();
    const previous = this.scene.load(source, positions);
    // Nodes shown before slide from where they were; added ones fade in.
    for (const [id, ns] of this.scene.nodes) {
      const before = previous.get(id);
      if (this.motion) {
        continueMove(before, ns, now);
      }

      ns.appear = before?.appear;
    }

    if (this.motion) {
      fadeInAdded(this.scene.nodes, previous, now);
    }

    this.forgetMissing();
    this.scene.rebuildIndex();
    this.frameFirstView();
    this.requestRender();
  }

  /**
   * Drops what the new document no longer has from the selection, the
   * highlight and the hover. A wire being dragged keeps going: its pins
   * are looked up by id; it ends when the pin it started from is gone.
   */
  private forgetMissing(): void {
    const { ui, scene } = this;
    ui.selection = new Set(
      [...ui.selection].filter((id) => scene.nodes.has(id))
    );
    ui.knotSelection = new Set(
      [...ui.knotSelection].filter((id) => {
        const { edgeId, index } = parseKnotId(id);
        return (scene.reroutes.get(edgeId)?.length ?? 0) > index;
      })
    );
    ui.highlight = new Set(
      [...ui.highlight].filter((id) => scene.nodes.has(id))
    );
    // Through `setHover`, so `hoverChange` tells the app (its hover card).
    if (ui.hoverNode && !scene.nodes.has(ui.hoverNode)) {
      this.setHover(null, null);
    }

    if (ui.hoverEdge && !scene.edgesById.has(ui.hoverEdge)) {
      this.setHoverEdge(null);
    }

    if (ui.pendingWire) {
      const from = resolvePin(scene.nodes, ui.pendingWire.from);
      ui.pendingWire = from ? { ...ui.pendingWire, from } : null;
    }

    const drag = ui.drag;
    if (drag?.type !== 'wire' && drag?.type !== 'moveWires') {
      return;
    }

    const from = resolvePin(scene.nodes, drag.from);
    if (!from) {
      ui.drag = null;
      return;
    }

    drag.from = from;
    drag.target = drag.target && resolvePin(scene.nodes, drag.target);
    if (drag.type === 'moveWires') {
      drag.ends = drag.ends.flatMap((end) => {
        const resolved = resolvePin(scene.nodes, end);
        return resolved ? [resolved] : [];
      });
    }
  }

  /** Rendered size of a node; use it for layout so both agree. */
  public readonly sizeOf = (
    node: GraphNode
  ): { width: number; height: number } => this.scene.sizeOf(node);

  /** Room a node needs above it (its comment bubble); use it for layout. */
  public readonly spaceAbove = (node: GraphNode): number =>
    this.scene.spaceAbove(node);

  /** No node, pin, reroute point or frame title at a world point. */
  public isEmptyAt(world: Point): boolean {
    return (
      this.hitTest(world) === null &&
      this.scene.hitWire(world, wireTolerance(this.viewport.camera.zoom)) ===
        null
    );
  }

  /** The function whose frame contains a world point (innermost). */
  public functionAt(world: Point): string | undefined {
    return this.scene.functionAt(world);
  }

  public getPositions(): Positions {
    return this.scene.positions();
  }

  public getEdge(edgeId: string): GraphEdge | undefined {
    return this.scene.edgesById.get(edgeId);
  }

  /**
   * Marks nodes with an ERROR / WARNING banner, like Blueprint nodes, or
   * NOT IN CODE for nodes of graph-only edits.
   */
  public setProblems(problems: ReadonlyMap<string, NodeBannerKind>): void {
    this.scene.setProblems(problems);
    this.requestRender();
  }

  /** Nodes highlighted from outside (e.g. the code editor cursor). */
  public setHighlight(ids: ReadonlyArray<string>): void {
    this.ui.highlight = new Set(ids);
    this.requestRender();
  }

  /** What is under a world point (`Scene.hitTest`). */
  private hitTest(world: Point): Hit | null {
    return this.scene.hitTest(world, {
      zoom: this.viewport.camera.zoom,
      editable: this.editable,
      selection: this.ui.selection,
    });
  }

  /** Shows or hides the advanced pins of a node (UE's ▼ / ▲). */
  private toggleAdvanced(ns: NodeState): void {
    this.scene.toggleAdvanced(ns);
    this.requestRender();
  }

  // ------------------------------------------------------------- selection

  public getSelection(): string[] {
    return [...this.ui.selection];
  }

  public setSelection(ids: ReadonlyArray<string>): void {
    this.ui.selection = new Set(ids.filter((id) => this.scene.nodes.has(id)));
    this.ui.knotSelection.clear();
    this.requestRender();
  }

  public selectAll(): void {
    this.ui.knotSelection = new Set(
      [...this.scene.reroutes].flatMap(([edgeId, points]) =>
        points.map((_, i) => knotId(edgeId, i))
      )
    );
    this.setSelectionInternal(new Set(this.scene.nodes.keys()));
  }

  /** Selects every node of a function (like clicking its frame title). */
  public selectFunction(fnId: string): void {
    const frame = this.scene.frames.find((f) => f.fnId === fnId);
    if (frame) {
      this.ui.knotSelection.clear();
      this.setSelectionInternal(new Set(frame.nodeIds));
    }
  }

  /** Removes the wire left over from a drop on empty space. */
  public clearPendingWire(): void {
    if (this.ui.pendingWire) {
      this.ui.pendingWire = null;
      this.requestRender();
    }
  }

  private setSelectionInternal(selection: Set<string>): void {
    const current = this.ui.selection;
    const changed =
      selection.size !== current.size ||
      [...selection].some((id) => !current.has(id));
    this.ui.selection = selection;
    if (changed) {
      this.emitter.emit('selectionChange', { nodeIds: [...selection] });
    }

    this.requestRender();
  }

  private setHover(nodeId: string | null, pin: string | null): void {
    if (nodeId === this.ui.hoverNode && pin === this.ui.hoverPin) {
      return;
    }

    this.ui.hoverNode = nodeId;
    this.ui.hoverPin = pin;
    this.emitter.emit('hoverChange', { nodeId, pin });
    this.requestRender();
  }

  /** Under the cursor: the node whose "Add pin +" button it is on. */
  private setHoverAddPin(nodeId: string | null): void {
    if (nodeId !== this.ui.hoverAddPin) {
      this.ui.hoverAddPin = nodeId;
      this.requestRender();
    }
  }

  private setHoverEdge(edgeId: string | null): void {
    if (edgeId === this.ui.hoverEdge) {
      return;
    }

    this.ui.hoverEdge = edgeId;
    this.emitter.emit('wireHoverChange', {
      edge: edgeId ? (this.scene.edgesById.get(edgeId) ?? null) : null,
    });
    this.requestRender();
  }

  // -------------------------------------------------------- reroute points

  public getReroutes(edgeId: string): Point[] {
    return this.scene.reroutesOf(edgeId);
  }

  /** Adds a reroute point on the wire, at the segment nearest to `world`. */
  public addReroute(edgeId: string, world: Point): void {
    this.commitLayout(
      this.scene.setReroutes(edgeId, this.scene.withReroute(edgeId, world))
    );
  }

  public removeReroute(edgeId: string, index: number): void {
    this.commitLayout(
      this.scene.setReroutes(
        edgeId,
        this.scene.reroutesOf(edgeId).filter((_, i) => i !== index)
      )
    );
  }

  public clearReroutes(edgeId: string): void {
    this.commitLayout(this.scene.setReroutes(edgeId, []));
  }

  private deleteSelectedKnots(): void {
    this.commitLayout(this.scene.removeKnots(this.ui.knotSelection));
  }

  /** Reroute points changed: none stays selected, the layout is saved. */
  private commitLayout(patch: LayoutPatch): void {
    this.ui.knotSelection.clear();
    this.emitter.emit('layoutChange', { patch });
    this.requestRender();
  }

  // ---------------------------------------------------------- inline edits

  /**
   * Starts editing a node comment (bubble) or a comment box title; the
   * `editComment` event carries where to show the editor.
   */
  public editComment(target: CommentTarget): void {
    if (!this.editable) {
      return;
    }

    if (target.kind === 'node') {
      this.revealNodes([target.nodeId]);
    }

    const edit = commentEdit(this.scene, target);
    if (edit) {
      this.emitter.emit('editComment', {
        target,
        value: edit.value,
        rect: this.clientRect(edit.world),
      });
    }
  }

  /** Opens the inline value editor of an unconnected input pin. */
  public editLiteral(nodeId: string, pinId: string): void {
    const ns = this.scene.nodes.get(nodeId);
    const pg = ns?.geom.pins.get(pinId);
    if (ns && pg && this.editable) {
      this.revealNodes([nodeId]);
      this.startLiteralEdit(ns, pg);
    }
  }

  private startLiteralEdit(ns: NodeState, pg: PinGeometry): void {
    const edit = literalEdit(this.scene, ns, pg);
    if (edit) {
      this.emitter.emit('editLiteral', {
        node: ns.node.id,
        pin: pg.pin.id,
        value: edit.value,
        kind: edit.kind,
        rect: this.clientRect(edit.world),
      });
    }
  }

  /**
   * A world rectangle in client coordinates, where the camera ends up:
   * revealing a node may have started a move.
   */
  private clientRect(world: Rect): Rect {
    return clientRect(
      this.getCamera(),
      this.canvas.getBoundingClientRect(),
      world
    );
  }

  // ------------------------------------------------------------- alignment

  /**
   * Arranges the selected nodes like UE's alignment tools. Straighten moves
   * each node so a wire into it (exec first) is level. Only positions
   * change; the code stays the same.
   */
  public alignSelection(mode: AlignMode): void {
    this.finishNodeMoves();
    const selected = [...this.ui.selection]
      .map((id) => this.scene.nodes.get(id))
      .filter((ns): ns is NodeState => ns !== undefined);
    const moved = alignNodes(
      mode,
      selected.map((ns) => ({
        id: ns.node.id,
        x: ns.x,
        y: ns.y,
        width: ns.geom.width,
        height: ns.geom.height,
        ...(mode === 'straighten' ? this.scene.levelOf(ns) : {}),
      }))
    );
    const patch: LayoutPatch = {};
    for (const [id, point] of moved) {
      const ns = this.scene.nodes.get(id);
      if (ns && (point.x !== ns.x || point.y !== ns.y)) {
        this.placeNode(ns, point);
        patch[id] = { ...point };
      }
    }

    if (Object.keys(patch).length > 0) {
      this.scene.framesDirty = true;
      this.emitter.emit('layoutChange', { patch });
      this.requestRender();
    }
  }

  // ----------------------------------------------------------------- input

  /** What the `Controller` may use of this view. */
  private controllerHost(): ControllerHost {
    return {
      canvas: this.canvas,
      scene: this.scene,
      viewport: this.viewport,
      ui: this.ui,
      editable: () => this.editable,
      conversions: () => this.conversions(),
      emit: (event, payload) => this.emitter.emit(event, payload),
      requestRender: () => this.requestRender(),
      hitTest: (world) => this.hitTest(world),
      setSelection: (selection) => this.setSelectionInternal(selection),
      setHover: (nodeId, pin) => this.setHover(nodeId, pin),
      setHoverEdge: (edgeId) => this.setHoverEdge(edgeId),
      setHoverAddPin: (nodeId) => this.setHoverAddPin(nodeId),
      setCamera: (camera) => this.setCameraInternal(camera),
      finishNodeMoves: () => this.finishNodeMoves(),
      toggleAdvanced: (ns) => this.toggleAdvanced(ns),
      getReroutes: (edgeId) => this.getReroutes(edgeId),
      addReroute: (edgeId, world) => this.addReroute(edgeId, world),
      removeReroute: (edgeId, index) => this.removeReroute(edgeId, index),
      deleteSelectedKnots: () => this.deleteSelectedKnots(),
      editComment: (target) => this.editComment(target),
      startLiteralEdit: (ns, pg) => this.startLiteralEdit(ns, pg),
      selectAll: () => this.selectAll(),
      alignSelection: (mode) => this.alignSelection(mode),
      frameSelection: () => this.frameSelection(),
      frameAll: () => this.frameAll(),
    };
  }
}
