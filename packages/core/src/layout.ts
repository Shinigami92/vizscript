import type {
  FunctionGraph,
  GraphDocument,
  GraphNode,
  Point,
  Positions,
} from './ir';

export interface Size {
  width: number;
  height: number;
}

export interface LayoutOptions {
  sizeOf: (node: GraphNode) => Size;
  gapX?: number;
  gapY?: number;
  functionGap?: number;
  /**
   * Exec chains wider than this continue on a new row below, like wrapped
   * text, so long functions stay readable.
   */
  maxRowWidth?: number;
  /** Room a node needs above it, e.g. for its comment bubble. */
  spaceAbove?: (node: GraphNode) => number;
  /** Room a comment box needs above its nodes (title bar and padding). */
  commentBoxTop?: number;
  /**
   * Least space between the nodes of two functions, so their frames don't
   * overlap (frame padding and title bar). Default 110.
   */
  frameGap?: number;
}

/**
 * Room above each node: its own (bubble) plus the title bars of the comment
 * boxes it is in.
 */
function spaceAboveNodes(
  fn: FunctionGraph,
  options: LayoutOptions
): Map<string, number> {
  const boxTop = options.commentBoxTop ?? 0;
  const depth = new Map<string, number>();
  for (const box of fn.comments ?? []) {
    for (const id of box.nodes) {
      depth.set(id, (depth.get(id) ?? 0) + 1);
    }
  }

  const result = new Map<string, number>();
  for (const node of fn.nodes) {
    const space =
      (options.spaceAbove?.(node) ?? 0) + (depth.get(node.id) ?? 0) * boxTop;
    if (space > 0) {
      result.set(node.id, space);
    }
  }

  return result;
}

interface FunctionIndex {
  nodes: Map<string, GraphNode>;
  /** Exec successors in pin order: [pinId, nodeId]. */
  execChildren: Map<string, Array<[string, string]>>;
  execParent: Map<string, string>;
  /** Pure data sources feeding a node, in pin order. */
  dataInputs: Map<string, string[]>;
  dataConsumer: Map<string, string>;
}

function indexFunction(fn: FunctionGraph): FunctionIndex {
  const nodes = new Map(fn.nodes.map((n) => [n.id, n]));
  const pinOrder = (nodeId: string, pinId: string): number =>
    nodes.get(nodeId)?.pins.findIndex((p) => p.id === pinId) ?? 0;

  const execChildren = new Map<string, Array<[string, string]>>();
  const execParent = new Map<string, string>();
  const dataInputs = new Map<string, string[]>();
  const dataConsumer = new Map<string, string>();

  const execEdges = fn.edges
    .filter((e) => e.kind === 'exec')
    .toSorted(
      (a, b) =>
        pinOrder(a.from.node, a.from.pin) - pinOrder(b.from.node, b.from.pin)
    );
  for (const edge of execEdges) {
    if (execParent.has(edge.to.node)) {
      continue;
    }

    execParent.set(edge.to.node, edge.from.node);
    const list = execChildren.get(edge.from.node) ?? [];
    list.push([edge.from.pin, edge.to.node]);
    execChildren.set(edge.from.node, list);
  }

  const dataEdges = fn.edges
    .filter((e) => e.kind === 'data')
    .toSorted(
      (a, b) => pinOrder(a.to.node, a.to.pin) - pinOrder(b.to.node, b.to.pin)
    );
  for (const edge of dataEdges) {
    const source = nodes.get(edge.from.node);
    if (
      !source ||
      source.purity !== 'pure' ||
      dataConsumer.has(edge.from.node)
    ) {
      continue;
    }

    dataConsumer.set(edge.from.node, edge.to.node);
    const list = dataInputs.get(edge.to.node) ?? [];
    list.push(edge.from.node);
    dataInputs.set(edge.to.node, list);
  }

  return { nodes, execChildren, execParent, dataInputs, dataConsumer };
}

/**
 * Deterministic Blueprint-like layout:
 *
 * - the exec flow runs left to right as a tidy tree,
 * - "continuation" pins (e.g. `Completed`) continue on the main row to the
 *   right of all other branches,
 * - pure expression trees are placed left of (and below) their consumer.
 *
 * Saved positions always win. Nodes without a saved position are moved by
 * the same offset as their nearest positioned ancestor so that new nodes
 * appear next to their neighbors.
 */
