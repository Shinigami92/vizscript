import type { Point } from '@vizscript/core';
import {
  easeOut,
  fitCamera,
  lerpCamera,
  visibleWorldRect,
  zoomAt,
} from './camera';
import type { Camera } from './camera';
import {
  CAMERA_MOTION_MS,
  NODE_APPEAR_MS,
  NODE_MOTION_MS,
  NODE_PULSE_MS,
  samePoint,
} from './graph-view-constants';
import { GraphViewHitTest } from './graph-view-hit-test';
import type { NodeState } from './graph-view-types';

/** Camera moves and the eased motion of the camera and nodes. */
export abstract class GraphViewCamera extends GraphViewHitTest {
  /** Turns eased camera and node moves on or off (reduced motion). */
  public setMotion(motion: boolean): void {
    this.motion = motion;
    if (!motion) {
      this.cameraTween = null;
      this.finishNodeMoves();
      for (const ns of this.nodes.values()) {
        ns.appear = undefined;
        ns.pulse = undefined;
      }
    }
  }

  /** The camera, or where an eased camera move ends. */
  public getCamera(): Camera {
    return { ...(this.cameraTween?.to ?? this.camera) };
  }

  public setCamera(camera: Camera): void {
    this.cameraTween = null;
    this.camera = { ...camera };
    this.hasFramed = true;
    this.requestRender();
  }

  /** Zooms around the center of the view (`factor` > 1 zooms in). */
  public zoomBy(factor: number): void {
    const center = { x: this.width / 2, y: this.height / 2 };
    this.moveCamera(zoomAt(this.getCamera(), center, factor));
  }

  /** Sets the zoom level, keeping the center of the view in place. */
  public setZoom(zoom: number): void {
    this.zoomBy(zoom / this.getCamera().zoom);
  }

  public frameAll(): void {
    const bounds = this.boundsOf([...this.nodes.keys()]);
    if (bounds) {
      this.moveCamera(fitCamera(bounds, this.width, this.height, 48, 1));
    }
  }

  /** Zooms to the selection, or to everything when nothing is selected. */
  public frameSelection(): void {
    const bounds = this.boundsOf(this.selection);
    if (bounds) {
      this.moveCamera(fitCamera(bounds, this.width, this.height, 80, 1));
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
    this.moveCamera(
      fit.zoom < zoom * 0.99
        ? fit
        : {
            zoom,
            x: bounds.x + bounds.width / 2 - this.width / 2 / zoom,
            y: bounds.y + bounds.height / 2 - this.height / 2 / zoom,
          }
    );
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
      this.moveCamera({
        zoom: this.camera.zoom,
        x: bounds.x + bounds.width / 2 - this.width / 2 / this.camera.zoom,
        y: bounds.y + bounds.height / 2 - this.height / 2 / this.camera.zoom,
      });
    } else {
      this.moveCamera(
        fitCamera(bounds, this.width, this.height, 48, this.camera.zoom)
      );
    }
  }

