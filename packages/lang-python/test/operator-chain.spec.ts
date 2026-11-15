import type { GraphNode } from '@vizscript/core';
import { applyTextEdits } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyPythonOp, parsePythonDocument } from '../src';

function operators(text: string): GraphNode[] {
  return parsePythonDocument(text, 't.py')
    .functions.flatMap((f) => f.nodes)
    .filter((n) => n.kind === 'operator');
}

describe('operator chains (UE math nodes with Add pin)', () => {
  it('lowers a chain of one operator as one node', () => {
    const [plus, ...rest] = operators(
      'def f(a: int, b: int, c: int):\n    return a + b + c\n'
    );
    expect(rest).toEqual([]);
    expect(
      plus?.pins.filter((p) => p.direction === 'in').map((p) => p.id)
    ).toEqual(['a', 'b', 'c']);
    expect(
      operators('def f(a: int, b: int, c: int):\n    return (a + b) + c\n')
    ).toHaveLength(2);
  });

  it('adds a value that changes nothing', () => {
    const text = 'def f(a: int, b: int):\n    return a + b\n';
    const result = applyPythonOp(
      text,
      {
        type: 'addArgument',
        node: operators(text)[0]?.id ?? '',
      },
      't.py'
    );
    expect(result.ok && applyTextEdits(text, result.edits)).toBe(
      'def f(a: int, b: int):\n    return a + b + 0\n'
    );
  });

  it('removes a value with its operator', () => {
    const text = 'def f(a: int, b: int, c: int):\n    return a + b + c\n';
    const result = applyPythonOp(
      text,
      {
        type: 'removeArgument',
        pin: { node: operators(text)[0]?.id ?? '', pin: 'b' },
      },
      't.py'
    );
    expect(result.ok && applyTextEdits(text, result.edits)).toBe(
      'def f(a: int, b: int, c: int):\n    return a + c\n'
    );
  });
});
