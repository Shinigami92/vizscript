import type { GraphOp } from '@vizscript/core';
import { applyTextEdits } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyGDScriptOp, parseGDScriptDocument } from '../src';

describe('new calls', () => {
  it('get a value for each required argument', () => {
    const text =
      'extends Node\n\n\nfunc heal(amount: int, target) -> void:\n\tpass\n\n\nfunc _ready() -> void:\n\tvar x = 1\n';
    const doc = parseGDScriptDocument(text, 'm.gd');
    const set = doc.functions
      .flatMap((f) => f.nodes)
      .find((n) => n.kind === 'setVar');
    const op: GraphOp = {
      type: 'addNode',
      template: { type: 'call', callee: 'heal' },
      after: { node: set?.id ?? '', pin: 'then' },
    };
    const result = applyGDScriptOp(text, op, 'm.gd');
    if (!result.ok) {
      throw new Error(result.error);
    }

    // The type's default where it is a plain value, else the placeholder.
    expect(applyTextEdits(text, result.edits)).toContain(
      '\tvar x = 1\n\theal(0, null)\n'
    );
  });
});
