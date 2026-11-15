import type { LayoutPatch, Point, Positions } from '@vizscript/core';
import { isExtraLayoutKey } from '@vizscript/core';
import type { ShallowRef } from 'vue';

export interface PinnedLayout {
  /** Whether any node has a saved place (not only reroutes and colors). */
  hasPinnedNodes: () => boolean;
  /** Pins positions without an undo step (like placing new nodes). */
  movePinned: (patch: Positions) => void;
  /**
   * Saves where every node is shown, so an edit that changes the code
   * doesn't lay the graph out anew.
   */
  freezeLayout: () => void;
}

/** Node positions only (no reroutes, box colors or vias). */
export function nodePositions(all: Positions): Positions {
  return Object.fromEntries(
    Object.entries(all).filter(([key]) => !isExtraLayoutKey(key))
  );
}

export function usePinnedLayout(deps: {
  pinned: ShallowRef<Positions>;
  positions: ShallowRef<Positions>;
  /** Where the canvas has its nodes right now. */
  canvasPositions: () => Record<string, Point> | undefined;
  persist: (patch: Positions) => Promise<void>;
  applyLayoutPatch: (patch: LayoutPatch) => void;
}): PinnedLayout {
  const { pinned, positions } = deps;

  function hasPinnedNodes(): boolean {
    return Object.keys(pinned.value).some((key) => !isExtraLayoutKey(key));
  }

  function movePinned(patch: Positions): void {
    if (Object.keys(patch).length === 0) {
      return;
    }

    // The first node placed keeps the rest of the graph where it is shown
    // (else the other functions are laid out anew around a saved node).
    const full: Positions = hasPinnedNodes()
      ? patch
      : { ...nodePositions(positions.value), ...patch };
    pinned.value = { ...pinned.value, ...full };
    void deps.persist(full);
  }

  function freezeLayout(): void {
    // Also nodes the canvas doesn't draw (a Get shown as a wire from its
    // SET, an implicit `self`): unsaved, they would count as new and move
    // their function.
    const current = {
      ...nodePositions(positions.value),
      ...deps.canvasPositions(),
    };
    const freeze: LayoutPatch = {};
    for (const [id, p] of Object.entries(current)) {
      if (!pinned.value[id]) {
        freeze[id] = p;
      }
    }

    if (Object.keys(freeze).length > 0) {
      deps.applyLayoutPatch(freeze);
    }
  }

  return { hasPinnedNodes, movePinned, freezeLayout };
}
