import {
  easeOut,
  fitCamera,
  lerpCamera,
  visibleWorldRect,
  zoomAt,
} from './camera';
import type { Camera, Rect } from './camera';
import { CAMERA_MOTION_MS } from './graph-view-constants';
import type { Tween } from './graph-view-types';

/** The camera that fits `bounds` into the view, up to 100 %. */
export function fitAll(bounds: Rect, width: number, height: number): Camera {
  return fitCamera(bounds, width, height, 48, 1);
}

/** The camera that fits a selection, with more margin than `fitAll`. */
export function fitSelection(
  bounds: Rect,
  width: number,
  height: number
): Camera {
  return fitCamera(bounds, width, height, 80, 1);
}

/** The camera centered on `bounds` at a readable zoom (at least 80 %). */
export function focusCamera(
  bounds: Rect,
  camera: Camera,
  width: number,
  height: number
): Camera {
  const zoom = Math.max(camera.zoom, 0.8);
  const fit = fitCamera(bounds, width, height, 80, zoom);
  return fit.zoom < zoom * 0.99
    ? fit
    : {
        zoom,
        x: bounds.x + bounds.width / 2 - width / 2 / zoom,
        y: bounds.y + bounds.height / 2 - height / 2 / zoom,
      };
}

/**
 * The camera that shows `bounds`: `null` if they are in view, else panned
 * there at the same zoom, or zoomed out if they don't fit.
 */
export function revealCamera(
  bounds: Rect,
  camera: Camera,
  width: number,
  height: number
): Camera | null {
  const view = visibleWorldRect(camera, width, height);
  const inside =
    bounds.x >= view.x &&
    bounds.y >= view.y &&
    bounds.x + bounds.width <= view.x + view.width &&
    bounds.y + bounds.height <= view.y + view.height;
  if (inside) {
    return null;
  }

  const fitsAtZoom =
    bounds.width * camera.zoom < width - 80 &&
    bounds.height * camera.zoom < height - 80;
  return fitsAtZoom
    ? {
        zoom: camera.zoom,
        x: bounds.x + bounds.width / 2 - width / 2 / camera.zoom,
        y: bounds.y + bounds.height / 2 - height / 2 / camera.zoom,
      }
    : fitCamera(bounds, width, height, 48, camera.zoom);
}

/**
 * First view of a document: everything if it stays readable, otherwise the
 * top-left (module entry) at a readable zoom.
 */
export function initialCamera(
  bounds: Rect,
  width: number,
  height: number
): Camera {
  const fit = fitAll(bounds, width, height);
  if (fit.zoom >= 0.55) {
    return fit;
  }

  const zoom = 0.85;
  return { zoom, x: bounds.x - 48 / zoom, y: bounds.y - 48 / zoom };
}

/** The camera, the size of the canvas and the camera's eased moves. */
export class Viewport {
  public camera: Camera = { x: -40, y: -40, zoom: 1 };
  public tween: Tween<Camera> | null = null;
  /** CSS pixels. */
  public width = 0;
  public height = 0;
  public dpr = 1;

  /** The camera, or where an eased move ends. */
  public target(): Camera {
    return { ...(this.tween?.to ?? this.camera) };
  }

  /** Sets the camera at once, ending any easing. */
  public set(camera: Camera): void {
    this.tween = null;
    this.camera = { ...camera };
  }

  /** Eases to `camera` from `now`; false (set at once) without size. */
  public ease(camera: Camera, now: number): boolean {
    if (this.width === 0) {
      this.set(camera);
      return false;
    }

    this.tween = { from: { ...this.camera }, to: camera, start: now };
    return true;
  }

  /** The camera zoomed around the center of the view. */
  public zoomedBy(factor: number): Camera {
    const center = { x: this.width / 2, y: this.height / 2 };
    return zoomAt(this.target(), center, factor);
  }

  /**
   * Advances an eased move to `now`. `moved`: the camera changed;
   * `running`: the move goes on.
   */
  public step(now: number): { moved: boolean; running: boolean } {
    const tween = this.tween;
    if (!tween) {
      return { moved: false, running: false };
    }

    const t = (now - tween.start) / CAMERA_MOTION_MS;
    if (t >= 1) {
      this.camera = tween.to;
      this.tween = null;
      return { moved: true, running: false };
    }

    this.camera = lerpCamera(
      tween.from,
      tween.to,
      easeOut(t),
      this.width,
      this.height
    );
    return { moved: true, running: true };
  }
}