export function layoutDocument(
  doc: GraphDocument,
  options: LayoutOptions,
  saved: Positions = {}
): Positions {
  const gapX = options.gapX ?? 60;
  const gapY = options.gapY ?? 30;
  const functionGap = options.functionGap ?? 140;
  const maxRowWidth = options.maxRowWidth ?? 2400;

  const result: Positions = {};
  const boxes: FunctionBox[] = [];
  let offsetY = 0;

  for (const fn of doc.functions) {
    const index = indexFunction(fn);
    const above = spaceAboveNodes(fn, options);
    const auto = layoutFunction(
      fn,
      index,
      options.sizeOf,
      above,
      gapX,
      gapY,
      maxRowWidth
    );

    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const node of fn.nodes) {
      const p = auto.get(node.id);
      if (!p) {
        continue;
      }

      minY = Math.min(minY, p.y - (above.get(node.id) ?? 0));
      maxY = Math.max(maxY, p.y + options.sizeOf(node).height);
    }

    if (!Number.isFinite(minY)) {
      minY = 0;
      maxY = 0;
    }

    const shiftY = offsetY - minY;
    for (const [id, p] of auto) {
      auto.set(id, { x: p.x, y: p.y + shiftY });
    }

    offsetY += maxY - minY + functionGap;

    mergeSaved(fn, index, auto, saved, result);
    avoidSavedNodes(fn, saved, result, options.sizeOf, gapY);
    separateFunction(fn, above, result, boxes, options);
  }

  return result;
}

/** Outline of a function's nodes. */
interface FunctionBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * A function that grew into an earlier one below or beside it (nodes added
 * where there was room, all positions saved) moves down until their frames
 * no longer overlap, like separate graphs in UE.
 */
function separateFunction(
  fn: FunctionGraph,
  above: ReadonlyMap<string, number>,
  positions: Positions,
  boxes: FunctionBox[],
  options: LayoutOptions
): void {
  const gap = options.frameGap ?? 110;
  let box: FunctionBox | undefined;
  for (const node of fn.nodes) {
    const p = positions[node.id];
    if (!p) {
      continue;
    }

    const size = options.sizeOf(node);
    const top = p.y - (above.get(node.id) ?? 0);
    box = box
      ? {
          left: Math.min(box.left, p.x),
          top: Math.min(box.top, top),
          right: Math.max(box.right, p.x + size.width),
          bottom: Math.max(box.bottom, p.y + size.height),
        }
      : { left: p.x, top, right: p.x + size.width, bottom: p.y + size.height };
  }

  if (!box) {
    return;
  }

  // Only earlier functions that share columns with this one count.
  let shift = 0;
  for (const other of boxes) {
    const sideBySide =
      box.right + gap <= other.left || other.right + gap <= box.left;
    const clear =
      box.top + shift >= other.bottom + gap ||
      box.bottom + shift + gap <= other.top;
    if (!sideBySide && !clear) {
      shift = other.bottom + gap - box.top;
    }
  }

  if (shift > 0) {
    for (const node of fn.nodes) {
      const p = positions[node.id];
      if (p) {
        positions[node.id] = { x: p.x, y: p.y + shift };
      }
    }
  }

  boxes.push({ ...box, top: box.top + shift, bottom: box.bottom + shift });
}

function mergeSaved(
  fn: FunctionGraph,
  index: FunctionIndex,
  auto: Map<string, Point>,
  saved: Positions,
  out: Positions
): void {
  const deltaCache = new Map<string, Point | null>();

  const deltaOf = (id: string, depth = 0): Point | null => {
    if (deltaCache.has(id)) {
      return deltaCache.get(id) ?? null;
    }

    let delta: Point | null = null;
    const own = saved[id];
    const autoPos = auto.get(id);
    if (own && autoPos) {
      delta = { x: own.x - autoPos.x, y: own.y - autoPos.y };
    } else if (depth < 512) {
      const parent = index.dataConsumer.get(id) ?? index.execParent.get(id);
      delta = parent ? deltaOf(parent, depth + 1) : null;
    }

    deltaCache.set(id, delta);
    return delta;
  };

  for (const node of fn.nodes) {
    const own = saved[node.id];
    if (own) {
      out[node.id] = { x: own.x, y: own.y };
      continue;
    }

    const autoPos = auto.get(node.id) ?? { x: 0, y: 0 };
    const delta = deltaOf(node.id);
    out[node.id] = delta
      ? { x: autoPos.x + delta.x, y: autoPos.y + delta.y }
      : autoPos;
  }
}

