import type { Rect } from './camera';

/**
 * Uniform grid for fast rectangle queries (hit-testing, culling). Queries
 * return items in a fixed order, the order they were first inserted in
 * (moving an item keeps its place): the canvas draws them in it, so it is
 * also their stacking order.
 */
export class SpatialIndex<T> {
  private readonly cells = new Map<string, Set<T>>();
  private readonly items = new Map<T, Rect>();
  private readonly order = new Map<T, number>();
  private nextOrder = 0;

  public constructor(private readonly cellSize = 256) {}

  private *cellKeys(rect: Rect): Generator<string> {
    const x0 = Math.floor(rect.x / this.cellSize);
    const y0 = Math.floor(rect.y / this.cellSize);
    const x1 = Math.floor((rect.x + rect.width) / this.cellSize);
    const y1 = Math.floor((rect.y + rect.height) / this.cellSize);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        yield `${x},${y}`;
      }
    }
  }

  public clear(): void {
    this.cells.clear();
    this.items.clear();
    this.order.clear();
    this.nextOrder = 0;
  }

  public insert(item: T, rect: Rect): void {
    this.remove(item);
    if (!this.order.has(item)) {
      this.order.set(item, this.nextOrder++);
    }

    this.items.set(item, rect);
    for (const key of this.cellKeys(rect)) {
      let cell = this.cells.get(key);
      if (!cell) {
        cell = new Set();
        this.cells.set(key, cell);
      }

      cell.add(item);
    }
  }

  public remove(item: T): void {
    const rect = this.items.get(item);
    if (!rect) {
      return;
    }

    for (const key of this.cellKeys(rect)) {
      this.cells.get(key)?.delete(item);
    }

    this.items.delete(item);
  }

  /**
   * Items whose rectangles intersect `rect`, bottom first (the order they
   * were first inserted in), whatever the rectangle.
   */
  public query(rect: Rect): T[] {
    const result = new Set<T>();
    for (const key of this.cellKeys(rect)) {
      const cell = this.cells.get(key);
      if (!cell) {
        continue;
      }

      for (const item of cell) {
        const r = this.items.get(item);
        if (
          r &&
          r.x < rect.x + rect.width &&
          rect.x < r.x + r.width &&
          r.y < rect.y + rect.height &&
          rect.y < r.y + r.height
        ) {
          result.add(item);
        }
      }
    }

    return [...result].toSorted(
      (a, b) => (this.order.get(a) ?? 0) - (this.order.get(b) ?? 0)
    );
  }
}
