import type { Point } from '@vizscript/core';

/** Screen = (world - camera.xy) * zoom */
export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 2;

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export function screenToWorld(camera: Camera, p: Point): Point {
  return { x: p.x / camera.zoom + camera.x, y: p.y / camera.zoom + camera.y };
}

export function worldToScreen(camera: Camera, p: Point): Point {
  return {
    x: (p.x - camera.x) * camera.zoom,
    y: (p.y - camera.y) * camera.zoom,
  };
}

/** Zooms by `factor` keeping the world point under `anchor` (screen) fixed. */
export function zoomAt(camera: Camera, anchor: Point, factor: number): Camera {
  const zoom = clampZoom(camera.zoom * factor);
  const world = screenToWorld(camera, anchor);
  return { zoom, x: world.x - anchor.x / zoom, y: world.y - anchor.y / zoom };
}

/** Ease-out (cubic) for short UI animations: fast start, soft landing. */
export function easeOut(t: number): number {
  return 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;
}

/**
 * Camera between `from` (t = 0) and `to` (t = 1): the zoom changes
 * geometrically and the center of the view moves in a straight line.
 */
export function lerpCamera(
  from: Camera,
  to: Camera,
  t: number,
  viewportWidth: number,
  viewportHeight: number
): Camera {
  const zoom = from.zoom * (to.zoom / from.zoom) ** t;
  const center = (camera: Camera): Point => ({
    x: camera.x + viewportWidth / 2 / camera.zoom,
    y: camera.y + viewportHeight / 2 / camera.zoom,
  });
  const a = center(from);
  const b = center(to);
  return {
    zoom,
    x: a.x + (b.x - a.x) * t - viewportWidth / 2 / zoom,
    y: a.y + (b.y - a.y) * t - viewportHeight / 2 / zoom,
  };
}

export function visibleWorldRect(
  camera: Camera,
  width: number,
  height: number
): Rect {
  return {
    x: camera.x,
    y: camera.y,
    width: width / camera.zoom,
    height: height / camera.zoom,
  };
}

/** Camera that fits `bounds` into a viewport with some padding. */
export function fitCamera(
  bounds: Rect,
  viewportWidth: number,
  viewportHeight: number,
  padding = 40,
  maxZoom = 1
): Camera {
  const zoom = clampZoom(
    Math.min(
      maxZoom,
      (viewportWidth - padding * 2) / Math.max(bounds.width, 1),
      (viewportHeight - padding * 2) / Math.max(bounds.height, 1)
    )
  );
  return {
    zoom,
    x: bounds.x + bounds.width / 2 - viewportWidth / 2 / zoom,
    y: bounds.y + bounds.height / 2 - viewportHeight / 2 / zoom,
  };
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

/** Smallest rectangle containing both. */
export function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

export function rectContains(r: Rect, p: Point): boolean {
  return (
    p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height
  );
}

export function normalizeRect(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

/**
 * Compact text form of a camera for URLs: `x,y,zoom` with whole world units
 * and three decimals of zoom, e.g. `-40,120,0.85`.
 */
export function formatCameraParam(camera: Camera): string {
  const zoom = Math.round(clampZoom(camera.zoom) * 1000) / 1000;
  return `${Math.round(camera.x)},${Math.round(camera.y)},${zoom}`;
}

/** Parses {@link formatCameraParam}; `null` for anything malformed. */
export function parseCameraParam(value: unknown): Camera | null {
  const text = Array.isArray(value) ? value[0] : value;
  if (typeof text !== 'string') {
    return null;
  }

  const parts = text.split(',').map(Number);
  if (parts.length !== 3 || !parts.every((n) => Number.isFinite(n))) {
    return null;
  }

  const [x, y, zoom] = parts as [number, number, number];
  return zoom > 0 ? { x, y, zoom: clampZoom(zoom) } : null;
}
