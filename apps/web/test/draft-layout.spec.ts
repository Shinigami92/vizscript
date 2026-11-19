import type { LayoutPatch, Positions } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { effectScope, ref, shallowRef } from 'vue';
import {
  layoutDiff,
  useDraftLayout,
} from '../src/components/script-workspace/use-draft-layout';

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    key: (index) => [...data.keys()][index] ?? null,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

const BASE = 'const a = 1;\n';

/** A workspace in miniature: its code, layout and draft layout. */
function setup(storage = memoryStorage(), text = BASE) {
  const code = ref(text);
  const pinned = shallowRef<Positions>({});
  const loaded = ref(false);
  const draft = effectScope().run(() =>
    useDraftLayout({
      key: () => 'repo:a.ts',
      baseText: () => BASE,
      text: () => code.value,
      hasOverlay: () => false,
      pinned,
      loaded: () => loaded.value,
      applyLayoutPatch: (patch: LayoutPatch) => {
        const next = { ...pinned.value };
        for (const [key, point] of Object.entries(patch)) {
          if (point) {
            next[key] = point;
          } else {
            delete next[key];
          }
        }

        pinned.value = next;
      },
      storage,
    })
  );
  if (!draft) {
    throw new Error('no scope');
  }

  /** The layout store loads `layout`. */
  const load = (layout: Positions): void => {
    pinned.value = layout;
    loaded.value = true;
  };
  return { code, pinned, draft, load, storage };
}

describe('the layout of a draft', () => {
  it('goes back to where the draft started when it is discarded', () => {
    const { code, pinned, draft, load } = setup();
    load({ a: { x: 0, y: 0 } });
    code.value = 'const a = 2;\n';
    // The draft moves a node and places a new one.
    pinned.value = { a: { x: 50, y: 0 }, b: { x: 100, y: 0 } };
    draft.discard();
    // Nothing yet: the saved code isn't parsed.
    expect(pinned.value.b).toBeDefined();
    code.value = BASE;
    draft.afterParse();
    expect(pinned.value).toEqual({ a: { x: 0, y: 0 } });
  });

  it('keeps it across a reload of the draft', () => {
    const first = setup();
    first.load({ a: { x: 0, y: 0 } });
    first.code.value = 'const a = 2;\n';
    first.pinned.value = { a: { x: 50, y: 0 } };
    // Opened again with the draft, the layout as the draft left it.
    const again = setup(first.storage, 'const a = 2;\n');
    again.load({ a: { x: 50, y: 0 } });
    again.draft.discard();
    again.code.value = BASE;
    again.draft.afterParse();
    expect(again.pinned.value).toEqual({ a: { x: 0, y: 0 } });
  });

  it('forgets it once the code is the saved version again', () => {
    const { code, pinned, draft, load, storage } = setup();
    load({ a: { x: 0, y: 0 } });
    code.value = 'const a = 2;\n';
    expect(storage.length).toBe(1);
    // Undone back to the saved code, then moved: that's the layout now.
    code.value = BASE;
    expect(storage.length).toBe(0);
    pinned.value = { a: { x: 9, y: 9 } };
    code.value = 'const a = 3;\n';
    pinned.value = { a: { x: 50, y: 0 } };
    draft.discard();
    code.value = BASE;
    draft.afterParse();
    expect(pinned.value).toEqual({ a: { x: 9, y: 9 } });
  });

  it('lists what changes between two layouts', () => {
    expect(
      layoutDiff(
        { a: { x: 0, y: 0 }, b: { x: 1, y: 1 } },
        { a: { x: 0, y: 0 }, c: { x: 2, y: 2 } }
      )
    ).toEqual({ b: null, c: { x: 2, y: 2 } });
  });
});
