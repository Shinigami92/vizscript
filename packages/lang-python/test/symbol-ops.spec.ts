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

const SHOP = [
  'import json',
  '',
  'TAX = 0.19',
  '',
  '',
  'class Cart:',
  '    count = 0',
  '',
  '    def __init__(self, owner):',
  '        self.owner = owner',
  '',
  '    def describe(self):',
  '        total = Cart.count',
  '        return f"{self.owner}: {total}"',
  '',
  '',
  'def price(value, tax=TAX):',
  '    total = value * (1 + tax)',
  '    return total',
  '',
  '',
  'print(price(10), TAX)',
  '',
].join('\n');

describe('python symbol ops', () => {
  it('adds functions, methods, variables and locals', () => {
    expect(apply(SHOP, { type: 'addFunction', scope: '', name: 'main' })).toBe(
      `${SHOP}\n\ndef main():\n    pass\n`
    );
    expect(
      apply(SHOP, { type: 'addFunction', scope: 'Cart', name: 'clear' })
    ).toContain(
      '        return f"{self.owner}: {total}"\n\n    def clear(self):\n        pass\n'
    );
    expect(
      apply(SHOP, { type: 'addVariable', scope: '', name: 'RATE' })
    ).toContain('TAX = 0.19\nRATE = None\n');
    expect(
      apply(SHOP, { type: 'addVariable', scope: 'Cart', name: 'limit' })
    ).toContain('    count = 0\n    limit = None\n');
    expect(
      apply(SHOP, {
        type: 'addVariable',
        scope: 'price',
        name: 'rounded',
        local: true,
      })
    ).toContain('def price(value, tax=TAX):\n    rounded = None\n    total');
  });

  it('renames with Python scope rules', () => {
    const renamed = apply(SHOP, {
      type: 'renameSymbol',
      symbol: 'constant:TAX',
      name: 'VAT',
    });
    expect(renamed).toContain('VAT = 0.19');
    expect(renamed).toContain('def price(value, tax=VAT):');
    expect(renamed).toContain('print(price(10), VAT)');

    const local = apply(SHOP, {
      type: 'renameSymbol',
      symbol: 'local:price.total',
      name: 'gross',
    });
    expect(local).toContain('    gross = value * (1 + tax)\n    return gross');
    // `total` of Cart.describe is another variable.
    expect(local).toContain('        total = Cart.count');

    const member = apply(SHOP, {
      type: 'renameSymbol',
      symbol: 'variable:Cart.count',
      name: 'instances',
    });
    expect(member).toContain('    instances = 0');
    expect(member).toContain('total = Cart.instances');

    const field = apply(SHOP, {
      type: 'renameSymbol',
      symbol: 'variable:Cart.owner',
      name: 'name',
    });
    expect(field).toContain('self.name = owner');
    expect(field).toContain('{self.name}');
  });

  it('deletes declarations and keeps blocks valid', () => {
    expect(
      apply(SHOP, { type: 'deleteSymbol', symbol: 'function:price' })
    ).toContain('        return f"{self.owner}: {total}"\n\n\nprint(');
    expect(
      apply('def f():\n    x = 1\n\nf()\n', {
        type: 'deleteSymbol',
        symbol: 'local:f.x',
      })
    ).toBe('def f():\n    pass\n\nf()\n');
  });
});

describe('adding types', () => {
  it('adds a class below the imports', () => {
    expect(
      apply('import math\n\n\nx = 1\n', { type: 'addType', name: 'Item' })
    ).toBe('import math\n\n\nclass Item:\n    pass\n\n\nx = 1\n');
  });
});
