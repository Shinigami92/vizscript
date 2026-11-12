import type { GraphOp } from '@vizscript/core';
import { applyTextEdits } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyTypeScriptOp, parseTypeScript } from '../src';

function apply(text: string, op: GraphOp, file = 'test.ts'): string {
  const result = applyTypeScriptOp(text, op, file);
  if (!result.ok) {
    throw new Error(result.error);
  }

  return applyTextEdits(text, result.edits);
}

function error(text: string, op: GraphOp, file = 'test.ts'): string {
  const result = applyTypeScriptOp(text, op, file);
  return result.ok ? '' : result.error;
}

describe('types and values', () => {
  it('sets, changes and removes types', () => {
    expect(
      apply('let user;\n', {
        type: 'setSymbolType',
        symbol: 'variable:user',
        typeText: 'string',
        defaultValue: "''",
      })
    ).toBe("let user: string = '';\n");
    expect(
      apply('const n: number = 1;\n', {
        type: 'setSymbolType',
        symbol: 'constant:n',
        typeText: 'bigint',
      })
    ).toBe('const n: bigint = 1;\n');
    expect(
      apply('const n: number = 1;\n', {
        type: 'setSymbolType',
        symbol: 'constant:n',
        typeText: null,
      })
    ).toBe('const n = 1;\n');
    expect(
      apply('class A {\n  x?: number;\n}\n', {
        type: 'setSymbolType',
        symbol: 'variable:A.x',
        typeText: 'string[]',
      })
    ).toBe('class A {\n  x?: string[];\n}\n');
  });

  it('validates types and refuses them in JavaScript', () => {
    expect(
      error('let a;\n', {
        type: 'setSymbolType',
        symbol: 'variable:a',
        typeText: 'string |',
      })
    ).toBe('"string |" is not a valid TypeScript type.');
    expect(
      error(
        'let a;\n',
        { type: 'setSymbolType', symbol: 'variable:a', typeText: 'string' },
        'test.js'
      )
    ).toBe('JavaScript has no type annotations.');
  });

  it('writes values for their type', () => {
    const text = "const label = 'x';\nlet count;\n";
    expect(
      apply(text, {
        type: 'setSymbolValue',
        symbol: 'constant:label',
        value: "Jane's",
        kind: 'string',
      })
    ).toBe("const label = 'Jane\\'s';\nlet count;\n");
    expect(
      apply(text, {
        type: 'setSymbolValue',
        symbol: 'variable:count',
        value: '3',
        kind: 'number',
      })
    ).toBe("const label = 'x';\nlet count = 3;\n");
    expect(
      error(text, {
        type: 'setSymbolValue',
        symbol: 'constant:label',
        value: null,
        kind: 'expression',
      })
    ).toBe('label needs a value.');
  });

  it('switches declaration keywords and modifiers', () => {
    expect(
      apply('let a = 1;\n', {
        type: 'setModifier',
        symbol: 'variable:a',
        modifier: 'const',
        enabled: true,
      })
    ).toBe('const a = 1;\n');
    expect(
      apply('const a = 1;\n', {
        type: 'setModifier',
        symbol: 'constant:a',
        modifier: 'export',
        enabled: true,
      })
    ).toBe('export const a = 1;\n');
    expect(
      apply('export const a = 1;\n', {
        type: 'setModifier',
        symbol: 'constant:a',
        modifier: 'export',
        enabled: false,
      })
    ).toBe('const a = 1;\n');
    expect(
      apply('class A {\n  private readonly x = 1;\n}\n', {
        type: 'setModifier',
        symbol: 'variable:A.x',
        modifier: 'static',
        enabled: true,
      })
    ).toBe('class A {\n  private static readonly x = 1;\n}\n');
  });

  it('quotes plain text typed into a placeholder value', () => {
    const text = 'const user = undefined;\nconst n = undefined;\n';
    const doc = parseTypeScript(text, 'test.ts');
    const setUser = doc.functions[0]?.nodes.find((n) => n.title === 'Set user');
    const setN = doc.functions[0]?.nodes.find((n) => n.title === 'Set n');
    expect(
      apply(text, {
        type: 'setLiteral',
        node: setUser?.id ?? '',
        pin: 'value',
        value: 'Jane User',
      })
    ).toBe('const user = "Jane User";\nconst n = undefined;\n');
    expect(
      apply(text, {
        type: 'setLiteral',
        node: setN?.id ?? '',
        pin: 'value',
        value: '42',
      })
    ).toBe('const user = undefined;\nconst n = 42;\n');
    expect(
      apply(text, {
        type: 'setLiteral',
        node: setN?.id ?? '',
        pin: 'value',
        value: 'user',
      })
    ).toBe('const user = undefined;\nconst n = user;\n');
  });
});
