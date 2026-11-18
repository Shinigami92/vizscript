import type { Point } from '@vizscript/core';
import type { Camera } from './camera';
import { GraphViewBase } from './graph-view-base';
import type { NodeState } from './graph-view-types';
import {
  continueMove,
  fadeInAdded,
  finishMoves,
  slideTo,
  stepNodes,
  stopMotion,
} from './node-motion';
import {
  fitAll,
  fitSelection,
  focusCamera,
  initialCamera,
  revealCamera,
} from './viewport';

/** Camera moves and the eased motion of the camera and nodes. */
export abstract class GraphViewCamera extends GraphViewBase {
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
    const bounds = this.scene.boundsOf(this.selection);
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

  /** First view of a document (`initialCamera`). */
  protected initialView(): void {
    const bounds = this.scene.boundsOf(this.scene.nodes.keys());
    if (bounds) {
      const { width, height } = this.viewport;
      this.setCameraInternal(initialCamera(bounds, width, height));
    }
  }

  /** Sets the camera at once (panning, wheel, pinch), ending any easing. */
  protected setCameraInternal(camera: Camera): void {
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

  /**
   * After a new document: nodes shown before slide from where they were,
   * and nodes an edit added fade in.
   */
  protected animateLoad(
    previous: ReadonlyMap<string, NodeState>,
    now: number
  ): void {
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
  }

  /** Moves a node, sliding there when motion is on. */
  protected placeNode(ns: NodeState, to: Point): void {
    if (this.motion) {
      slideTo(ns, to, performance.now());
      return;
    }

    ns.x = to.x;
    ns.y = to.y;
    this.settle([ns]);
  }

  /** Puts sliding nodes at their targets (before the user acts on them). */
  protected finishNodeMoves(): void {
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
  protected stepMotion(now: number): boolean {
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
}
