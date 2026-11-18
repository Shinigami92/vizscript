import type { LayoutPatch, Positions } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import type { ShallowRef } from 'vue';
import { shallowRef } from 'vue';
import { usePlacedLayout } from '../src/components/script-workspace/use-placed-layout';

function setup(start: Positions): {
  pinned: ShallowRef<Positions>;
  recorded: Array<{ before: Positions; patch: LayoutPatch }>;
  placed: ReturnType<typeof usePlacedLayout>;
} {
  const pinned = shallowRef<Positions>(start);
  const recorded: Array<{ before: Positions; patch: LayoutPatch }> = [];
  const placed = usePlacedLayout({
    pinned,
    recordCodeLayout: (patch) => {
      recorded.push({ before: { ...pinned.value }, patch });
      const next: Positions = { ...pinned.value };
      for (const [key, point] of Object.entries(patch)) {
        if (point) {
          next[key] = point;
        }
      }

      pinned.value = next;
    },
  });
  return { pinned, recorded, placed };
}

describe('places of floating nodes written as code', () => {
  it('are set after the parse renamed the code it was written before', () => {
    const { pinned, recorded, placed } = setup({
      'get#0': { x: 500, y: 300 },
      'overlay:a/get': { x: 30, y: 100 },
    });
    placed.writing(true);
    // The written `items[0]` comes first: it is `get#0` in the new code.
    placed.placed({ 'overlay:a/get': 'get#0' });
    expect(recorded).toEqual([]);

    // The parse moved the old `get#0` to `get#1` (and dropped the floating).
    pinned.value = { 'get#1': { x: 500, y: 300 } };
    placed.afterParse(true);
    expect(pinned.value).toEqual({
      'get#0': { x: 30, y: 100 },
      'get#1': { x: 500, y: 300 },
      'overlay:a/get': { x: 30, y: 100 },
    });
    // Undo puts the floating node back where it was.
    expect(recorded[0]?.before['overlay:a/get']).toEqual({ x: 30, y: 100 });
  });

  it('are set at once when no code is written', () => {
    const { pinned, placed } = setup({ 'overlay:a/get': { x: 30, y: 100 } });
    placed.writing(false);
    placed.placed({ 'overlay:a/get': 'get#0' });
    expect(pinned.value['get#0']).toEqual({ x: 30, y: 100 });
  });
});
