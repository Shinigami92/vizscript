import type { GraphOp, OpResult, TextEdit } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import type { OpRunnerDeps } from '../src/components/script-workspace/use-op-runner';
import { useOpRunner } from '../src/components/script-workspace/use-op-runner';

interface Runner {
  onOp: (op: GraphOp) => Promise<void>;
  calls: string[];
  written: Array<{ base: string; edits: ReadonlyArray<TextEdit> }>;
  shown: string[];
  state: { text: string; parsedText: string };
}

const OP: GraphOp = {
  type: 'setLiteral',
  node: 'n1',
  pin: 'arg0',
  value: '2',
};

/**
 * A runner over fakes: `applyOp` answers with `result`, after `during`
 * ran (the user typing while the worker makes the edits).
 */
function runner(
  result: OpResult,
  options: { during?: (state: Runner['state']) => void; parsed?: string } = {}
): Runner {
  const state = { text: 'a(1);\n', parsedText: options.parsed ?? 'a(1);\n' };
  const calls: string[] = [];
  const written: Runner['written'] = [];
  const shown: string[] = [];
  const note = (name: string) => (): void => {
    calls.push(name);
  };
  const deps: OpRunnerDeps = {
    editable: () => true,
    text: () => state.text,
    parsedText: () => state.parsedText,
    reparse: async () => {
      calls.push(`reparse ${state.text}`);
      state.parsedText = state.text;
    },
    doc: () => null,
    parsedDoc: () => null,
    focusFn: () => null,
    outOfSync: () => false,
    placeholder: () => 'undefined',
    vias: {
      throughVias: (op) => op,
      beforeOp: note('vias.beforeOp'),
      cancelOp: note('vias.cancelOp'),
    },
    keptNodes: {
      beforeOp: note('kept.beforeOp'),
      cancelOp: note('kept.cancelOp'),
      deleteLoose: async () => false,
    },
    overlay: {
      addEdits: note('addEdits'),
      addFloating: async () => undefined,
      fillCutReceiver: async () => false,
      floatInput: async () => false,
      floatReceiver: async () => false,
      floatValueUse: async () => false,
    },
    freezeLayout: () => undefined,
    beforeCodeEdit: () => undefined,
    applyOp: async (base) => {
      calls.push(`applyOp ${base}`);
      options.during?.(state);
      return result;
    },
    write: (base, edits) => {
      written.push({ base, edits });
    },
    deselect: note('deselect'),
    show: (message) => {
      shown.push(message);
    },
  };
  const { onOp } = useOpRunner(deps);
  return { onOp, calls, written, shown, state };
}

const EDITS: TextEdit[] = [{ start: 2, end: 3, text: '2' }];

describe('op runner', () => {
  it('writes the edits into the text they were made on', async () => {
    const r = runner({ ok: true, edits: EDITS });
    await r.onOp(OP);
    expect(r.written).toEqual([{ base: 'a(1);\n', edits: EDITS }]);
    expect(r.calls).not.toContain('vias.cancelOp');
  });

  it('parses typed code first, so the op fits the text', async () => {
    const r = runner({ ok: true, edits: EDITS }, { parsed: 'a(0);\n' });
    await r.onOp(OP);
    expect(r.calls.slice(0, 2)).toEqual(['reparse a(1);\n', 'vias.beforeOp']);
    expect(r.calls).toContain('applyOp a(1);\n');
  });

  it('drops edits when the code changed while they were made', async () => {
    const r = runner(
      { ok: true, edits: EDITS },
      {
        during: (state) => {
          state.text = 'a(1); // typed\n';
        },
      }
    );
    await r.onOp(OP);
    expect(r.written).toEqual([]);
    expect(r.shown).toEqual(['The code changed meanwhile: do the edit again.']);
    // What the op noted beforehand is not left for the next parse.
    expect(r.calls).toContain('vias.cancelOp');
    expect(r.calls).toContain('kept.cancelOp');
  });

  it('forgets its notes when the op fails or changes nothing', async () => {
    const results: OpResult[] = [
      { ok: false, error: 'No.' },
      { ok: true, edits: [] },
    ];
    for (const result of results) {
      const r = runner(result);
      await r.onOp(OP);
      expect(r.written).toEqual([]);
      expect(r.calls).toContain('vias.cancelOp');
      expect(r.calls).toContain('kept.cancelOp');
    }
  });

  it('runs ops one after the other', async () => {
    const r = runner({ ok: true, edits: EDITS });
    await Promise.all([r.onOp(OP), r.onOp(OP)]);
    expect(r.calls.filter((c) => c.startsWith('applyOp'))).toHaveLength(2);
    expect(r.written).toHaveLength(2);
  });

  it('deselects after a delete', async () => {
    const r = runner({ ok: true, edits: EDITS });
    await r.onOp({ type: 'deleteNodes', nodeIds: ['n1'] });
    expect(r.calls).toContain('deselect');
  });
});
