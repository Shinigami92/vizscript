import type { LayoutPatch, Positions } from '@vizscript/core';
import type { ShallowRef } from 'vue';
import { computed, watch } from 'vue';
import type { KeyValueStorage } from '../../storage/browser-storage';
import {
  readStored,
  removeStored,
  writeStored,
} from '../../storage/browser-storage';

export interface DraftLayout {
  /**
   * The draft is discarded: the layout it started from comes back once the
   * code is the saved version again (after its parse).
   */
  discard: () => void;
  /** After each parse: applies a discard's layout when the code is back. */
  afterParse: () => void;
}

function parsePositions(data: unknown): Positions | null {
  return typeof data === 'object' && data !== null && !Array.isArray(data)
    ? (data as Positions)
    : null;
}

/** The entries that turn `from` into `to` (`null`: removed). */
export function layoutDiff(from: Positions, to: Positions): LayoutPatch {
  const patch: LayoutPatch = {};
  for (const key of Object.keys(from)) {
    if (!(key in to)) {
      patch[key] = null;
    }
  }

  for (const [key, point] of Object.entries(to)) {
    const was = from[key];
    if (!was || was.x !== point.x || was.y !== point.y) {
      patch[key] = point;
    }
  }

  return patch;
}

/**
 * The layout of a file before its draft: edits of a draft move and place
 * nodes in the stored layout right away (shared with the code's viewers),
 * so discarding the draft would leave its places behind. The layout the
 * draft started from is kept next to the draft (in the browser, it may
 * span reloads) and restored by a discard; a save or an undo back to the
 * saved code drops it.
 */
export function useDraftLayout(deps: {
  /** Storage key of the file (`stateKey`). */
  key: () => string;
  /** The saved version of the file; none: no drafts. */
  baseText: () => string | undefined;
  /** The code as edited right now. */
  text: () => string;
  /** Whether the draft has graph-only edits. */
  hasOverlay: () => boolean;
  pinned: ShallowRef<Positions>;
  /** Whether the stored layout was loaded (before, it is empty). */
  loaded: () => boolean;
  applyLayoutPatch: (patch: LayoutPatch) => void;
  storage?: KeyValueStorage;
}): DraftLayout {
  const storageKey = (): string => `vizscript:draft-layout:${deps.key()}`;
  const modified = computed(() => {
    const base = deps.baseText();
    return base !== undefined && (deps.text() !== base || deps.hasOverlay());
  });
  /** The layout while the code is the saved version. */
  let clean: Positions | null = null;
  /** A discard waiting for the saved code to be parsed. */
  let restoring: Positions | null = null;

  watch(
    () => [deps.pinned.value, deps.loaded()] as const,
    ([now, loaded]) => {
      if (!modified.value && loaded) {
        clean = now;
      }
    },
    { flush: 'sync', immediate: true }
  );

  watch(
    modified,
    (now) => {
      if (now) {
        // A draft starts: keep the layout it starts from, unless an earlier
        // visit kept it already.
        const stored = readStored(storageKey(), parsePositions, deps.storage);
        if (!stored && clean) {
          writeStored(storageKey(), clean, deps.storage);
        }
      } else if (!restoring) {
        // Saved, or undone back to the saved code: its layout is right.
        removeStored(storageKey(), deps.storage);
        clean = deps.loaded() ? deps.pinned.value : null;
      }
    },
    { flush: 'sync', immediate: true }
  );

  function apply(): void {
    const target = restoring;
    restoring = null;
    removeStored(storageKey(), deps.storage);
    if (!target) {
      return;
    }

    const patch = layoutDiff(deps.pinned.value, target);
    if (Object.keys(patch).length > 0) {
      deps.applyLayoutPatch(patch);
    }

    clean = deps.pinned.value;
  }

  return {
    discard: () => {
      restoring =
        readStored(storageKey(), parsePositions, deps.storage) ?? clean;
      // A draft of graph-only edits only: the code is parsed already.
      if (deps.text() === deps.baseText()) {
        apply();
      }
    },
    afterParse: () => {
      if (restoring && deps.text() === deps.baseText()) {
        apply();
      }
    },
  };
}