function layoutFunction(
  fn: FunctionGraph,
  index: FunctionIndex,
  sizeOf: (node: GraphNode) => Size,
  above: ReadonlyMap<string, number>,
  gapX: number,
  gapY: number,
  maxRowWidth: number
): Map<string, Point> {
  const positions = new Map<string, Point>();
  const widthCache = new Map<string, number>();
  /** Lowest edge of everything placed so far; wrapped rows start below. */
  let maxBottom = 0;

  const size = (id: string): Size => {
    const node = index.nodes.get(id);
    return node ? sizeOf(node) : { width: 0, height: 0 };
  };

  const isContinuationPin = (id: string, pinId: string): boolean =>
    index.nodes.get(id)?.pins.find((p) => p.id === pinId)?.meta
      ?.continuation === true;

  /**
   * Room needed above an exec row: the row is the node, its first branch
   * and its continuation (all placed at the same height), recursively.
   */
  const rowAboveCache = new Map<string, number>();
  const rowAbove = (id: string, depth = 0): number => {
    const cached = rowAboveCache.get(id);
    if (cached !== undefined) {
      return cached;
    }

    rowAboveCache.set(id, 0);
    let space = above.get(id) ?? 0;
    if (depth < 512) {
      const children = index.execChildren.get(id) ?? [];
      const first = children.find(([pin]) => !isContinuationPin(id, pin));
      const next = children.find(([pin]) => isContinuationPin(id, pin));
      for (const child of [first, next]) {
        if (child && !positions.has(child[1])) {
          space = Math.max(space, rowAbove(child[1], depth + 1));
        }
      }
    }

    rowAboveCache.set(id, space);
    return space;
  };

  const dataSubtreeWidth = (id: string, depth = 0): number => {
    const cached = widthCache.get(id);
    if (cached !== undefined) {
      return cached;
    }

    const inputs = index.dataInputs.get(id) ?? [];
    const childWidth =
      depth > 256
        ? 0
        : Math.max(0, ...inputs.map((c) => dataSubtreeWidth(c, depth + 1)));
    const width = size(id).width + (inputs.length > 0 ? gapX + childWidth : 0);
    widthCache.set(id, width);
    return width;
  };

  /** Places a pure tree with its root's right edge at `right`. Returns bottom. */
  const placeData = (id: string, right: number, top: number): number => {
    if (positions.has(id)) {
      return top;
    }

    const s = size(id);
    const x = right - s.width;
    positions.set(id, { x, y: top });
    let bottom = top + s.height;
    maxBottom = Math.max(maxBottom, bottom);
    let childTop = top;
    for (const child of index.dataInputs.get(id) ?? []) {
      const childBottom = placeData(child, x - gapX * 0.6, childTop);
      bottom = Math.max(bottom, childBottom);
      childTop = childBottom + gapY * 0.5;
    }

    return bottom;
  };

  /** Places an exec subtree. Returns its bounding right / bottom. */
  const placeExec = (
    id: string,
    x: number,
    y: number,
    rowStart = 0
  ): { right: number; bottom: number } => {
    if (positions.has(id)) {
      return { right: x, bottom: y };
    }

    const s = size(id);
    const inputs = index.dataInputs.get(id) ?? [];
    const dataWidth =
      inputs.length > 0
        ? Math.max(...inputs.map((c) => dataSubtreeWidth(c))) + gapX * 0.6
        : 0;
    const nx = x + dataWidth;
    positions.set(id, { x: nx, y });

    let bottom = y + s.height;
    let right = nx + s.width;
    maxBottom = Math.max(maxBottom, bottom);

    let dataTop = y + 56;
    for (const input of inputs) {
      const b = placeData(input, nx - gapX * 0.6, dataTop);
      bottom = Math.max(bottom, b);
      dataTop = b + gapY * 0.5;
    }

    const children = index.execChildren.get(id) ?? [];
    const branches = children.filter(([pin]) => !isContinuationPin(id, pin));
    const continuation = children.find(([pin]) => isContinuationPin(id, pin));

    /** Places a successor, wrapping to a new row when it gets too wide. */
    const placeNext = (
      child: string,
      cx: number,
      cy: number
    ): { right: number; bottom: number } => {
      if (cx - rowStart > maxRowWidth && !positions.has(child)) {
        return placeExec(
          child,
          rowStart,
          maxBottom + gapY * 2.5 + rowAbove(child),
          rowStart
        );
      }

      return placeExec(child, cx, cy, rowStart);
    };

    let childY = y;
    let branchRight = right;
    for (const [i, [, child]] of branches.entries()) {
      // The first branch shares this row; later ones need room above them.
      const top = i === 0 ? childY : childY + rowAbove(child);
      const r = placeNext(child, right + gapX, top);
      branchRight = Math.max(branchRight, r.right);
      bottom = Math.max(bottom, r.bottom);
      childY = r.bottom + gapY;
    }

    right = branchRight;
    if (continuation) {
      const r = placeNext(continuation[1], branchRight + gapX, y);
      right = Math.max(right, r.right);
      bottom = Math.max(bottom, r.bottom);
    }

    return { right, bottom };
  };

  let cursorY = 0;
  const roots = fn.nodes.filter((n) => n.kind === 'entry');
  for (const root of roots) {
    const r = placeExec(root.id, 0, cursorY + rowAbove(root.id));
    cursorY = r.bottom + gapY * 2;
  }

  // Disconnected impure nodes (e.g. unreachable code) start new rows.
  for (const node of fn.nodes) {
    if (
      !positions.has(node.id) &&
      node.purity === 'impure' &&
      !index.execParent.has(node.id)
    ) {
      const r = placeExec(node.id, 0, cursorY + rowAbove(node.id));
      cursorY = r.bottom + gapY * 2;
    }
  }

  // Remaining impure nodes reachable only from unplaced parents.
  for (const node of fn.nodes) {
    if (!positions.has(node.id) && node.purity === 'impure') {
      const r = placeExec(node.id, 0, cursorY + rowAbove(node.id));
      cursorY = r.bottom + gapY * 2;
    }
  }

  // Leftover pure nodes (e.g. feeding impure-less contexts) in a row.
  let cursorX = 0;
  for (const node of fn.nodes) {
    if (positions.has(node.id)) {
      continue;
    }

    const width = dataSubtreeWidth(node.id);
    if (index.dataConsumer.has(node.id)) {
      continue;
    }

    placeData(node.id, cursorX + width, cursorY);
    cursorX += width + gapX;
  }

  // Anything still unplaced (cycles, consumers without position).
  for (const node of fn.nodes) {
    if (!positions.has(node.id)) {
      positions.set(node.id, { x: cursorX, y: cursorY });
      cursorX += size(node.id).width + gapX;
    }
  }

  return positions;
}

