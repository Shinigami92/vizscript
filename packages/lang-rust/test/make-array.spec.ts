import type { GraphNode, GraphOp } from '@vizscript/core';
import { applyTextEdits, canAddPin } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyRustOp, parseRustDocument } from '../src';

function apply(text: string, op: GraphOp): string {
  const result = applyRustOp(text, op, 't.rs');
  if (!result.ok) {
    throw new Error(result.error);
  }

  return applyTextEdits(text, result.edits);
}

function makeArray(text: string): GraphNode | undefined {
  return parseRustDocument(text, 't.rs')
    .functions.flatMap((f) => f.nodes)
    .find((n) => n.kind === 'makeArray');
}

function addPin(text: string): string {
  return apply(text, { type: 'addArgument', node: makeArray(text)?.id ?? '' });
}

describe('Make Array (UE Add pin)', () => {
  it("adds an element with its type's empty value", () => {
    expect(addPin('fn f() {\n    let xs = vec![1, 2];\n}\n')).toBe(
      'fn f() {\n    let xs = vec![1, 2, 0];\n}\n'
    );
  });

  it('removes an element with its comma', () => {
    const text = 'fn f() {\n    let xs = [1, 2, 3];\n}\n';
    expect(
      apply(text, {
        type: 'removeArgument',
        pin: { node: makeArray(text)?.id ?? '', pin: 'e1' },
      })
    ).toBe('fn f() {\n    let xs = [1, 3];\n}\n');
  });

  it('leaves other collections alone', () => {
    const node = makeArray('fn f() {\n    let xs = [0; 3];\n}\n');
    expect(node && canAddPin(node)).toBe(false);
  });
});
