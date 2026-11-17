import { applyTextEdits } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyPythonOp, parsePythonDocument } from '../src';

/** Renames the symbol `kind` `name` (in `scope`) to `to`. */
function rename(
  text: string,
  kind: string,
  name: string,
  to: string,
  scope = ''
): string {
  const symbol = parsePythonDocument(text, 't.py').symbols?.find(
    (s) => s.name === name && s.kind === kind && s.scope === scope
  );
  const result = applyPythonOp(
    text,
    { type: 'renameSymbol', symbol: symbol?.id ?? '', name: to },
    't.py'
  );
  if (!result.ok) {
    throw new Error(result.error);
  }

  return applyTextEdits(text, result.edits);
}

describe('python rename', () => {
  it('renames uses in comprehensions, not their own targets', () => {
    expect(
      rename(
        'LIMIT = 3\nd = {k: LIMIT for k in range(LIMIT) if k < LIMIT}\ng = [LIMIT for LIMIT in [1]]\n',
        'constant',
        'LIMIT',
        'MAX'
      )
    ).toBe(
      'MAX = 3\nd = {k: MAX for k in range(MAX) if k < MAX}\ng = [LIMIT for LIMIT in [1]]\n'
    );
  });

  it('renames a class in annotations and return types', () => {
    expect(
      rename(
        'class Item:\n    pass\n\n\ndef f(x: Item) -> list[Item]:\n    y: Item = x\n    return [y]\n',
        'class',
        'Item',
        'Thing'
      )
    ).toBe(
      'class Thing:\n    pass\n\n\ndef f(x: Thing) -> list[Thing]:\n    y: Thing = x\n    return [y]\n'
    );
  });

  it('renames decorators, not the names after their dots', () => {
    expect(
      rename(
        'def check(fn):\n    return fn\n\n\nclass A:\n    @check\n    def m(self):\n        pass\n\n    @other.check\n    def n(self):\n        pass\n',
        'function',
        'check',
        'verify'
      )
    ).toBe(
      'def verify(fn):\n    return fn\n\n\nclass A:\n    @verify\n    def m(self):\n        pass\n\n    @other.check\n    def n(self):\n        pass\n'
    );
  });

  it('follows nonlocal to the enclosing function', () => {
    expect(
      rename(
        'def f():\n    x = 1\n\n    def g():\n        nonlocal x\n        x += 1\n\n    g()\n    return x\n',
        'local',
        'x',
        'count',
        'f'
      )
    ).toBe(
      'def f():\n    count = 1\n\n    def g():\n        nonlocal count\n        count += 1\n\n    g()\n    return count\n'
    );
  });

  it('renames class names in match patterns, not keywords', () => {
    expect(
      rename(
        'class P:\n    x = 0\n\n\ndef f(v):\n    match v:\n        case P(x=0):\n            return 1\n',
        'class',
        'P',
        'Point'
      )
    ).toBe(
      'class Point:\n    x = 0\n\n\ndef f(v):\n    match v:\n        case Point(x=0):\n            return 1\n'
    );
  });

  it('keeps a name an import in a function binds', () => {
    expect(
      rename(
        'def helper():\n    pass\n\n\ndef f():\n    from m import (a,  # c\n        helper)\n    return helper()\n\n\nhelper()\n',
        'function',
        'helper',
        'aid'
      )
    ).toBe(
      'def aid():\n    pass\n\n\ndef f():\n    from m import (a,  # c\n        helper)\n    return helper()\n\n\naid()\n'
    );
  });

  it('treats only the first parameter of methods as self', () => {
    const text =
      'class A:\n    x = 1\n\n    def m(self, other):\n        def helper(item):\n            return item.x + self.x\n\n        return helper(other)\n\n    @staticmethod\n    def s(item):\n        return item.x\n';
    expect(rename(text, 'variable', 'x', 'z', 'A')).toBe(
      'class A:\n    z = 1\n\n    def m(self, other):\n        def helper(item):\n            return item.x + self.z\n\n        return helper(other)\n\n    @staticmethod\n    def s(item):\n        return item.x\n'
    );
  });
});
