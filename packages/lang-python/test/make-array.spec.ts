import type { GraphNode, GraphOp } from '@vizscript/core';
import { applyTextEdits, canAddPin } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyPythonOp, parsePythonDocument } from '../src';

function apply(text: string, op: GraphOp): string {
  const result = applyPythonOp(text, op, 't.py');
  if (!result.ok) {
    throw new Error(result.error);
  }

  return applyTextEdits(text, result.edits);
}

function makeArray(text: string): GraphNode | undefined {
  return parsePythonDocument(text, 't.py')
    .functions.flatMap((f) => f.nodes)
    .find((n) => n.kind === 'makeArray');
}

function addPin(text: string): string {
  return apply(text, { type: 'addArgument', node: makeArray(text)?.id ?? '' });
}

describe('Make Array (UE Add pin)', () => {
  it("adds an element with its type's empty value", () => {
    expect(addPin('xs = [1, 2]\n')).toBe('xs = [1, 2, 0]\n');
    expect(addPin('xs = []\n')).toBe('xs = [None]\n');
  });

  it('removes an element with its comma', () => {
    const text = 'xs = [1, 2, 3]\n';
    expect(
      apply(text, {
        type: 'removeArgument',
        pin: { node: makeArray(text)?.id ?? '', pin: 'e1' },
      })
    ).toBe('xs = [1, 3]\n');
  });

  it('leaves other collections alone', () => {
    const node = makeArray('xs = (1, 2)\n');
    expect(node && canAddPin(node)).toBe(false);
  });
});
