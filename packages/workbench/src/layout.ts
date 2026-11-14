/**
 * Workbench layout model, inspired by VS Code: views (file explorer, code,
 * graph, details) live in zones around the main area and can be moved,
 * hidden, resized and shown as tabs or side by side.
 *
 * Everything here is pure data + pure functions, so the layout can be stored
 * per user (as JSON) and validated when it is loaded again.
 */

export const VIEW_IDS = [
  'explorer',
  'script',
  'code',
  'graph',
  'preview',
  'details',
  'problems',
] as const;
export type ViewId = (typeof VIEW_IDS)[number];

export const ZONE_IDS = ['left', 'center', 'right', 'bottom'] as const;
export type ZoneId = (typeof ZONE_IDS)[number];

export interface ZoneState {
  /** Views in this zone, in tab / split order. */
  views: ViewId[];
  /** Visible tab when the zone shows tabs. */
  active: ViewId | null;
  /**
   * Show all views at once instead of as tabs: side by side in the main
   * area, stacked in the sidebars and the bottom panel.
   */
  split: boolean;
  /** Width (left/right) or height (bottom) in px; unused for `center`. */
  size: number;
  /** Relative sizes of split views. */
  weights: Partial<Record<ViewId, number>>;
}

export interface WorkbenchLayout {
  version: 1;
  zones: Record<ZoneId, ZoneState>;
  /** Hidden views keep their zone, so showing them restores the place. */
  hidden: ViewId[];
}

export const VIEW_TITLES: Record<ViewId, string> = {
  explorer: 'Explorer',
  script: 'My Script',
  code: 'Code',
  graph: 'Graph',
  preview: 'Preview',
  details: 'Details',
  problems: 'Problems',
};

/**
 * Views that start hidden (also when an older stored layout does not know
 * them yet), like VS Code's panels.
 */
export const HIDDEN_BY_DEFAULT: ReadonlyArray<ViewId> = ['problems'];

export const SIZE_LIMITS: Record<
  Exclude<ZoneId, 'center'>,
  { min: number; max: number; initial: number }
> = {
  left: { min: 160, max: 720, initial: 288 },
  right: { min: 200, max: 720, initial: 304 },
  bottom: { min: 100, max: 1200, initial: 280 },
};

const WEIGHT_MIN = 0.1;
const WEIGHT_MAX = 10;

function zone(
  views: ViewId[],
  options: Partial<Omit<ZoneState, 'views'>> = {}
): ZoneState {
  return {
    views,
    active: options.active ?? views[0] ?? null,
    split: options.split ?? false,
    size: options.size ?? 0,
    weights: options.weights ?? {},
  };
}

function layout(
  zones: Partial<Record<ZoneId, ZoneState>>,
  hidden: ViewId[] = []
): WorkbenchLayout {
  const bottom = zones.bottom ?? zone([], { size: SIZE_LIMITS.bottom.initial });
  return normalizeLayout({
    version: 1,
    zones: {
      left: zones.left ?? zone([], { size: SIZE_LIMITS.left.initial }),
      center: zones.center ?? zone([], { split: true }),
      right: zones.right ?? zone([], { size: SIZE_LIMITS.right.initial }),
      // The problems panel lives in the bottom panel, behind other views.
      bottom: bottom.views.includes('problems')
        ? bottom
        : { ...bottom, views: [...bottom.views, 'problems'] },
    },
    hidden: [
      ...hidden,
      ...HIDDEN_BY_DEFAULT.filter((v) => !hidden.includes(v)),
    ],
  });
}

/** "My Script" stacked above the explorer. */
function sidebar(): ZoneState {
  return zone(['script', 'explorer'], {
    size: SIZE_LIMITS.left.initial,
    split: true,
    weights: { explorer: 0.5, script: 0.5 },
  });
}

export interface LayoutPreset {
  id: string;
  name: string;
  description: string;
  create: () => WorkbenchLayout;
}

/**
 * Graph in the main area, code in the bottom panel below it, and the
 * problems (when shown) below the code.
 */
function graphAboveCode(): Pick<
  Record<ZoneId, ZoneState>,
  'center' | 'bottom'
> {
  return {
    center: zone(['graph', 'preview'], { split: true }),
    bottom: zone(['code', 'problems'], {
      size: SIZE_LIMITS.bottom.initial,
      split: true,
      weights: { code: 0.65, problems: 0.35 },
    }),
  };
}

