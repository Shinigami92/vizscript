import { describe, expect, it } from 'vitest';
import type { ViewId } from '../src';
import {
  defaultLayout,
  isViewVisible,
  matchingPreset,
  moveView,
  normalizeLayout,
  PRESETS,
  setViewHidden,
  setZoneSize,
  shownViews,
  VIEW_IDS,
  ZONE_IDS,
} from '../src';

const all = new Set<ViewId>(VIEW_IDS);

function placement(
  l: ReturnType<typeof defaultLayout>
): Record<string, string[]> {
  return Object.fromEntries(ZONE_IDS.map((z) => [z, l.zones[z].views]));
}

describe('normalizeLayout', () => {
  it('repairs garbage into a complete layout', () => {
    const l = normalizeLayout({
      zones: {
        left: { views: ['code', 'code', 'nope'], size: 99_999 },
        right: 'broken',
      },
      hidden: ['graph', 'graph', 42],
    });
    expect(l.zones.left.views).toEqual(['code', 'script', 'explorer']);
    expect(l.zones.left.size).toBe(720);
    expect(l.hidden).toEqual(['graph', 'problems']);
    // Every view exactly once.
    const views = ZONE_IDS.flatMap((z) => l.zones[z].views).toSorted();
    expect(views).toEqual([...VIEW_IDS].toSorted());
  });

  it('adds the problems panel to older layouts hidden in the bottom', () => {
    const old = normalizeLayout({
      zones: {
        left: { views: ['explorer'] },
        center: { views: ['code', 'graph', 'preview'], split: true },
        right: { views: ['details'] },
        bottom: { views: [] },
      },
      hidden: [],
    });
    expect(old.zones.bottom.views).toEqual(['problems']);
    expect(old.hidden).toEqual(['problems']);
    expect(isViewVisible(old, 'problems', all)).toBe(false);
  });

  it('stacks "My Script" above the explorer of older layouts', () => {
    const old = normalizeLayout({
      zones: {
        left: { views: ['explorer'] },
        center: { views: ['code', 'graph', 'preview'], split: true },
        right: { views: ['details'] },
        bottom: { views: ['problems'] },
      },
      hidden: ['problems'],
    });
    expect(old.zones.left.views).toEqual(['script', 'explorer']);
    expect(old.zones.left.split).toBe(true);
    expect(isViewVisible(old, 'explorer', all)).toBe(true);
    expect(isViewVisible(old, 'script', all)).toBe(true);
  });

  it('keeps every preset valid', () => {
    for (const preset of PRESETS) {
      const l = preset.create();
      expect(normalizeLayout(JSON.parse(JSON.stringify(l)))).toEqual(l);
      expect(matchingPreset(l)).toBe(preset.id);
    }
  });
});

describe('layout operations', () => {
  it('moves a view to another zone and shows it', () => {
    let l = setViewHidden(defaultLayout(), 'explorer', true);
    l = moveView(l, 'explorer', 'right', 0);
    expect(placement(l)).toMatchObject({
      left: ['script'],
      right: ['explorer', 'details'],
    });
    expect(l.hidden).not.toContain('explorer');
    expect(l.zones.right.active).toBe('explorer');
    expect(matchingPreset(l)).toBeUndefined();
  });

  it('reorders inside a zone', () => {
    const l = moveView(defaultLayout(), 'preview', 'center', 0);
    expect(l.zones.center.views).toEqual(['preview', 'graph']);
  });

  it('tracks which views are visible', () => {
    const tabs = PRESETS.find((p) => p.id === 'single-sidebar')?.create();
    let l = moveView(tabs ?? defaultLayout(), 'details', 'left');
    expect(l.zones.left.split).toBe(false);
    expect(isViewVisible(l, 'details', all)).toBe(true);
    expect(isViewVisible(l, 'explorer', all)).toBe(false);
    // Without an explorer the details tab is the only one.
    const noExplorer = new Set<ViewId>(['code', 'graph', 'details']);
    l = moveView(l, 'explorer', 'left', 0);
    expect(shownViews(l, 'left', noExplorer)).toEqual(['details']);
    expect(isViewVisible(l, 'details', noExplorer)).toBe(true);
  });

  it('clamps zone sizes', () => {
    expect(setZoneSize(defaultLayout(), 'left', 10).zones.left.size).toBe(160);
  });
});
