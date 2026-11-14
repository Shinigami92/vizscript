import { pinKey, reroutePatch } from '@vizscript/core';
import type { LayoutPatch, Point } from '@vizscript/core';
import { normalizeRect, zoomAt } from './camera';
import {
  DRAG_THRESHOLD,
  isChecked,
  knotId,
  parseKnotId,
} from './graph-view-constants';
import { GraphViewDocument } from './graph-view-document';
import type { AlignMode, GraphViewOptions } from './graph-view-types';
import { clickSelection, marqueeSelection } from './selection';
import type { SelectionModifiers } from './selection';

/** UE's alignment shortcuts. */
function alignKey(e: KeyboardEvent): AlignMode | undefined {
  const key = e.key.toLowerCase();
  if (key === 'q' && !e.shiftKey && !e.altKey) {
    return 'straighten';
  }

  if (!e.shiftKey) {
    return undefined;
  }

  // Alt changes `e.key` on macOS (Alt+Shift+W is „): use the key's code.
  const code = e.code.replace(/^Key/, '').toLowerCase();
  if (e.altKey) {
    return code === 'w' ? 'middle' : code === 's' ? 'center' : undefined;
  }

  const modes: Record<string, AlignMode> = {
    w: 'top',
    s: 'bottom',
    a: 'left',
    d: 'right',
  };
  return modes[code];
}

/**
 * Framework-agnostic Canvas2D renderer and interaction controller for
 * Blueprint-style graphs.
 */
export class GraphView extends GraphViewDocument {
  private readonly resizeObserver: ResizeObserver;
  private readonly pointers = new Map<number, Point>();
  private readonly disposers: Array<() => void> = [];
  private spaceDown = false;

  public constructor(
    canvas: HTMLCanvasElement,
    options: GraphViewOptions = {}
  ) {
    super(canvas, options);
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

  public destroy(): void {
    this.resizeObserver.disconnect();
    for (const dispose of this.disposers) {
      dispose();
    }

    this.emitter.clear();
  }

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

  // ----------------------------------------------------------------- input

  private mods(e: MouseEvent | KeyboardEvent): SelectionModifiers {
    return { add: e.shiftKey, toggle: e.ctrlKey || e.metaKey };
  }

  private onPointerDown(e: PointerEvent): void {
    this.cameraTween = null;
    this.finishNodeMoves();
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

    if (hit?.type === 'node' && hit.advanced) {
      this.toggleAdvanced(hit.ns);
      return;
    }

    if (hit?.type === 'pin' && this.editable) {
      const ref = { node: hit.ns.node.id, pin: hit.pg.pin.id };
      if (e.altKey) {
        this.emitter.emit('op', { type: 'disconnect', pin: ref });
        return;
      }

      // Like UE: Ctrl+drag picks up all wires of the pin.
      const ends = e.ctrlKey || e.metaKey ? this.wireEnds(hit.ns, hit.pg) : [];
      if (ends.length > 0) {
        this.drag = {
          type: 'moveWires',
          from: { ns: hit.ns, pg: hit.pg },
          ends,
          currentWorld: world,
          target: null,
          problem: null,
        };
        this.requestRender();
        return;
      }

      this.drag = {
        type: 'wire',
        from: { ns: hit.ns, pg: hit.pg },
        currentWorld: world,
        target: null,
        problem: null,
        replaces: false,
        empty: false,
      };
      this.requestRender();
      return;
    }

    // Like UE: a boolean value is a checkbox that toggles on click.
    if (
      hit?.type === 'literal' &&
      this.editable &&
      hit.pg.pin.literal?.kind === 'boolean'
    ) {
      this.emitter.emit('op', {
        type: 'setLiteral',
        node: hit.ns.node.id,
        pin: hit.pg.pin.id,
        value: isChecked(hit.pg.pin.literal.value) ? 'false' : 'true',
      });
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

      case 'moveWires': {
        const world = this.toWorld(e);
        drag.currentWorld = world;
        const hit = this.hitTest(world);
        const problem =
          hit?.type === 'pin' && hit.pg !== drag.from.pg
            ? this.moveProblem(drag, hit)
            : null;
        drag.target =
          hit?.type === 'pin' && hit.pg !== drag.from.pg && !problem
            ? { ns: hit.ns, pg: hit.pg }
            : null;
        drag.problem = problem;
        this.requestRender();
        return;
      }

      case 'wire': {
        const world = this.toWorld(e);
        drag.currentWorld = world;
        const hit = this.hitTest(world);
        const problem =
          hit?.type === 'pin' && hit.pg !== drag.from.pg
            ? this.connectProblem(drag.from, hit)
            : null;
        drag.target =
          hit?.type === 'pin' && hit.pg !== drag.from.pg && !problem
            ? { ns: hit.ns, pg: hit.pg }
            : null;
        drag.problem = problem;
        // A data input takes one wire: the new one replaces it.
        const input =
          drag.target?.pg.pin.direction === 'in' ? drag.target : drag.from;
        drag.replaces =
          drag.target !== null &&
          input.pg.pin.kind === 'data' &&
          this.connectedPins.has(
            pinKey({ node: input.ns.node.id, pin: input.pg.pin.id })
          );
        // A frame or comment box title counts as empty space too.
        drag.empty = (hit?.type ?? 'frame') === 'frame';
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
        hit.type === 'node' && hit.advanced
          ? 'pointer'
          : hit.type === 'pin' && this.editable
            ? 'crosshair'
            : hit.type === 'literal' &&
                this.editable &&
                hit.pg.pin.literal?.editable !== false
              ? hit.pg.pin.literal?.kind === 'boolean'
                ? 'pointer'
                : 'text'
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

      case 'moveWires': {
        if (drag.target) {
          this.emitter.emit('op', {
            type: 'moveWires',
            from: { node: drag.from.ns.node.id, pin: drag.from.pg.pin.id },
            to: { node: drag.target.ns.node.id, pin: drag.target.pg.pin.id },
          });
        }

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
        } else if (
          // A frame or comment box title counts as empty space too.
          (this.hitTest(drag.currentWorld)?.type ?? 'frame') === 'frame'
        ) {
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

    if (hit.type === 'frame' && hit.frame.kind === 'function') {
      this.emitter.emit('openFunction', { fnId: hit.frame.fnId });
      return;
    }

    if (hit.type === 'frame' || hit.type === 'knot') {
      return;
    }

    if (
      hit.type === 'literal' &&
      this.editable &&
      hit.pg.pin.literal?.editable !== false
    ) {
      // Checkboxes toggle on click instead.
      if (hit.pg.pin.literal?.kind !== 'boolean') {
        this.startLiteralEdit(hit.ns, hit.pg);
      }

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
    this.finishNodeMoves();
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

    // UE's alignment keys: Q straightens, Shift+W/S/A/D align top, bottom,
    // left, right, Alt+Shift+W/S align middle and center.
    const align = command ? undefined : alignKey(e);
    if (align) {
      e.preventDefault();
      this.alignSelection(align);
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
}
