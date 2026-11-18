import {
  boxColorIndex,
  COMMENT_BOX_COLORS,
  extractReroutes,
  noReroutesKey,
  pinKey,
  reroutePatch,
  wiredNodes,
  withImplicitSelf,
} from '@vizscript/core';
import type {
  GraphDocument,
  GraphEdge,
  GraphNode,
  LayoutPatch,
  PinGeometry,
  Point,
  Positions,
} from '@vizscript/core';
import type { AlignNode } from './align';
import { alignNodes, levelEdge } from './align';
import { BUBBLE_GAP, bubbleText, layoutBubble } from './bubble';
import { worldToScreen } from './camera';
import type { Rect } from './camera';
import { COMMENT_HEADER, knotId, parseKnotId } from './graph-view-constants';
import { GraphViewRenderer } from './graph-view-renderer';
import type {
  AlignMode,
  CommentTarget,
  NodeBannerKind,
  NodeState,
} from './graph-view-types';
import { resolvePin } from './pin-ref';

/** The shown document, selection, reroute points, edits and alignment. */
export abstract class GraphViewDocument extends GraphViewRenderer {
  // ------------------------------------------------------------ public API

  public setEditable(editable: boolean): void {
    this.editable = editable;
  }

  public setDocument(source: GraphDocument, positions: Positions): void {
    // Drawn with UE's implicit `self` (Target boxes instead of wires).
    const doc = {
      ...source,
      functions: source.functions.map(withImplicitSelf),
    };
    this.doc = doc;
    const previous = this.nodes;
    const now = performance.now();
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
        const ns: NodeState = {
          node: shown.node,
          full: node,
          advanced: shown.advanced,
          fnId: fn.id,
          geom: shown.geom,
          x: p.x,
          y: p.y,
          bubble: bubbleText(node.comment)
            ? layoutBubble(bubbleText(node.comment), this.metrics.measure)
            : null,
        };
        this.continueMove(previous.get(node.id), ns, now);
        ns.appear = previous.get(node.id)?.appear;
        this.nodes.set(node.id, ns);
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
      this.setHoverEdge(null);
    }

    this.resolveDragPins();
    this.fadeInNewNodes(previous, now);
    this.rebuildIndex();
    if (!this.hasFramed && this.nodes.size > 0 && this.width > 0) {
      this.hasFramed = true;
      this.initialView();
    }