export const PRESETS: ReadonlyArray<LayoutPreset> = [
  {
    id: 'default',
    name: 'Default',
    description: 'Explorer left, graph above code, details right',
    create: () =>
      layout({
        left: sidebar(),
        ...graphAboveCode(),
        right: zone(['details'], { size: SIZE_LIMITS.right.initial }),
      }),
  },
  {
    id: 'side-by-side',
    name: 'Side by side',
    description: 'Code and graph next to each other',
    create: () =>
      layout({
        left: sidebar(),
        center: zone(['code', 'graph', 'preview'], {
          split: true,
          weights: { code: 0.42, graph: 0.58, preview: 0.58 },
        }),
        right: zone(['details'], { size: SIZE_LIMITS.right.initial }),
      }),
  },
  {
    id: 'mirrored',
    name: 'Explorer on the right',
    description: 'Details left, explorer right',
    create: () =>
      layout({
        left: zone(['details'], { size: SIZE_LIMITS.right.initial }),
        ...graphAboveCode(),
        right: sidebar(),
      }),
  },
  {
    id: 'single-sidebar',
    name: 'One sidebar',
    description: 'Explorer and details as tabs in the left sidebar',
    create: () =>
      layout({
        left: zone(['script', 'explorer', 'details'], {
          active: 'explorer',
          size: SIZE_LIMITS.right.initial,
        }),
        center: zone(['code', 'graph', 'preview'], {
          split: true,
          weights: { code: 0.42, graph: 0.58, preview: 0.58 },
        }),
      }),
  },
  {
    id: 'code-focus',
    name: 'Code focus',
    description: 'Code in the main area, graph in the bottom panel',
    create: () =>
      layout({
        left: sidebar(),
        center: zone(['code'], { split: true }),
        right: zone(['details'], { size: SIZE_LIMITS.right.initial }),
        bottom: zone(['graph', 'preview'], { size: 360, split: true }),
      }),
  },
  {
    id: 'graph-only',
    name: 'Graph only',
    description: 'Only the graph; everything else hidden',
    create: () =>
      layout(
        {
          left: sidebar(),
          center: zone(['graph', 'preview', 'code'], { split: true }),
          right: zone(['details'], { size: SIZE_LIMITS.right.initial }),
        },
        ['explorer', 'script', 'code', 'details']
      ),
  },
];

export function defaultLayout(): WorkbenchLayout {
  return (PRESETS[0] as LayoutPreset).create();
}

export function presetLayout(id: string): WorkbenchLayout | undefined {
  return PRESETS.find((p) => p.id === id)?.create();
}

