import type { GraphOp } from '@vizscript/core';
import { applyTextEdits } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyPythonOp, parsePythonDocument } from '../src';

describe('new calls', () => {
  it('get a value for each required argument', () => {
    const text = 'def heal(amount: int, data: dict):\n    pass\n\n\nx = 1\n';
    const doc = parsePythonDocument(text, 'm.py');
    const set = doc.functions
      .flatMap((f) => f.nodes)
      .find((n) => n.kind === 'setVar');
    const op: GraphOp = {
      type: 'addNode',
      template: { type: 'call', callee: 'heal' },
      after: { node: set?.id ?? '', pin: 'then' },
    };
    const result = applyPythonOp(text, op, 'm.py');
    if (!result.ok) {
      throw new Error(result.error);
    }

    // The type's default where it is a plain value, else the placeholder.
    expect(applyTextEdits(text, result.edits)).toContain(
      'x = 1\nheal(0, None)\n'
    );
  });
});
