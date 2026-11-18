import { reroutePatch } from '@vizscript/core';
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
import { BUBBLE_GAP } from './bubble';
import { screenToWorld, worldToScreen } from './camera';
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
    const now = performance.now();
    const previous = this.scene.load(source, positions);
    for (const [id, ns] of this.scene.nodes) {
      const before = previous.get(id);
      this.continueMove(before, ns, now);
      ns.appear = before?.appear;
    }

    this.selection = new Set(
      [...this.selection].filter((id) => this.scene.nodes.has(id))
    );
    this.knotSelection = new Set(
      [...this.knotSelection].filter((id) => {
        const { edgeId, index } = parseKnotId(id);
        return (this.scene.reroutes.get(edgeId)?.length ?? 0) > index;
      })
    );
    this.highlight = new Set(
      [...this.highlight].filter((id) => this.scene.nodes.has(id))
    );
    if (this.hoverNode && !this.scene.nodes.has(this.hoverNode)) {
      this.hoverNode = null;
      this.hoverPin = null;
    }

    if (this.hoverEdge && !this.scene.edgesById.has(this.hoverEdge)) {
      this.setHoverEdge(null);
    }

    this.resolveDragPins();
    this.fadeInNewNodes(previous, now);
    this.scene.rebuildIndex();
    if (!this.hasFramed && this.scene.nodes.size > 0 && this.width > 0) {
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
      const from = resolvePin(this.scene.nodes, this.pendingWire.from);
      this.pendingWire = from ? { ...this.pendingWire, from } : null;
    }

    const drag = this.drag;
    if (drag?.type !== 'wire' && drag?.type !== 'moveWires') {
      return;
    }

    const from = resolvePin(this.scene.nodes, drag.from);
    if (!from) {
      this.drag = null;
      return;
    }

    drag.from = from;
    drag.target = drag.target && resolvePin(this.scene.nodes, drag.target);
    if (drag.type === 'moveWires') {
      drag.ends = drag.ends.flatMap((end) => {
        const resolved = resolvePin(this.scene.nodes, end);
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

  /** Shows or hides the advanced pins of a node (UE's ▼ / ▲). */
  protected toggleAdvanced(ns: NodeState): void {
    this.scene.toggleAdvanced(ns);
    this.requestRender();
  }

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
      this.scene.hitWire(world, this.wireTolerance()) === null
    );
  }

  /** The function whose frame contains a world point (innermost). */
  public functionAt(world: Point): string | undefined {
    return this.scene.functionAt(world);
  }

  public getPositions(): Positions {
    const result: Positions = {};
    for (const [id, ns] of this.scene.nodes) {
      result[id] = ns.tween ? { ...ns.tween.to } : { x: ns.x, y: ns.y };
    }

    return result;
  }

  public getSelection(): string[] {
    return [...this.selection];
  }

  public setSelection(ids: ReadonlyArray<string>): void {
    this.selection = new Set(ids.filter((id) => this.scene.nodes.has(id)));
    this.knotSelection.clear();
    this.requestRender();
  }

  public selectAll(): void {
    this.knotSelection = new Set(
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
    return this.scene.edgesById.get(edgeId);
  }

  public getReroutes(edgeId: string): Point[] {
    return (this.scene.reroutes.get(edgeId) ?? []).map((p) => ({ ...p }));
  }

  /** Adds a reroute point on the wire, at the segment nearest to `world`. */
  public addReroute(edgeId: string, world: Point): void {
    const segment = this.scene.hitWire(world, Number.POSITIVE_INFINITY, edgeId);
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
      this.scene.reroutes.set(
        edgeId,
        after.map((p) => ({ ...p }))
      );
    } else {
      this.scene.reroutes.delete(edgeId);
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
        this.scene.reroutes.set(edgeId, after);
      } else {
        this.scene.reroutes.delete(edgeId);
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
    this.scene.setProblems(problems);
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
      const ns = this.scene.nodes.get(target.nodeId);
      if (!ns) {
        return;
      }

      this.revealNodes([target.nodeId]);
      value = ns.node.comment?.text ?? '';
      world = this.scene.bubbleRect(ns) ?? {
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
      this.scene.updateFrames();
      const frame = this.scene.frames.find((f) => f.boxId === target.boxId);
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
    const ns = this.scene.nodes.get(nodeId);
    const pg = ns?.geom.pins.get(pinId);
    if (ns && pg && this.editable) {
      this.revealNodes([nodeId]);
      this.startLiteralEdit(ns, pg);
    }
  }

  protected startLiteralEdit(ns: NodeState, pg: PinGeometry): void {
    const r = this.scene.literalRect(ns, pg);
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
        ...(mode === 'straighten' ? this.levelOf(ns) : {}),
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

  /** The wire Straighten levels for a node, as `alignNodes` takes it. */
  private levelOf(ns: NodeState): Pick<AlignNode, 'level'> {
    const fn = this.scene.doc?.functions.find((f) => f.id === ns.fnId);
    const edge = levelEdge(fn?.edges ?? [], ns.node.id);
    if (!edge) {
      return {};
    }

    const [mine, other] =
      edge.to.node === ns.node.id ? [edge.to, edge.from] : [edge.from, edge.to];
    const otherNs = this.scene.nodes.get(other.node);
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
