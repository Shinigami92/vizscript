import { edgeId } from './ids';
import type { GraphDocument, Point, Positions } from './ir';
import { renamedNodes } from './reconcile';

/**
 * Reroute (knot) points are purely visual, so they live in the same layout
 * map as node positions. Their keys are
 * `~reroute|<edgeId>|<index>` and never collide with node ids.
 */
export const REROUTE_PREFIX = '~reroute|';

/** Reroute points per edge id, in wire order (from output to input). */
export type Reroutes = Record<string, Point[]>;

/** A change of stored layout entries; `null` removes an entry. */
export type LayoutPatch = Record<string, Point | null>;

export function rerouteKey(edge: string, index: number): string {
  return `${REROUTE_PREFIX}${edge}|${index}`;
}

export function isRerouteKey(key: string): boolean {
  return key.startsWith(REROUTE_PREFIX);
}

function parseRerouteKey(
  key: string
): { edge: string; index: number } | undefined {
  if (!isRerouteKey(key)) {
    return undefined;
  }

  const separator = key.lastIndexOf('|');
  const index = Number(key.slice(separator + 1));
  if (separator <= REROUTE_PREFIX.length || !Number.isInteger(index)) {
    return undefined;
  }

  return { edge: key.slice(REROUTE_PREFIX.length, separator), index };
}

/** Collects the reroute points stored in a layout map. */
export function extractReroutes(positions: Positions): Reroutes {
  const indexed = new Map<string, Array<[number, Point]>>();
  for (const [key, point] of Object.entries(positions)) {
    const parsed = parseRerouteKey(key);
    if (!parsed) {
      continue;
    }

    const list = indexed.get(parsed.edge) ?? [];
    list.push([parsed.index, point]);
    indexed.set(parsed.edge, list);
  }

  const result: Reroutes = {};
  for (const [edge, list] of indexed) {
    result[edge] = list.toSorted((a, b) => a[0] - b[0]).map(([, p]) => p);
  }

  return result;
}

/** Only the reroute entries of a layout map. */
export function rerouteEntries(positions: Positions): Positions {
  const result: Positions = {};
  for (const [key, point] of Object.entries(positions)) {
    if (isRerouteKey(key)) {
      result[key] = point;
    }
  }

  return result;
}

/** Patch that replaces the reroute points of one edge. */
export function reroutePatch(
  edge: string,
  before: ReadonlyArray<Point>,
  after: ReadonlyArray<Point>
): LayoutPatch {
  const patch: LayoutPatch = {};
  for (const [i, point] of after.entries()) {
    patch[rerouteKey(edge, i)] = {
      x: Math.round(point.x),
      y: Math.round(point.y),
    };
  }

  for (let i = after.length; i < before.length; i++) {
    patch[rerouteKey(edge, i)] = null;
  }

  return patch;
}

/**
 * Carries reroute points over to a new parse. Edges whose nodes were matched
 * by structural path (see `reconcilePositions`) get their points moved to the
 * new edge id; points of edges that no longer exist are kept, so they come
 * back when the code does.
 */
export function reconcileReroutes(
  previous: GraphDocument | undefined,
  next: GraphDocument,
  positions: Positions
): Positions {
  const entries = rerouteEntries(positions);
  if (!previous || Object.keys(entries).length === 0) {
    return entries;
  }

  const rename = renamedNodes(previous, next);
  if (rename.size === 0) {
    return entries;
  }

  const edgeRename = new Map<string, string>();
  for (const fn of previous.functions) {
    for (const edge of fn.edges) {
      const from = rename.get(edge.from.node);
      const to = rename.get(edge.to.node);
      if (from || to) {
        edgeRename.set(
          edge.id,
          edgeId(
            { node: from ?? edge.from.node, pin: edge.from.pin },
            { node: to ?? edge.to.node, pin: edge.to.pin }
          )
        );
      }
    }
  }

  const result: Positions = {};
  for (const [key, point] of Object.entries(entries)) {
    const parsed = parseRerouteKey(key);
    const renamed = parsed ? edgeRename.get(parsed.edge) : undefined;
    result[parsed && renamed ? rerouteKey(renamed, parsed.index) : key] = point;
  }

  return result;
}

/**
 * Colors of comment boxes live in the layout too (UE keeps them in the
 * asset, not in code): `~color|<boxId>` with the palette index in `x`.
 */
export const BOX_COLOR_PREFIX = '~color|';

/** UE-like comment colors; index 0 is the default (no entry). */
export const COMMENT_BOX_COLORS: ReadonlyArray<{
  name: string;
  color: string;
}> = [
  { name: 'Gray', color: '' },
  { name: 'Red', color: '#e5484d' },
  { name: 'Orange', color: '#f76b15' },
  { name: 'Yellow', color: '#ffc53d' },
  { name: 'Green', color: '#46a758' },
  { name: 'Teal', color: '#12a594' },
  { name: 'Blue', color: '#3e63dd' },
  { name: 'Purple', color: '#8e4ec6' },
  { name: 'Pink', color: '#d6409f' },
];

export function boxColorKey(boxId: string): string {
  return `${BOX_COLOR_PREFIX}${boxId}`;
}

export function isBoxColorKey(key: string): boolean {
  return key.startsWith(BOX_COLOR_PREFIX);
}

/** Layout entries that are not node positions (reroutes, box colors). */
export function isExtraLayoutKey(key: string): boolean {
  return isRerouteKey(key) || isBoxColorKey(key);
}

/** The box color entries of a layout. */
export function boxColorEntries(positions: Positions): Positions {
  return Object.fromEntries(
    Object.entries(positions).filter(([key]) => isBoxColorKey(key))
  );
}

/** Palette index of a comment box (0: default). */
export function boxColorIndex(positions: Positions, boxId: string): number {
  const index = Math.round(positions[boxColorKey(boxId)]?.x ?? 0);
  return index > 0 && index < COMMENT_BOX_COLORS.length ? index : 0;
}
