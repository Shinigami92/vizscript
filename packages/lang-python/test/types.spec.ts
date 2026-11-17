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
  it('writes text typed into an empty value as a string, code as code', () => {
    const value = (typed: string): string =>
      apply('UNITS = 1\nAPI = None\n', {
        type: 'setSymbolValue',
        symbol: 'constant:API',
        value: typed,
        kind: 'auto',
      }).split('\n')[1] ?? '';
    expect(value('https://example.com/forecast?city={city}')).toBe(
      'API = "https://example.com/forecast?city={city}"'
    );
    expect(value('metric')).toBe('API = "metric"');
    expect(value('"metric"')).toBe('API = "metric"');
    expect(value('42')).toBe('API = 42');
    expect(value('{"a": 1}')).toBe('API = {"a": 1}');
    // A name of the file is code.
    expect(value('UNITS')).toBe('API = UNITS');

    const param = apply('def summary(units=None):\n    pass\n', {
      type: 'setParameterValue',
      symbol: 'function:summary',
      index: 0,
      value: 'metric',
      kind: 'auto',
    });
    expect(param).toContain('def summary(units="metric"):');
  });

  it('refuses types that would rewrite the declaration', () => {
    for (const typeText of ['str  # note', 'str = 2', 'str\nimport os']) {
      const result = applyPythonOp(
        'count = 1\n',
        { type: 'setSymbolType', symbol: 'variable:count', typeText },
        'test.py'
      );
      expect(result).toEqual({
        ok: false,
        error: `"${typeText}" is not a valid Python type.`,
      });
    }
  });

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
