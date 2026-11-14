import type {
  GraphOverlay,
  LayoutPatch,
  Point,
  Positions,
} from '@vizscript/core';
import { boxColorIndex, boxColorKey, isExtraLayoutKey } from '@vizscript/core';
import { useDebounceFn } from '@vueuse/core';
import type { ComputedRef, Ref, ShallowRef } from 'vue';
import { computed, ref, shallowRef } from 'vue';
import type { LayoutStore } from '../../graph/layout-store';

/**
 * One undo step: a layout change, or a change of the graph-only edits
 * (`code`: it also wrote code, undone together with it).
 */
type HistoryStep =
  | {
      kind: 'layout';
      before: LayoutPatch;
      after: LayoutPatch;
      codeVersion: number;
      /** Made by a graph edit that wrote code: undone together with it. */
      code?: boolean;
      /** Version of the code before that edit (for redo). */
      beforeVersion?: number;
    }
  | {
      kind: 'overlay';
      before: GraphOverlay;
      after: GraphOverlay;
      codeVersion: number;
      code?: boolean;
      /** Version of the code before the step wrote code (for redo). */
      beforeVersion?: number;
      /** Layout entries made with the code it wrote (Gets kept as nodes). */
      layout?: { before: LayoutPatch; after: LayoutPatch };
    };

export interface EditorHistory {
  canUndo: boolean;
  canRedo: boolean;
  version: number;
}

export interface LayoutHistoryDeps {
  layoutStore: () => LayoutStore | null;
  /** Positions stored by the user (or server). */
  pinned: ShallowRef<Positions>;
  /** Positions the graph shows (pinned and auto-laid). */
  positions: ShallowRef<Positions>;
  relayout: () => void;
  /** Where the canvas has its nodes right now. */
  currentPositions: () => Positions | undefined;
  undoCode: () => void;
  redoCode: () => void;
  /** Restores graph-only edits (undo / redo). */
  setOverlay: (overlay: GraphOverlay) => void;
  show: (message: string, kind?: 'info' | 'error') => void;
}

export interface LayoutHistory {
  saving: Ref<'idle' | 'saving' | 'saved' | 'error'>;
  /** Undo / redo state of the code editor. */
  codeHistory: Ref<EditorHistory>;
  canUndo: ComputedRef<boolean>;
  canRedo: ComputedRef<boolean>;
  persist: (patch: Record<string, Point | null>) => Promise<void>;
  applyLayoutPatch: (patch: LayoutPatch) => void;
  undo: () => void;
  redo: () => void;
  /** A change of the graph-only edits, as an undo step. */
  recordOverlay: (before: GraphOverlay, after: GraphOverlay) => void;
  /** A graph edit that writes code starts (its code version). */
  beforeCodeEdit: () => void;
  /**
   * Layout entries the last graph edit made with its code (a Get drawn as
   * a wire): one undo for both.
   */
  recordCodeLayout: (after: LayoutPatch) => void;
  /** The code was parsed (a redone edit gets its layout entries back). */
  parsed: () => void;
  /**
   * The last overlay step also wrote code (synced): one undo for both. Call
   * after the editor reported the new version.
   */
  recordOverlayCode: () => void;
  onLayoutChange: (patch: LayoutPatch) => void;
  /** Colors of comment boxes are layout entries, undone like moves. */
  boxColorOf: (boxId: string) => number;
  setBoxColor: (boxId: string, index: number) => void;
  resetLayout: (ids: ReadonlyArray<string>) => void;
  resetAllLayout: () => void;
}

/**
 * Saving the layout and undo / redo.
 *
 * Code edits live in Monaco's undo stack. Layout changes (moves, reroutes,
 * resets) get their own stack; each step remembers the code version it was
 * made at, so undo/redo replay both in the order they happened.
 */
