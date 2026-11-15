import type { GraphOverlay, Positions } from '@vizscript/core';
import { EMPTY_OVERLAY } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import type { ShallowRef } from 'vue';
import { shallowRef } from 'vue';
import { useLayoutHistory } from '../src/components/script-workspace/use-layout-history';

const GROUP: GraphOverlay = {
  edits: [
    {
      type: 'addNodes',
      id: 'g',
      fnId: 'fn:f',
      code: 'x',
      nodes: [],
      edges: [],
    },
  ],
};

/** The history with an editor whose code edits it counts. */
function setup(): {
  history: ReturnType<typeof useLayoutHistory>;
  pinned: ShallowRef<Positions>;
  overlay: () => GraphOverlay;
  calls: string[];
  editCode: () => void;
} {
  const pinned = shallowRef<Positions>({});
  const calls: string[] = [];
  let overlay = EMPTY_OVERLAY;
  const history = useLayoutHistory({
    layoutStore: () => null,
    pinned,
    positions: shallowRef<Positions>({}),
    relayout: () => undefined,
    currentPositions: () => undefined,
    undoCode: () => {
      calls.push('undoCode');
      const { version } = history.codeHistory.value;
      history.codeHistory.value = {
        canUndo: false,
        canRedo: true,
        version: version - 1,
      };
    },
    redoCode: () => {
      calls.push('redoCode');
      const { version } = history.codeHistory.value;
      history.codeHistory.value = {
        canUndo: true,
        canRedo: false,
        version: version + 1,
      };
    },
    setOverlay: (next) => {
      overlay = next;
    },
    show: () => undefined,
  });
  const editCode = (): void => {
    const { version } = history.codeHistory.value;
    history.codeHistory.value = {
      canUndo: true,
      canRedo: false,
      version: version + 1,
    };
  };
  return { history, pinned, overlay: () => overlay, calls, editCode };
}

describe('undo of graph-only edits', () => {
  it('undoes and redoes a graph-only change without the code', () => {
    const { history, overlay, calls } = setup();
    history.recordOverlay(EMPTY_OVERLAY, GROUP);
    history.undo();
    expect(overlay()).toEqual(EMPTY_OVERLAY);
    history.redo();
    expect(overlay()).toEqual(GROUP);
    expect(calls).toEqual([]);
  });
});

describe('undo of nodes an edit left graph-only', () => {
  it('undoes the code edit, the loose nodes and their places as one step', () => {
    const { history, pinned, overlay, calls, editCode } = setup();
    history.beforeCodeEdit();
    editCode();
    history.recordCodeOverlay(EMPTY_OVERLAY, GROUP, {
      'overlay:g/n': { x: 10, y: 20 },
    });
    expect(pinned.value['overlay:g/n']).toEqual({ x: 10, y: 20 });

    history.undo();
    expect(calls).toEqual(['undoCode']);
    expect(overlay()).toEqual(EMPTY_OVERLAY);
    expect(pinned.value['overlay:g/n']).toBeUndefined();

    // Redone: the places come back once the redone code is parsed.
    history.redo();
    expect(calls).toEqual(['undoCode', 'redoCode']);
    expect(overlay()).toEqual(GROUP);
    history.parsed();
    expect(pinned.value['overlay:g/n']).toEqual({ x: 10, y: 20 });
  });

  it('takes the layout entries the same edit made into its step', () => {
    const { history, pinned, calls, editCode } = setup();
    history.beforeCodeEdit();
    editCode();
    // A Get drawn as a wire, recorded right after the parse.
    history.recordCodeLayout({ '~via|get': { x: 0, y: 0 } });
    history.recordCodeOverlay(EMPTY_OVERLAY, GROUP, {
      'overlay:g/n': { x: 1, y: 2 },
    });

    history.undo();
    expect(calls).toEqual(['undoCode']);
    expect(pinned.value['~via|get']).toBeUndefined();
    expect(pinned.value['overlay:g/n']).toBeUndefined();
    expect(history.canUndo.value).toBe(false);
  });
});
