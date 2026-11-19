import { applyTextEdits } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyTypeScriptOp, parseTypeScript } from '../src';

/** Sets `clause` of the class or interface `name`. */
function setHeritage(
  text: string,
  name: string,
  clause: 'extends' | 'implements',
  value: string
): string {
  const symbol = parseTypeScript(text, 'a.ts').symbols?.find(
    (s) => s.name === name
  );
  const result = applyTypeScriptOp(
    text,
    { type: 'setHeritage', symbol: symbol?.id ?? '', clause, text: value },
    'a.ts'
  );
  if (!result.ok) {
    throw new Error(result.error);
  }

  return applyTextEdits(text, result.edits);
}

describe('what classes and interfaces extend and implement', () => {
  it('knows the clauses as written', () => {
    const symbols =
      parseTypeScript(
        'class A<T> extends Base<T> implements B, C<T> {}\ninterface I extends J, K<string> {}\n',
        'a.ts'
      ).symbols ?? [];
    const a = symbols.find((s) => s.name === 'A');
    expect(a?.extends).toBe('Base<T>');
    expect(a?.implements).toBe('B, C<T>');
    expect(symbols.find((s) => s.name === 'I')?.extends).toBe('J, K<string>');
  });

  it('adds, replaces and removes what a class implements', () => {
    const plain = '@Injectable()\nexport class P {\n}\n';
    const implementing = setHeritage(plain, 'P', 'implements', 'ScmProvider');
    expect(implementing).toBe(
      '@Injectable()\nexport class P implements ScmProvider {\n}\n'
    );
    expect(setHeritage(implementing, 'P', 'implements', 'A, B<string>')).toBe(
      '@Injectable()\nexport class P implements A, B<string> {\n}\n'
    );
    expect(setHeritage(implementing, 'P', 'implements', '')).toBe(plain);
  });

  it('keeps `extends` before `implements`', () => {
    const text = 'class P<T> implements I {}\n';
    const based = setHeritage(text, 'P', 'extends', 'Base<T>');
    expect(based).toBe('class P<T> extends Base<T> implements I {}\n');
    expect(setHeritage(based, 'P', 'implements', 'I, J')).toBe(
      'class P<T> extends Base<T> implements I, J {}\n'
    );
    expect(setHeritage(based, 'P', 'extends', '')).toBe(text);
  });

  it('sets what an interface extends', () => {
    expect(setHeritage('interface I {}\n', 'I', 'extends', 'J, K')).toBe(
      'interface I extends J, K {}\n'
    );
    expect(setHeritage('interface I extends J {}\n', 'I', 'extends', '')).toBe(
      'interface I {}\n'
    );
  });

  it('refuses what cannot be written', () => {
    expect(() =>
      setHeritage('interface I {}\n', 'I', 'implements', 'J')
    ).toThrow('An interface extends others; it implements none.');
    expect(() => setHeritage('class P {}\n', 'P', 'extends', 'A, B')).toThrow(
      '"A, B" cannot follow extends.'
    );
  });
});