export function useLayoutHistory(deps: LayoutHistoryDeps): LayoutHistory {
  const { pinned, show } = deps;
  const saving = ref<'idle' | 'saving' | 'saved' | 'error'>('idle');

  // ----------------------------------------------------------- persistence

  let pendingPatch: Record<string, Point | null> = {};
  const flush = useDebounceFn(async () => {
    const patch = pendingPatch;
    pendingPatch = {};
    const store = deps.layoutStore();
    if (!store || Object.keys(patch).length === 0) {
      return;
    }

    saving.value = 'saving';
    try {
      await store.save(patch);
      saving.value = 'saved';
    } catch (error) {
      saving.value = 'error';
      show(`Saving the layout failed: ${(error as Error).message}`, 'error');
    }
  }, 600);

  function persist(patch: Record<string, Point | null>): Promise<void> {
    Object.assign(pendingPatch, patch);
    return flush();
  }

  function applyLayoutPatch(patch: LayoutPatch): void {
    const next = { ...pinned.value };
    for (const [key, value] of Object.entries(patch)) {
      if (value) {
        next[key] = value;
      } else {
        delete next[key];
      }
    }

    pinned.value = next;
    deps.relayout();
    void persist(patch);
  }

  // --------------------------------------------------------------- history

  const codeHistory = ref<EditorHistory>({
    canUndo: false,
    canRedo: false,
    version: 0,
  });
  const undoStack = shallowRef<HistoryStep[]>([]);
  const redoStack = shallowRef<HistoryStep[]>([]);
  const canUndo = computed(
    () => undoStack.value.length > 0 || codeHistory.value.canUndo
  );
  const canRedo = computed(
    () => redoStack.value.length > 0 || codeHistory.value.canRedo
  );

  function recordLayout(after: LayoutPatch): void {
    const before: LayoutPatch = {};
    for (const key of Object.keys(after)) {
      before[key] = pinned.value[key] ?? null;
    }

    undoStack.value = [
      ...undoStack.value.slice(-199),
      { kind: 'layout', before, after, codeVersion: codeHistory.value.version },
    ];
    redoStack.value = [];
    applyLayoutPatch(after);
  }

  let editVersion = 0;
  function beforeCodeEdit(): void {
    editVersion = codeHistory.value.version;
  }

  function recordCodeLayout(after: LayoutPatch): void {
    const before: LayoutPatch = {};
    for (const key of Object.keys(after)) {
      before[key] = pinned.value[key] ?? null;
    }

    // Graph-only edits that just wrote this code: the same undo step.
    const top = undoStack.value.at(-1);
    if (
      top?.kind === 'overlay' &&
      (!top.code || top.codeVersion === codeHistory.value.version)
    ) {
      undoStack.value = [
        ...undoStack.value.slice(0, -1),
        {
          ...top,
          layout: {
            before: { ...before, ...top.layout?.before },
            after: { ...top.layout?.after, ...after },
          },
        },
      ];
      applyLayoutPatch(after);
      return;
    }

    undoStack.value = [
      ...undoStack.value.slice(-199),
      {
        kind: 'layout',
        before,
        after,
        codeVersion: codeHistory.value.version,
        code: true,
        beforeVersion: editVersion,
      },
    ];
    redoStack.value = [];
    applyLayoutPatch(after);
  }

  /** Applied once the redone code is parsed (its ids exist again). */
  let afterParse: LayoutPatch | null = null;
  function parsed(): void {
    const patch = afterParse;
    afterParse = null;
    if (patch) {
      applyLayoutPatch(patch);
    }
  }

  function recordOverlay(before: GraphOverlay, after: GraphOverlay): void {
    undoStack.value = [
      ...undoStack.value.slice(-199),
      {
        kind: 'overlay',
        before,
        after,
        codeVersion: codeHistory.value.version,
      },
    ];
    redoStack.value = [];
  }

  function recordOverlayCode(): void {
    const step = undoStack.value.at(-1);
    if (step?.kind === 'overlay') {
      undoStack.value = [
        ...undoStack.value.slice(0, -1),
        {
          ...step,
          after: { edits: [] },
          code: true,
          beforeVersion: step.codeVersion,
          codeVersion: codeHistory.value.version,
        },
      ];
    }
  }

  function undo(): void {
    const step = undoStack.value.at(-1);
    if (
      step &&
      (step.codeVersion === codeHistory.value.version ||
        !codeHistory.value.canUndo)
    ) {
      undoStack.value = undoStack.value.slice(0, -1);
      redoStack.value = [...redoStack.value, step];
      if (step.kind === 'layout') {
        applyLayoutPatch(step.before);
        if (step.code) {
          deps.undoCode();
        }
      } else {
        if (step.layout) {
          applyLayoutPatch(step.layout.before);
        }

        if (step.code) {
          deps.undoCode();
        }

        deps.setOverlay(step.before);
      }

      return;
    }

    deps.undoCode();
  }

  function redo(): void {
    const step = redoStack.value.at(-1);
    // A step that wrote code is redone from the code as it was before.
    const version = step?.code ? step.beforeVersion : step?.codeVersion;
    if (
      step &&
      (version === codeHistory.value.version || !codeHistory.value.canRedo)
    ) {
      redoStack.value = redoStack.value.slice(0, -1);
      undoStack.value = [...undoStack.value, step];
      if (step.kind === 'layout' && step.code) {
        afterParse = step.after;
        deps.redoCode();
      } else if (step.kind === 'layout') {
        applyLayoutPatch(step.after);
      } else {
        if (step.code) {
          afterParse = step.layout?.after ?? null;
          deps.redoCode();
        }

        deps.setOverlay(step.after);
      }

      return;
    }

    deps.redoCode();
  }

  function onLayoutChange(patch: LayoutPatch): void {
    // The first move freezes the current auto layout so nothing jumps around
    // after a reload; afterwards only moved nodes are sent.
    const full: LayoutPatch = { ...patch };
    const moved = Object.keys(patch).filter((key) => !isExtraLayoutKey(key));
    if (moved.length > 0) {
      // All shown nodes keep their place, also those the canvas doesn't
      // draw (a Get shown as a wire from its SET): unsaved, they would
      // count as new and move their function.
      const current = {
        ...deps.positions.value,
        ...deps.currentPositions(),
      };
      for (const [id, p] of Object.entries(current)) {
        if (!pinned.value[id] && !(id in full) && !isExtraLayoutKey(id)) {
          full[id] = p;
        }
      }
    }

    recordLayout(full);
  }

  function boxColorOf(boxId: string): number {
    return boxColorIndex(pinned.value, boxId);
  }

  function setBoxColor(boxId: string, index: number): void {
    recordLayout({
      [boxColorKey(boxId)]: index > 0 ? { x: index, y: 0 } : null,
    });
  }

  function resetLayout(ids: ReadonlyArray<string>): void {
    const patch: LayoutPatch = {};
    for (const id of ids) {
      if (pinned.value[id]) {
        patch[id] = null;
      }
    }

    if (Object.keys(patch).length === 0) {
      show('These nodes already use the automatic layout.');
      return;
    }

    recordLayout(patch);
  }

  function resetAllLayout(): void {
    const keys = Object.keys(pinned.value);
    if (keys.length === 0) {
      show('This file already uses the automatic layout.');
      return;
    }

    recordLayout(Object.fromEntries(keys.map((key) => [key, null])));
    show('Layout reset. Undo restores it.');
  }

  return {
    saving,
    codeHistory,
    canUndo,
    canRedo,
    persist,
    applyLayoutPatch,
    undo,
    redo,
    recordOverlay,
    beforeCodeEdit,
    recordCodeLayout,
    parsed,
    recordOverlayCode,
    onLayoutChange,
    boxColorOf,
    setBoxColor,
    resetLayout,
    resetAllLayout,
  };
}
