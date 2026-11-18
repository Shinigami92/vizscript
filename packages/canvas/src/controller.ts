import { linkPin, pinKey, reroutePatch } from '@vizscript/core';
import type { LayoutPatch, Point } from '@vizscript/core';
import { alignKey } from './align';
import { normalizeRect, screenToWorld, zoomAt } from './camera';
import type { ControllerHost } from './controller-host';
import {
  knotId,
  parseKnotId,
  PIN_MENU_ZOOM,
  wireTolerance,
} from './graph-view-constants';
import type { ContextTarget } from './graph-view-types';
import type { Interaction } from './interaction';
import {
  connectOp,
  hoverOf,
  knotsInRect,
  moveDropTarget,
  panCamera,
  pastThreshold,
  pinchCamera,
  snappedOffset,
  wireDropTarget,
} from './pointer-drag';
import type { PointerIntent } from './pointer-intent';
import { classifyPointerDown } from './pointer-intent';
import type { Scene } from './scene';
import { clickSelection, marqueeSelection } from './selection';
import type { SelectionModifiers } from './selection';
import type { Viewport } from './viewport';

/**
 * The pointer, wheel and key handlers of a `GraphView`: what a press
 * starts, what a drag does while it moves and when it ends.
 */
export class Controller {
  private readonly canvas: HTMLCanvasElement;
  private readonly scene: Scene;
  private readonly viewport: Viewport;
  private readonly ui: Interaction;
  private readonly pointers = new Map<number, Point>();
  private readonly disposers: Array<() => void> = [];
  private spaceDown = false;

  public constructor(private readonly host: ControllerHost) {
    this.canvas = host.canvas;
    this.scene = host.scene;
    this.viewport = host.viewport;
    this.ui = host.ui;
  }

  /** Listens to the canvas; `detach` stops. */
  public attach(): void {
    const canvas = this.canvas;
    canvas.tabIndex = 0;
    canvas.style.touchAction = 'none';
    canvas.style.outline = 'none';
    this.listen('pointerdown', (e) => this.onPointerDown(e));
    this.listen('pointermove', (e) => this.onPointerMove(e));
    this.listen('pointerup', (e) => this.onPointerUp(e));
    this.listen('pointercancel', (e) => this.onPointerCancel(e));
    this.listen('pointerleave', () => {
      this.host.setHoverEdge(null);
      this.host.setHover(null, null);
    });
    this.listen('dblclick', (e) => this.onDoubleClick(e));
    this.listen('wheel', (e) => this.onWheel(e), { passive: false });
    this.listen('contextmenu', (e) => e.preventDefault());
    this.listen('keydown', (e) => this.onKeyDown(e));
    this.listen('keyup', (e) => {
      if (e.code === 'Space') {
        this.spaceDown = false;
      }
    });
  }

  public detach(): void {
    for (const dispose of this.disposers.splice(0)) {
      dispose();
    }
  }

