import type { LayoutPatch, Positions } from '@vizscript/core';
import { callViewKey } from '@vizscript/core';
import type { ShallowRef } from 'vue';

export interface PlacedLayout {
  /** The graph-only edits are about to be written (`wrote`: new code). */
  writing: (wrote: boolean) => void;
  /** Floating nodes were written as code: their nodes got these ids. */
  placed: (ids: Readonly<Record<string, string>>) => void;
  /** The code was parsed (`written`: the parse of an edit's result). */
  afterParse: (written: boolean) => void;
}

/**
 * The written nodes take the places of their floating nodes, in the undo
 * step that wrote them; undo shows the floating ones where they were
 * (their own entries are kept for that). The ids are those of the written
 * code: its places are set once it is parsed, after the code's other nodes
 * took their new ids (a second `items[0]` before one renames it to `#1`,
 * which must keep its own place).
 */
export function usePlacedLayout(deps: {
  pinned: ShallowRef<Positions>;
  /** Layout changes in the undo step of the code just written. */
  recordCodeLayout: (patch: LayoutPatch) => void;
}): PlacedLayout {
  let writingCode = false;
  let pending: { moved: Positions; floating: Positions } | null = null;

  function placed(ids: Readonly<Record<string, string>>): void {
    const moved: Positions = {};
    const floating: Positions = {};
    for (const [from, to] of Object.entries(ids)) {
      const p = deps.pinned.value[from];
      if (p) {
        moved[to] = p;
        moved[from] = p;
        floating[from] = p;
      }

      // Shown as its call while floating: also once it is code.
      const view = deps.pinned.value[callViewKey(from)];
      if (view) {
        moved[callViewKey(to)] = view;
      }
    }

    if (Object.keys(moved).length === 0) {
      return;
    }

    if (writingCode) {
      pending = { moved, floating };
    } else {
      deps.recordCodeLayout(moved);
    }
  }

  function afterParse(written: boolean): void {
    if (!written || !pending) {
      return;
    }

    // The floating nodes' own places, gone with them, come back on undo.
    deps.pinned.value = { ...deps.pinned.value, ...pending.floating };
    deps.recordCodeLayout(pending.moved);
    pending = null;
  }

  return {
    writing: (wrote) => {
      writingCode = wrote;
    },
    placed,
    afterParse,
  };
}
