import type { GraphNode } from '@vizscript/core';
import { applyTextEdits } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyRustOp, parseRustDocument } from '../src';

function operators(text: string): GraphNode[] {
  return parseRustDocument(text, 't.rs')
    .functions.flatMap((f) => f.nodes)
    .filter((n) => n.kind === 'operator');
}

describe('operator chains (UE math nodes with Add pin)', () => {
  it('lowers a chain of one operator as one node', () => {
    const [plus, ...rest] = operators(
      'fn f(a: i32, b: i32, c: i32) -> i32 {\n    a + b + c\n}\n'
    );
    expect(rest).toEqual([]);
    expect(
      plus?.pins.filter((p) => p.direction === 'in').map((p) => p.id)
    ).toEqual(['a', 'b', 'c']);
    expect(
      operators('fn f(a: i32, b: i32, c: i32) -> i32 {\n    (a + b) + c\n}\n')
    ).toHaveLength(2);
  });

  it('adds a value that changes nothing', () => {
    const text = 'fn f(a: i32, b: i32) -> i32 {\n    a + b\n}\n';
    const result = applyRustOp(
      text,
      {
        type: 'addArgument',
        node: operators(text)[0]?.id ?? '',
      },
      't.rs'
    );
    expect(result.ok && applyTextEdits(text, result.edits)).toBe(
      'fn f(a: i32, b: i32) -> i32 {\n    a + b + 0\n}\n'
    );
  });

  it('removes a value with its operator', () => {
    const text = 'fn f(a: i32, b: i32, c: i32) -> i32 {\n    a + b + c\n}\n';
    const result = applyRustOp(
      text,
      {
        type: 'removeArgument',
        pin: { node: operators(text)[0]?.id ?? '', pin: 'b' },
      },
      't.rs'
    );
    expect(result.ok && applyTextEdits(text, result.edits)).toBe(
      'fn f(a: i32, b: i32, c: i32) -> i32 {\n    a + c\n}\n'
    );
  });
});
