import type { GraphNode, GraphOp } from '@vizscript/core';
import { applyTextEdits } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyGDScriptOp, parseGDScriptDocument } from '../src';

function apply(text: string, op: GraphOp): string {
  const result = applyGDScriptOp(text, op, 't.gd');
  if (!result.ok) {
    throw new Error(result.error);
  }

  return applyTextEdits(text, result.edits);
}

function makeArray(text: string): GraphNode | undefined {
  return parseGDScriptDocument(text, 't.gd')
    .functions.flatMap((f) => f.nodes)
    .find((n) => n.kind === 'makeArray');
}

function addPin(text: string): string {
  return apply(text, { type: 'addArgument', node: makeArray(text)?.id ?? '' });
}

describe('Make Array (UE Add pin)', () => {
  it("adds an element with its type's empty value", () => {
    expect(addPin('func f():\n\tvar xs = [1, 2]\n')).toBe(
      'func f():\n\tvar xs = [1, 2, 0]\n'
    );
    expect(addPin('func f():\n\tvar xs = []\n')).toBe(
      'func f():\n\tvar xs = [null]\n'
    );
  });

  it('removes an element with its comma', () => {
    const text = 'func f():\n\tvar xs = [1, 2, 3]\n';
    expect(
      apply(text, {
        type: 'removeArgument',
        pin: { node: makeArray(text)?.id ?? '', pin: 'e1' },
      })
    ).toBe('func f():\n\tvar xs = [1, 3]\n');
  });
});
