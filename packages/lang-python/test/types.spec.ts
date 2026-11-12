import type { GraphOp } from '@vizscript/core';
import { applyTextEdits } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyPythonOp } from '../src';

function apply(text: string, op: GraphOp): string {
  const result = applyPythonOp(text, op, 'test.py');
  if (!result.ok) {
    throw new Error(result.error);
  }

  return applyTextEdits(text, result.edits);
}

describe('python types and values', () => {
  it('annotates, retypes and writes values', () => {
    expect(
      apply('name = None\n', {
        type: 'setSymbolType',
        symbol: 'variable:name',
        typeText: 'str',
        defaultValue: '""',
      })
    ).toBe('name: str = ""\n');
    expect(
      apply('count: int = 0\n', {
        type: 'setSymbolType',
        symbol: 'variable:count',
        typeText: 'list[int]',
      })
    ).toBe('count: list[int] = 0\n');
    expect(
      apply('flag = None\n', {
        type: 'setSymbolValue',
        symbol: 'variable:flag',
        value: 'true',
        kind: 'bool',
      })
    ).toBe('flag = True\n');
    const failed = applyPythonOp(
      'x = 1\n',
      {
        type: 'setSymbolValue',
        symbol: 'variable:x',
        value: null,
        kind: 'expression',
      },
      'test.py'
    );
    expect(failed.ok).toBe(false);
  });
});