  private listen<K extends keyof HTMLElementEventMap>(
    type: K,
    handler: (e: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions
  ): void {
    this.canvas.addEventListener(type, handler, options);
    this.disposers.push(() =>
      this.canvas.removeEventListener(type, handler, options)
    );
  }

  private clientPoint(e: MouseEvent): Point {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private toWorld(e: MouseEvent): Point {
    return screenToWorld(this.viewport.camera, this.clientPoint(e));
  }

  private mods(e: MouseEvent | KeyboardEvent): SelectionModifiers {
    return { add: e.shiftKey, toggle: e.ctrlKey || e.metaKey };
  }

  private onPointerDown(e: PointerEvent): void {
    this.viewport.tween = null;
    this.host.finishNodeMoves();
    this.canvas.focus({ preventScroll: true });
    this.canvas.setPointerCapture(e.pointerId);
    const client = this.clientPoint(e);
    this.pointers.set(e.pointerId, client);

    if (e.pointerType === 'touch' && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()] as [Point, Point];
      this.ui.drag = {
        type: 'pinch',
        startDistance: Math.hypot(a.x - b.x, a.y - b.y),
        startMid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        startCamera: { ...this.viewport.camera },
      };
      return;
    }

    if (this.pointers.size > 1) {
      return;
    }

    const world = this.toWorld(e);
    const hit = this.host.hitTest(world);
    const intent = classifyPointerDown({
      hit,
      button: e.button,
      pointerType: e.pointerType,
      spaceDown: this.spaceDown,
      shift: e.shiftKey,
      ctrl: e.ctrlKey || e.metaKey,
      alt: e.altKey,
      editable: this.host.editable(),
      wireEnds: () =>
        hit?.type === 'pin' ? this.scene.wireEnds(hit.ns, hit.pg) : [],
      wireAt: () =>
        this.scene.hitWire(world, wireTolerance(this.viewport.camera.zoom))
          ?.edge ?? null,
    });
    this.startIntent(intent, e, client, world);
  }

  /** Carries out what a pointer press starts (`classifyPointerDown`). */
  private startIntent(
    intent: PointerIntent,
    e: PointerEvent,
    client: Point,
    world: Point
  ): void {
    const mods = this.mods(e);
    switch (intent.type) {
      case 'none': {
        return;
      }

      case 'pan': {
        this.ui.drag = {
          type: 'pan',
          startClient: client,
          startCamera: { ...this.viewport.camera },
          moved: false,
          button: e.button,
          tapNode: intent.tapNode,
        };
        return;
      }

      case 'removeKnot': {
        this.host.removeReroute(intent.edgeId, intent.index);
        return;
      }

      case 'knot': {
        const id = knotId(intent.edgeId, intent.index);
        if (mods.toggle && this.ui.knotSelection.has(id)) {
          this.ui.knotSelection.delete(id);
        } else if (mods.add || mods.toggle) {
          this.ui.knotSelection.add(id);
        } else if (!this.ui.knotSelection.has(id)) {
          this.ui.knotSelection = new Set([id]);
          this.host.setSelection(new Set());
        }

        if (this.ui.knotSelection.has(id)) {
          this.startNodeDrag([...this.ui.selection], world, id);
        }

        this.host.requestRender();
        return;
      }

      case 'toggleAdvanced': {
        this.host.toggleAdvanced(intent.ns);
        return;
      }

      case 'addArgument': {
        this.host.emit('op', { type: 'addArgument', node: intent.nodeId });
        return;
      }

      case 'disconnectPin': {
        this.host.emit('op', {
          type: 'disconnect',
          pin: { node: intent.node, pin: intent.pin },
        });
        return;
      }

      case 'moveWires': {
        this.ui.drag = {
          type: 'moveWires',
          from: intent.from,
          ends: [...intent.ends],
          currentWorld: world,
          target: null,
          problem: null,
        };
        this.host.requestRender();
        return;
      }

      case 'wire': {
        this.ui.drag = {
          type: 'wire',
          from: intent.from,
          currentWorld: world,
          target: null,
          problem: null,
          replaces: null,
          empty: false,
          convert: null,
        };
        this.host.requestRender();
        return;
      }

      case 'toggleCheckbox': {
        this.host.emit('op', {
          type: 'setLiteral',
          node: intent.node,
          pin: intent.pin,
          value: intent.value,
        });
        return;
      }

      case 'node': {
        const id = intent.nodeId;
        if (!mods.add && !mods.toggle && !this.ui.selection.has(id)) {
          this.ui.knotSelection.clear();
        }

        const selection = clickSelection(this.ui.selection, id, mods);
        this.host.setSelection(selection);
        if (selection.has(id)) {
          this.startNodeDrag([...selection], world, id);
        }

        return;
      }

      case 'frame': {
        if (!mods.add && !mods.toggle) {
          this.ui.knotSelection.clear();
        }

        const selection =
          mods.add || mods.toggle
            ? new Set([...this.ui.selection, ...intent.frame.nodeIds])
            : new Set(intent.frame.nodeIds);
        this.host.setSelection(selection);
        this.startNodeDrag([...selection], world);
        return;
      }

      case 'breakWire': {
        this.host.emit('op', {
          type: 'disconnect',
          pin: { ...linkPin(intent.edge) },
        });
        return;
      }

      case 'marquee': {
        const base =
          mods.add || mods.toggle
            ? new Set(this.ui.selection)
            : new Set<string>();
        if (!mods.add && !mods.toggle) {
          this.ui.knotSelection.clear();
          this.host.setSelection(new Set());
        }

        this.ui.drag = {
          type: 'marquee',
          startWorld: world,
          currentWorld: world,
          base,
          baseKnots: new Set(this.ui.knotSelection),
          mods,
        };
      }
    }
  }

  /** What a right-click at `world` opens the menu for. */
  private contextTarget(world: Point): ContextTarget {
    const hit = this.host.hitTest(world);
    // Zoomed out, pins are too small to aim at: the node's menu instead.
    const pinTarget =
      (hit?.type === 'pin' || hit?.type === 'literal') &&
      this.viewport.camera.zoom >= PIN_MENU_ZOOM;
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
        if (!this.ui.selection.has(id)) {
          this.ui.knotSelection.clear();
          this.host.setSelection(new Set([id]));
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
        const wire = this.scene.hitWire(
          world,
          wireTolerance(this.viewport.camera.zoom)
        );
        return wire
          ? { kind: 'wire', edge: wire.edge }
          : { kind: 'background' };
      }
    }
  }