    this.requestRender();
  }

  /**
   * A wire being dragged keeps going in the new document: its pins are
   * looked up by id. It ends when the pin it started from is gone.
   */
  private resolveDragPins(): void {
    if (this.pendingWire) {
      const from = resolvePin(this.nodes, this.pendingWire.from);
      this.pendingWire = from ? { ...this.pendingWire, from } : null;
    }

    const drag = this.drag;
    if (drag?.type !== 'wire' && drag?.type !== 'moveWires') {
      return;
    }

    const from = resolvePin(this.nodes, drag.from);
    if (!from) {
      this.drag = null;
      return;
    }

    drag.from = from;
    drag.target = drag.target && resolvePin(this.nodes, drag.target);
    if (drag.type === 'moveWires') {
      drag.ends = drag.ends.flatMap((end) => {
        const resolved = resolvePin(this.nodes, end);
        return resolved ? [resolved] : [];
      });
    }
  }

  /** Rendered size of a node; use it for layout so both agree. */
  public readonly sizeOf = (
    node: GraphNode
  ): { width: number; height: number } => {
    const { geom } = this.nodeGeometry(node);
    return { width: geom.width, height: geom.height };
  };

  /** Room a node needs above it (its comment bubble); use it for layout. */
  public readonly spaceAbove = (node: GraphNode): number => {
    const text = bubbleText(node.comment);
    return text
      ? layoutBubble(text, this.metrics.measure).height + BUBBLE_GAP
      : 0;
  };

  /** Shows or hides the advanced pins of a node (UE's ▼ / ▲). */
  protected toggleAdvanced(ns: NodeState): void {
    if (this.expandedNodes.has(ns.full.id)) {
      this.expandedNodes.delete(ns.full.id);
    } else {
      this.expandedNodes.add(ns.full.id);
    }

    const shown = this.nodeGeometry(ns.full);
    ns.node = shown.node;
    ns.geom = shown.geom;
    this.rebuildIndex();
    this.requestRender();
  }

  public getPositions(): Positions {
    const result: Positions = {};
    for (const [id, ns] of this.nodes) {
      result[id] = ns.tween ? { ...ns.tween.to } : { x: ns.x, y: ns.y };
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

  protected deleteSelectedKnots(): void {
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
  /**
   * Marks nodes with an ERROR / WARNING banner, like Blueprint nodes, or
   * NOT IN CODE for nodes of graph-only edits.
   */
  public setProblems(problems: ReadonlyMap<string, NodeBannerKind>): void {
    const before = this.problems;
    this.problems = new Map(problems);
    // Nodes that got or lost a banner change their height.
    let resized = false;
    for (const [id, ns] of this.nodes) {
      if (before.has(id) !== this.problems.has(id)) {
        const shown = this.nodeGeometry(ns.full);
        ns.node = shown.node;
        ns.geom = shown.geom;
        resized = true;
      }
    }

    if (resized) {
      this.rebuildIndex();
    }

    this.framesDirty = true;
    this.requestRender();
  }

  public setHighlight(ids: ReadonlyArray<string>): void {
    this.highlight = new Set(ids);
    this.requestRender();
  }

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

    // Where the camera ends up: revealing the node may have started a move.
    const camera = this.getCamera();
    const bounds = this.canvas.getBoundingClientRect();
    const topLeft = worldToScreen(camera, { x: world.x, y: world.y });
    this.emitter.emit('editComment', {
      target,
      value,
      rect: {
        x: bounds.left + topLeft.x,
        y: bounds.top + topLeft.y,
        width: world.width * camera.zoom,
        height: world.height * camera.zoom,
      },
    });
  }

  /** Opens the inline value editor of an unconnected input pin. */
  public editLiteral(nodeId: string, pinId: string): void {
    const ns = this.nodes.get(nodeId);
    const pg = ns?.geom.pins.get(pinId);
    if (ns && pg && this.editable) {
      this.revealNodes([nodeId]);
      this.startLiteralEdit(ns, pg);
    }
  }

  protected startLiteralEdit(ns: NodeState, pg: PinGeometry): void {
    const r = this.literalRect(ns, pg);
    const literal = pg.pin.literal;
    if (!r || !literal) {
      return;
    }

    // Where the camera ends up: revealing the node may have started a move.
    const camera = this.getCamera();
    const bounds = this.canvas.getBoundingClientRect();
    const topLeft = worldToScreen(camera, { x: r.x, y: r.y });
    this.emitter.emit('editLiteral', {
      node: ns.node.id,
      pin: pg.pin.id,
      value: literal.value,
      kind: literal.kind,
      rect: {
        x: bounds.left + topLeft.x,
        y: bounds.top + topLeft.y,
        width: r.width * camera.zoom,
        height: r.height * camera.zoom,
      },
    });
  }

  // ------------------------------------------------------------- alignment

  /**
   * Arranges the selected nodes like UE's alignment tools. Straighten moves
   * each node so a wire into it (exec first) is level. Only positions
   * change; the code stays the same.
   */
  public alignSelection(mode: AlignMode): void {
    this.finishNodeMoves();
    const selected = [...this.selection]
      .map((id) => this.nodes.get(id))
      .filter((ns): ns is NodeState => ns !== undefined);
    const moved = alignNodes(
      mode,
      selected.map((ns) => ({
        id: ns.node.id,
        x: ns.x,
        y: ns.y,
        width: ns.geom.width,
        height: ns.geom.height,
        ...(mode === 'straighten' ? this.levelOf(ns) : {}),
      }))
    );
    const patch: LayoutPatch = {};
    for (const [id, point] of moved) {
      const ns = this.nodes.get(id);
      if (ns && (point.x !== ns.x || point.y !== ns.y)) {
        this.placeNode(ns, point);
        patch[id] = { ...point };
      }
    }

    if (Object.keys(patch).length > 0) {
      this.framesDirty = true;
      this.emitter.emit('layoutChange', { patch });
      this.requestRender();
    }
  }

  /** The wire Straighten levels for a node, as `alignNodes` takes it. */
  private levelOf(ns: NodeState): Pick<AlignNode, 'level'> {
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
}