/** Id of the preset equal to `layout` (ignoring sizes), if any. */
export function matchingPreset(current: WorkbenchLayout): string | undefined {
  const shape = (l: WorkbenchLayout): string =>
    JSON.stringify({
      zones: ZONE_IDS.map((z) => [z, l.zones[z].views, l.zones[z].split]),
      hidden: [...l.hidden].toSorted(),
    });
  const target = shape(current);
  return PRESETS.find((p) => shape(p.create()) === target)?.id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isViewId(value: unknown): value is ViewId {
  return (VIEW_IDS as ReadonlyArray<unknown>).includes(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Turns any (stored, possibly outdated or tampered) value into a valid
 * layout: every view appears in exactly one zone, sizes are clamped, and
 * unknown data is dropped. Missing views go to their default zone.
 */
export function normalizeLayout(input: unknown): WorkbenchLayout {
  const source = isRecord(input) ? input : {};
  const zonesIn = isRecord(source.zones) ? source.zones : {};
  const seen = new Set<ViewId>();
  const zones = {} as Record<ZoneId, ZoneState>;

  for (const id of ZONE_IDS) {
    const raw = isRecord(zonesIn[id]) ? zonesIn[id] : {};
    const views: ViewId[] = [];
    for (const view of Array.isArray(raw.views) ? raw.views : []) {
      if (isViewId(view) && !seen.has(view)) {
        seen.add(view);
        views.push(view);
      }
    }

    const weights: Partial<Record<ViewId, number>> = {};
    if (isRecord(raw.weights)) {
      for (const view of views) {
        const weight = raw.weights[view];
        if (typeof weight === 'number' && Number.isFinite(weight)) {
          weights[view] = clamp(weight, WEIGHT_MIN, WEIGHT_MAX);
        }
      }
    }

    const limits = id === 'center' ? undefined : SIZE_LIMITS[id];
    const size =
      typeof raw.size === 'number' && Number.isFinite(raw.size)
        ? raw.size
        : (limits?.initial ?? 0);
    zones[id] = {
      views,
      active:
        isViewId(raw.active) && views.includes(raw.active)
          ? raw.active
          : (views[0] ?? null),
      split: typeof raw.split === 'boolean' ? raw.split : id === 'center',
      size: limits ? Math.round(clamp(size, limits.min, limits.max)) : 0,
      weights,
    };
  }

  // Views missing from the stored layout go where the default puts them.
  const fallback: Record<ViewId, ZoneId> = {
    explorer: 'left',
    script: 'left',
    code: 'center',
    graph: 'center',
    preview: 'center',
    details: 'right',
    problems: 'bottom',
  };
  const hidden = (Array.isArray(source.hidden) ? source.hidden : []).filter(
    (v, i, all): v is ViewId => isViewId(v) && all.indexOf(v) === i
  );
  for (const view of VIEW_IDS) {
    if (!seen.has(view)) {
      const target = zones[fallback[view]];
      // A new sidebar view is stacked with a single one instead of hiding
      // behind it as a tab; "My Script" goes above the explorer.
      if (fallback[view] !== 'center' && target.views.length === 1) {
        target.split = true;
      }

      const explorer = target.views.indexOf('explorer');
      if (view === 'script' && explorer !== -1) {
        target.views.splice(explorer, 0, view);
      } else {
        target.views.push(view);
      }
      if (HIDDEN_BY_DEFAULT.includes(view)) {
        if (!hidden.includes(view)) {
          hidden.push(view);
        }
      } else {
        target.active ??= view;
      }
    }
  }

  return { version: 1, zones, hidden };
}

function clone(l: WorkbenchLayout): WorkbenchLayout {
  return structuredClone(l);
}

export function zoneOf(l: WorkbenchLayout, view: ViewId): ZoneId {
  return ZONE_IDS.find((z) => l.zones[z].views.includes(view)) ?? 'center';
}

/** Moves a view to a zone (at `index`, default: the end) and shows it. */
export function moveView(
  l: WorkbenchLayout,
  view: ViewId,
  target: ZoneId,
  index?: number
): WorkbenchLayout {
  const next = clone(l);
  const from = next.zones[zoneOf(next, view)];
  const fromIndex = from.views.indexOf(view);
  from.views.splice(fromIndex, 1);
  if (from.active === view) {
    from.active = from.views[Math.max(0, fromIndex - 1)] ?? null;
  }

  const to = next.zones[target];
  const at = clamp(index ?? to.views.length, 0, to.views.length);
  to.views.splice(at, 0, view);
  to.active = view;
  next.hidden = next.hidden.filter((v) => v !== view);
  return next;
}

export function setViewHidden(
  l: WorkbenchLayout,
  view: ViewId,
  hidden: boolean
): WorkbenchLayout {
  const next = clone(l);
  next.hidden = next.hidden.filter((v) => v !== view);
  if (hidden) {
    next.hidden.push(view);
  } else {
    next.zones[zoneOf(next, view)].active = view;
  }

  return next;
}

export function setActiveView(
  l: WorkbenchLayout,
  view: ViewId
): WorkbenchLayout {
  const next = clone(l);
  next.zones[zoneOf(next, view)].active = view;
  return next;
}

export function setZoneSize(
  l: WorkbenchLayout,
  zoneId: Exclude<ZoneId, 'center'>,
  size: number
): WorkbenchLayout {
  const next = clone(l);
  const limits = SIZE_LIMITS[zoneId];
  next.zones[zoneId].size = Math.round(clamp(size, limits.min, limits.max));
  return next;
}

export function setZoneSplit(
  l: WorkbenchLayout,
  zoneId: ZoneId,
  split: boolean
): WorkbenchLayout {
  const next = clone(l);
  next.zones[zoneId].split = split;
  return next;
}

export function setWeights(
  l: WorkbenchLayout,
  zoneId: ZoneId,
  weights: Partial<Record<ViewId, number>>
): WorkbenchLayout {
  const next = clone(l);
  for (const [view, weight] of Object.entries(weights)) {
    if (isViewId(view) && typeof weight === 'number') {
      next.zones[zoneId].weights[view] = clamp(weight, WEIGHT_MIN, WEIGHT_MAX);
    }
  }

  return next;
}

/**
 * Views of a zone that are actually shown: not hidden and offered by the
 * current page (e.g. the playground has no explorer).
 */
export function shownViews(
  l: WorkbenchLayout,
  zoneId: ZoneId,
  available: ReadonlySet<ViewId>
): ViewId[] {
  return l.zones[zoneId].views.filter(
    (v) => available.has(v) && !l.hidden.includes(v)
  );
}

/** The view visible in a tabbed zone (falls back to the first shown one). */
export function activeView(
  l: WorkbenchLayout,
  zoneId: ZoneId,
  available: ReadonlySet<ViewId>
): ViewId | null {
  const views = shownViews(l, zoneId, available);
  const active = l.zones[zoneId].active;
  return active && views.includes(active) ? active : (views[0] ?? null);
}

/** Whether a view is on screen (not hidden and not a background tab). */
export function isViewVisible(
  l: WorkbenchLayout,
  view: ViewId,
  available: ReadonlySet<ViewId>
): boolean {
  if (!available.has(view) || l.hidden.includes(view)) {
    return false;
  }

  const zoneId = zoneOf(l, view);
  return (
    l.zones[zoneId].split ||
    shownViews(l, zoneId, available).length === 1 ||
    activeView(l, zoneId, available) === view
  );
}