  /** `grabbed`: the node or reroute (knot id) under the pointer. */
  private startNodeDrag(ids: string[], world: Point, grabbed?: string): void {
    const origins = new Map<string, Point>();
    for (const id of ids) {
      const ns = this.scene.nodes.get(id);
      if (ns) {
        origins.set(id, { x: ns.x, y: ns.y });
      }
    }

    const knotOrigins = new Map<string, Point>();
    for (const id of this.ui.knotSelection) {
      const { edgeId, index } = parseKnotId(id);
      const p = this.scene.reroutes.get(edgeId)?.[index];
      if (p) {
        knotOrigins.set(id, { ...p });
      }
    }

    const anchor = (grabbed
      ? (origins.get(grabbed) ?? knotOrigins.get(grabbed))
      : undefined) ??
      origins.values().next().value ??
      knotOrigins.values().next().value ?? { ...world };
    this.ui.drag = {
      type: 'nodes',
      ids,
      startWorld: world,
      anchor,
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

    const drag = this.ui.drag;
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
        this.host.setCamera(
          pinchCamera(
            {
              camera: drag.startCamera,
              mid: drag.startMid,
              distance: drag.startDistance,
            },
            a,
            b
          )
        );
        return;
      }

      case 'pan': {
        const dx = client.x - drag.startClient.x;
        const dy = client.y - drag.startClient.y;
        if (!drag.moved && !pastThreshold(dx, dy)) {
          return;
        }

        drag.moved = true;
        this.host.setCamera(panCamera(drag.startCamera, dx, dy));
        return;
      }

      case 'nodes': {
        const world = this.toWorld(e);
        const dx = world.x - drag.startWorld.x;
        const dy = world.y - drag.startWorld.y;
        const zoom = this.viewport.camera.zoom;
        if (!drag.moved && !pastThreshold(dx * zoom, dy * zoom)) {
          return;
        }

        drag.moved = true;
        const { x: sx, y: sy } = snappedOffset(drag.anchor, dx, dy);
        for (const [id, origin] of drag.origins) {
          const ns = this.scene.nodes.get(id);
          if (ns) {
            ns.x = Math.round(origin.x + sx);
            ns.y = Math.round(origin.y + sy);
          }
        }

        for (const [id, origin] of drag.knotOrigins) {
          const { edgeId, index } = parseKnotId(id);
          const p = this.scene.reroutes.get(edgeId)?.[index];
          if (p) {
            p.x = Math.round(origin.x + sx);
            p.y = Math.round(origin.y + sy);
          }
        }

        this.scene.framesDirty = true;
        this.host.requestRender();
        return;
      }

      case 'marquee': {
        drag.currentWorld = this.toWorld(e);
        const rect = normalizeRect(drag.startWorld, drag.currentWorld);
        const hits = this.scene.index.query(rect);
        const knots = knotsInRect(this.scene.reroutes, rect);
        this.ui.knotSelection = marqueeSelection(
          drag.baseKnots,
          knots,
          drag.mods
        );
        this.host.setSelection(marqueeSelection(drag.base, hits, drag.mods));
        return;
      }

      case 'moveWires': {
        const world = this.toWorld(e);
        drag.currentWorld = world;
        Object.assign(drag, moveDropTarget(drag, this.host.hitTest(world)));
        this.host.requestRender();
        return;
      }

      case 'wire': {
        const world = this.toWorld(e);
        drag.currentWorld = world;
        Object.assign(
          drag,
          wireDropTarget(
            drag.from,
            this.host.hitTest(world),
            this.host.conversions(),
            (end) =>
              this.scene.connectedPins.has(
                pinKey({ node: end.ns.node.id, pin: end.pg.pin.id })
              )
          )
        );
        this.host.requestRender();
      }
    }
  }

  private updateHover(world: Point): void {
    const hit = this.host.hitTest(world);
    const edge = hit
      ? null
      : this.scene.hitWire(world, wireTolerance(this.viewport.camera.zoom));
    const hover = hoverOf(
      hit,
      edge?.edge.id ?? null,
      this.host.editable(),
      this.spaceDown
    );
    this.host.setHoverEdge(hover.edge);
    this.host.setHoverAddPin(hover.addPin);
    this.host.setHover(hover.node, hover.pin);
    this.canvas.style.cursor = hover.cursor;
  }

  private onPointerUp(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    if (this.canvas.hasPointerCapture(e.pointerId)) {
      this.canvas.releasePointerCapture(e.pointerId);
    }

    const drag = this.ui.drag;
    if (!drag) {
      return;
    }

    if (drag.type === 'pinch') {
      if (this.pointers.size === 0) {
        this.ui.drag = null;
      }

      return;
    }

    this.ui.drag = null;

    switch (drag.type) {
      case 'pan': {
        if (!drag.moved) {
          if (drag.button === 2) {
            const world = this.toWorld(e);
            this.host.emit('contextMenu', {
              world,
              client: { x: e.clientX, y: e.clientY },
              target: this.contextTarget(world),
            });
          } else if (e.pointerType === 'touch') {
            this.host.setSelection(
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
            const ns = this.scene.nodes.get(id);
            if (ns) {
              patch[id] = { x: ns.x, y: ns.y };
              this.scene.index.insert(id, this.scene.nodeRect(ns));
            }
          }

          const edges = new Set(
            [...drag.knotOrigins.keys()].map((id) => parseKnotId(id).edgeId)
          );
          for (const edgeId of edges) {
            const points = this.host.getReroutes(edgeId);
            Object.assign(patch, reroutePatch(edgeId, points, points));
          }

          this.scene.framesDirty = true;
          this.host.emit('layoutChange', { patch });
        }

        break;
      }

      case 'marquee': {
        break;
      }

      case 'moveWires': {
        if (drag.target) {
          this.host.emit('op', {
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
          this.host.emit('op', connectOp(from, drag.target, drag.convert));
        } else if (
          // A frame or comment box title counts as empty space too.
          (this.host.hitTest(drag.currentWorld)?.type ?? 'frame') === 'frame'
        ) {
          // Like Blueprints: dropping a wire on empty space opens the
          // actions for that pin; the wire stays until the menu closes.
          const ref = { node: from.ns.node.id, pin: from.pg.pin.id };
          this.ui.pendingWire = { from, world: drag.currentWorld };
          this.host.emit('contextMenu', {
            world: drag.currentWorld,
            client: { x: e.clientX, y: e.clientY },
            target: { kind: 'pin', pin: ref },
            from: ref,
          });
        }

        break;
      }
    }

    this.host.requestRender();
  }

  /** The browser took the pointer over (a scroll, a system gesture). */
  private onPointerCancel(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    if (this.canvas.hasPointerCapture(e.pointerId)) {
      this.canvas.releasePointerCapture(e.pointerId);
    }

    if (this.ui.drag?.type !== 'pinch' || this.pointers.size === 0) {
      this.cancelDrag();
    }
  }

  /**
   * Ends a drag without its result (Escape, a cancelled pointer): moved
   * nodes and reroute points go back, a marquee restores the selection, a
   * wire is dropped. Returns whether there was one.
   */
  private cancelDrag(): boolean {
    const drag = this.ui.drag;
    if (!drag) {
      return false;
    }

    this.ui.drag = null;
    switch (drag.type) {
      case 'nodes': {
        for (const [id, origin] of drag.origins) {
          const ns = this.scene.nodes.get(id);
          if (ns) {
            ns.x = origin.x;
            ns.y = origin.y;
          }
        }

        for (const [id, origin] of drag.knotOrigins) {
          const { edgeId, index } = parseKnotId(id);
          const p = this.scene.reroutes.get(edgeId)?.[index];
          if (p) {
            p.x = origin.x;
            p.y = origin.y;
          }
        }

        this.scene.framesDirty = true;
        break;
      }

      case 'marquee': {
        this.ui.knotSelection = new Set(drag.baseKnots);
        this.host.setSelection(new Set(drag.base));
        break;
      }

      case 'pan':
      case 'pinch':
      case 'wire':
      case 'moveWires': {
        break;
      }
    }

    this.host.requestRender();
    return true;
  }

  private onDoubleClick(e: MouseEvent): void {
    const world = this.toWorld(e);
    const hit = this.host.hitTest(world);
    if (!hit) {
      const wire = this.scene.hitWire(
        world,
        wireTolerance(this.viewport.camera.zoom)
      );
      if (wire) {
        this.host.addReroute(wire.edge.id, world);
      }

      return;
    }

    if (hit.type === 'frame' && hit.frame.boxId) {
      this.host.editComment({ kind: 'box', boxId: hit.frame.boxId });
      return;
    }

    if (hit.type === 'bubble') {
      this.host.editComment({ kind: 'node', nodeId: hit.ns.node.id });
      return;
    }

    if (hit.type === 'frame' && hit.frame.kind === 'function') {
      this.host.emit('openFunction', { fnId: hit.frame.fnId });
      return;
    }

    if (hit.type === 'frame' || hit.type === 'knot') {
      return;
    }

    if (
      hit.type === 'literal' &&
      this.host.editable() &&
      hit.pg.pin.literal?.editable !== false
    ) {
      // Checkboxes toggle on click instead.
      if (hit.pg.pin.literal?.kind !== 'boolean') {
        this.host.startLiteralEdit(hit.ns, hit.pg);
      }

      return;
    }

    this.host.emit('activate', { nodeId: hit.ns.node.id });
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const anchor = this.clientPoint(e);
    const scale =
      e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.viewport.height : 1;
    const dx = e.deltaX * scale;
    const dy = e.deltaY * scale;
    // Pinch on trackpads arrives as ctrl+wheel; classic mouse wheels send
    // large discrete steps. Everything else (two finger scroll) pans.
    const isMouseWheel = dx === 0 && Math.abs(dy) >= 50 && Number.isInteger(dy);
    if (e.ctrlKey || e.metaKey || isMouseWheel) {
      const factor = Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015));
      this.host.setCamera(zoomAt(this.viewport.camera, anchor, factor));
      return;
    }

    this.host.setCamera({
      ...this.viewport.camera,
      x: this.viewport.camera.x + dx / this.viewport.camera.zoom,
      y: this.viewport.camera.y + dy / this.viewport.camera.zoom,
    });
  }

  private onKeyDown(e: KeyboardEvent): void {
    this.host.finishNodeMoves();
    if (e.code === 'Space') {
      this.spaceDown = true;
      e.preventDefault();
      return;
    }

    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (this.ui.knotSelection.size > 0) {
        e.preventDefault();
        this.host.deleteSelectedKnots();
      }

      if (this.ui.selection.size > 0 && this.host.editable()) {
        e.preventDefault();
        this.host.emit('op', {
          type: 'deleteNodes',
          nodeIds: [...this.ui.selection],
        });
      }

      return;
    }

    if (e.key === 'Escape') {
      // The first Escape cancels a drag, the next one clears the selection.
      if (this.cancelDrag()) {
        return;
      }

      this.ui.knotSelection.clear();
      this.host.setSelection(new Set());
      return;
    }

    const command = e.ctrlKey || e.metaKey;
    if ((e.key === 'a' || e.key === 'A') && command) {
      e.preventDefault();
      this.host.selectAll();
      return;
    }

    // UE's alignment keys: Q straightens, Shift+W/S/A/D align top, bottom,
    // left, right, Alt+Shift+W/S align middle and center.
    const align = command ? undefined : alignKey(e);
    if (align) {
      e.preventDefault();
      this.host.alignSelection(align);
      return;
    }

    if (command || e.altKey) {
      return;
    }

    if (e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      this.host.frameSelection();
    } else if (e.key === 'Home') {
      e.preventDefault();
      this.host.frameAll();
    }
  }
}
