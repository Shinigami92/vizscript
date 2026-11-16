import type { GraphOp, NodeTemplate } from '@vizscript/core';
import { applyTextEdits } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyPythonOp, parsePythonDocument } from '../src';

/** Adds `template` on the False pin of the `index`-th Branch. */
function onFalse(text: string, index: number, template: NodeTemplate): string {
  const doc = parsePythonDocument(text, 'm.py');
  const branch = doc.functions
    .flatMap((f) => f.nodes)
    .filter((n) => n.kind === 'branch')[index];
  const op: GraphOp = {
    type: 'addNode',
    template,
    after: { node: branch?.id ?? '', pin: 'false' },
  };
  const result = applyPythonOp(text, op, 'm.py');
  if (!result.ok) {
    throw new Error(result.error);
  }

  return applyTextEdits(text, result.edits);
}

const CALL: NodeTemplate = { type: 'call', callee: 'g' };

describe('a node on the False pin of an if without else', () => {
  it('writes an else around it', () => {
    expect(
      onFalse('def f(x):\n    if x:\n        print(x)\n    return x\n', 0, CALL)
    ).toBe(
      'def f(x):\n    if x:\n        print(x)\n    else:\n        g()\n    return x\n'
    );
  });

  it('writes it behind the last branch of a chain', () => {
    const text =
      'def f(x):\n    if x > 1:\n        print(x)\n    elif x < 0:\n        print(0)\n    return x\n';
    expect(onFalse(text, 1, CALL)).toContain(
      '    elif x < 0:\n        print(0)\n    else:\n        g()\n    return x\n'
    );
    expect(onFalse(text, 1, { type: 'branch' })).toContain(
      '    elif x < 0:\n        print(0)\n    elif True:\n        pass\n    return x\n'
    );
    // The first branch's False pin leads into the next one already.
    expect(() => onFalse(text, 0, CALL)).toThrow(
      'Code cannot be inserted after this pin.'
    );
  });
});