/**
 * Nodes without a saved position (e.g. a getter created by an edit) must
 * not land on top of nodes the user placed: push them down until free.
 */
function avoidSavedNodes(
  fn: FunctionGraph,
  saved: Positions,
  out: Positions,
  sizeOf: (node: GraphNode) => Size,
  gap: number
): void {
  const unsaved = fn.nodes.filter((n) => !saved[n.id]);
  if (unsaved.length === 0 || unsaved.length === fn.nodes.length) {
    return;
  }

  interface Box {
    x: number;
    y: number;
    width: number;
    height: number;
  }

  const placed: Box[] = [];
  for (const node of fn.nodes) {
    const p = saved[node.id];
    if (p) {
      placed.push({ ...p, ...sizeOf(node) });
    }
  }

  const overlaps = (a: Box, b: Box): boolean =>
    a.x < b.x + b.width + 4 &&
    b.x < a.x + a.width + 4 &&
    a.y < b.y + b.height + 4 &&
    b.y < a.y + a.height + 4;

  for (const node of unsaved) {
    const p = out[node.id];
    if (!p) {
      continue;
    }

    const box: Box = { ...p, ...sizeOf(node) };
    for (let i = 0; i < 64; i++) {
      const hit = placed.find((other) => overlaps(box, other));
      if (!hit) {
        break;
      }

      box.y = hit.y + hit.height + gap / 2;
    }

    out[node.id] = { x: box.x, y: box.y };
    placed.push(box);
  }
}
