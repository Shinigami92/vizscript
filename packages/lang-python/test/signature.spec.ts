import type { GraphOp } from '@vizscript/core';
import { applyTextEdits } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyPythonOp, parsePythonDocument } from '../src';

function apply(text: string, op: GraphOp): string {
  const result = applyPythonOp(text, op, 'test.py');
  if (!result.ok) {
    throw new Error(result.error);
  }

  return applyTextEdits(text, result.edits);
}

const TEXT = [
  'class Cart:',
  '    def add(self, item, count=1):',
  '        return item * count',
  '',
  '    def fill(self):',
  '        self.add("x", count=2)',
  '',
  '',
  'def price(value):',
  '    return value',
  '',
  '',
  'price(10)',
  '',
].join('\n');

describe('python signatures', () => {
  it('keeps self and updates calls', () => {
    expect(
      apply(TEXT, {
        type: 'addParameter',
        symbol: 'function:price',
        name: 'tax',
        typeText: 'float',
        argument: '0.0',
      })
    ).toContain(
      'def price(value, tax: float):\n    return value\n\n\nprice(10, 0.0)'
    );
    const removed = apply(TEXT, {
      type: 'removeParameter',
      symbol: 'method:Cart.add',
      index: 1,
    });
    expect(removed).toContain('def add(self, item):');
    expect(removed).toContain('self.add("x")');
    expect(
      apply(TEXT, {
        type: 'setReturnType',
        symbol: 'function:price',
        typeText: 'int',
      })
    ).toContain('def price(value) -> int:');
  });
});

describe('python lone values', () => {
  it('appends a value statement', () => {
    expect(
      apply('x = 1\n', {
        type: 'addNode',
        template: { type: 'value', expression: 'x' },
      })
    ).toBe('x = 1\nx\n');
  });
});

describe('python argument pins', () => {
  it('fills missing arguments by keyword', () => {
    const text =
      'def greet(name, times=2, loud=False):\n    pass\n\n\ngreet("a")\n';
    const doc = parsePythonDocument(text, 't.py');
    const call = doc.functions
      .flatMap((f) => f.nodes)
      .find((n) => n.kind === 'call');
    expect(
      call?.pins.filter((p) => p.id.startsWith('param:')).map((p) => p.name)
    ).toEqual(['times', 'loud']);
    expect(
      apply(text, {
        type: 'setLiteral',
        node: call?.id ?? '',
        pin: 'param:loud',
        value: 'true',
      })
    ).toContain('greet("a", loud=True)');
  });
});
