import type { GraphNode } from '@vizscript/core';
import { applyTextEdits } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyGDScriptOp, parseGDScriptDocument } from '../src';

function operators(text: string): GraphNode[] {
  return parseGDScriptDocument(text, 't.gd')
    .functions.flatMap((f) => f.nodes)
    .filter((n) => n.kind === 'operator');
}

describe('operator chains (UE math nodes with Add pin)', () => {
  it('lowers a chain of one operator as one node', () => {
    const [plus, ...rest] = operators(
      'func f(a: int, b: int, c: int) -> int:\n\treturn a + b + c\n'
    );
    expect(rest).toEqual([]);
    expect(
      plus?.pins.filter((p) => p.direction === 'in').map((p) => p.id)
    ).toEqual(['a', 'b', 'c']);
    expect(
      operators(
        'func f(a: int, b: int, c: int) -> int:\n\treturn (a + b) + c\n'
      )
    ).toHaveLength(2);
  });

  it('adds a value that changes nothing', () => {
    const text = 'func f(a: int, b: int) -> int:\n\treturn a * b\n';
    const result = applyGDScriptOp(
      text,
      {
        type: 'addArgument',
        node: operators(text)[0]?.id ?? '',
      },
      't.gd'
    );
    expect(result.ok && applyTextEdits(text, result.edits)).toBe(
      'func f(a: int, b: int) -> int:\n\treturn a * b * 1\n'
    );
  });

  it('removes a value with its operator', () => {
    const text = 'func f(a: int, b: int, c: int) -> int:\n\treturn a + b + c\n';
    const result = applyGDScriptOp(
      text,
      {
        type: 'removeArgument',
        pin: { node: operators(text)[0]?.id ?? '', pin: 'b' },
      },
      't.gd'
    );
    expect(result.ok && applyTextEdits(text, result.edits)).toBe(
      'func f(a: int, b: int, c: int) -> int:\n\treturn a + c\n'
    );
  });
});