  /**
   * First view of a document: fit everything if it stays readable, otherwise
   * start at the top-left (module entry) at a readable zoom.
   */
  protected initialView(): void {
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

  /** Sets the camera at once (panning, wheel, pinch), ending any easing. */
  protected setCameraInternal(camera: Camera): void {
    this.cameraTween = null;
    this.camera = camera;
    this.emitter.emit('cameraChange', { ...camera });
    this.requestRender();
  }

  /** Eases the camera to `camera` (fit, zoom to selection, reveal). */
  private moveCamera(camera: Camera): void {
    if (!this.motion || this.width === 0) {
      this.setCameraInternal(camera);
      return;
    }

    this.cameraTween = {
      from: { ...this.camera },
      to: camera,
      start: performance.now(),
    };
    this.requestRender();
  }

  /** Draws a short outline pulse around nodes, e.g. after jumping to them. */
  public pulseNodes(ids: ReadonlyArray<string>): void {
    if (!this.motion) {
      return;
    }

    const now = performance.now();
    for (const id of ids) {
      const ns = this.nodes.get(id);
      if (ns) {
        ns.pulse = now;
      }
    }

    this.requestRender();
  }

  /**
   * Fades in nodes an edit added. Only when the document is the one shown
   * before (some nodes stay), so opening another file just shows it.
   */
  protected fadeInNewNodes(
    previous: ReadonlyMap<string, NodeState>,
    now: number
  ): void {
    if (!this.motion || previous.size === 0) {
      return;
    }

    const added = [...this.nodes.keys()].filter((id) => !previous.has(id));
    if (added.length === 0 || added.length === this.nodes.size) {
      return;
    }

    for (const id of added) {
      const ns = this.nodes.get(id);
      if (ns) {
        ns.appear = now;
      }
    }
  }

  /**
   * Lets a node that was already shown slide from where it is drawn to its
   * new position. A slide to the same target keeps going.
   */
  protected continueMove(
    previous: NodeState | undefined,
    ns: NodeState,
    now: number
  ): void {
    if (!previous || !this.motion) {
      return;
    }

    const to = { x: ns.x, y: ns.y };
    if (previous.tween && samePoint(previous.tween.to, to)) {
      ns.tween = previous.tween;
    } else if (!samePoint(previous, to)) {
      ns.tween = { from: { x: previous.x, y: previous.y }, to, start: now };
    } else {
      return;
    }

    ns.x = previous.x;
    ns.y = previous.y;
  }

  /** Moves a node, sliding there when motion is on. */
  protected placeNode(ns: NodeState, to: Point): void {
    if (this.motion) {
      ns.tween = { from: { x: ns.x, y: ns.y }, to, start: performance.now() };
      return;
    }

    ns.x = to.x;
    ns.y = to.y;
    this.index.insert(ns.node.id, this.nodeRect(ns));
  }

  /** Puts sliding nodes at their targets (before the user acts on them). */
  protected finishNodeMoves(): void {
    let finished = false;
    for (const ns of this.nodes.values()) {
      if (ns.tween) {
        ns.x = ns.tween.to.x;
        ns.y = ns.tween.to.y;
        ns.tween = undefined;
        this.index.insert(ns.node.id, this.nodeRect(ns));
        finished = true;
      }
    }

    if (finished) {
      this.framesDirty = true;
      this.requestRender();
    }
  }

  /** Advances eased moves; true while one is still running. */
  protected stepMotion(now: number): boolean {
    let running = false;
    const tween = this.cameraTween;
    if (tween) {
      const t = (now - tween.start) / CAMERA_MOTION_MS;
      if (t >= 1) {
        this.camera = tween.to;
        this.cameraTween = null;
      } else {
        this.camera = lerpCamera(
          tween.from,
          tween.to,
          easeOut(t),
          this.width,
          this.height
        );
        running = true;
      }

      this.emitter.emit('cameraChange', { ...this.camera });
    }

    for (const ns of this.nodes.values()) {
      const move = ns.tween;
      if (!move) {
        continue;
      }

      const t = (now - move.start) / NODE_MOTION_MS;
      const k = easeOut(t);
      ns.x = move.from.x + (move.to.x - move.from.x) * k;
      ns.y = move.from.y + (move.to.y - move.from.y) * k;
      this.framesDirty = true;
      if (t >= 1) {
        ns.tween = undefined;
        this.index.insert(ns.node.id, this.nodeRect(ns));
      } else {
        running = true;
      }
    }

    for (const ns of this.nodes.values()) {
      if (ns.appear !== undefined && now - ns.appear >= NODE_APPEAR_MS) {
        ns.appear = undefined;
      }

      if (ns.pulse !== undefined && now - ns.pulse >= NODE_PULSE_MS) {
        ns.pulse = undefined;
      }

      running ||= ns.appear !== undefined || ns.pulse !== undefined;
    }

    return running;
  }
}
