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
