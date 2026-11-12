import { applyTextEdits } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyPythonOp, parsePythonDocument } from '../src';

function collapse(
  text: string,
  starts: ReadonlyArray<string>,
  name: string
): string {
  const doc = parsePythonDocument(text, 't.py');
  const nodes = doc.functions
    .flatMap((f) => f.nodes)
    .filter(
      (n) =>
        n.purity === 'impure' &&
        starts.some((s) => text.slice(n.range.start).startsWith(s))
    )
    .map((n) => n.id);
  const result = applyPythonOp(
    text,
    { type: 'collapseToFunction', nodes, name },
    't.py'
  );
  if (!result.ok) {
    throw new Error(result.error);
  }

  return applyTextEdits(text, result.edits);
}

describe('collapse to function', () => {
  it('turns statements into a function', () => {
    const text = [
      'def total(items: list, discount: float = 0) -> float:',
      '    total = 0',
      '    for item in items:',
      '        total += item.price',
      '    return total * (1 - discount)',
      '',
      '',
      'print(total([]))',
      '',
    ].join('\n');
    expect(collapse(text, ['total = 0', 'for item'], 'sum_prices')).toBe(
      [
        'def total(items: list, discount: float = 0) -> float:',
        '    total = sum_prices(items)',
        '    return total * (1 - discount)',
        '',
        '',
        'def sum_prices(items: list):',
        '    total = 0',
        '    for item in items:',
        '        total += item.price',
        '    return total',
        '',
        '',
        'print(total([]))',
        '',
      ].join('\n')
    );
  });

  it('makes methods with self', () => {
    const text = [
      'class Cart:',
      '    def add(self, item):',
      '        self.items.append(item)',
      '        self.count += 1',
      '',
    ].join('\n');
    expect(collapse(text, ['self.items', 'self.count'], 'store')).toBe(
      [
        'class Cart:',
        '    def add(self, item):',
        '        self.store(item)',
        '',
        '    def store(self, item):',
        '        self.items.append(item)',
        '        self.count += 1',
        '',
      ].join('\n')
    );
  });
});

describe('function settings', () => {
  it('makes functions async after their decorators', () => {
    const text = '@cache\ndef load():\n    pass\n';
    const result = applyPythonOp(
      text,
      {
        type: 'setModifier',
        symbol: 'function:load',
        modifier: 'async',
        enabled: true,
      },
      't.py'
    );
    expect(result.ok && applyTextEdits(text, result.edits)).toBe(
      '@cache\nasync def load():\n    pass\n'
    );
  });
});
