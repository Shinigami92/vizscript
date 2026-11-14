import type { Point } from './ir';

/** Size of a grid cell, like UE's graph grid (lines every 16 units). */
export const GRID_SIZE = 16;
/** Every 8th grid line is darker. */
export const GRID_MAJOR = GRID_SIZE * 8;

/**
 * The nearest grid point: nodes sit with their top-left corner on the
 * grid, like in UE, when they are laid out, placed or dragged.
 */
export function snapToGrid(p: Point): Point {
  // `|| 0`: no `-0` for small negative values.
  return {
    x: Math.round(p.x / GRID_SIZE) * GRID_SIZE || 0,
    y: Math.round(p.y / GRID_SIZE) * GRID_SIZE || 0,
  };
}
