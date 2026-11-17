import { applyTextEdits } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyGDScriptOp, parseGDScriptDocument } from '../src';

/** Renames the symbol `kind` `name` (in `scope`) to `to`. */
function rename(
  text: string,
  kind: string,
  name: string,
  to: string,
  scope = ''
): string {
  const symbol = parseGDScriptDocument(text, 't.gd').symbols?.find(
    (s) => s.name === name && s.kind === kind && s.scope === scope
  );
  const result = applyGDScriptOp(
    text,
    { type: 'renameSymbol', symbol: symbol?.id ?? '', name: to },
    't.gd'
  );
  if (!result.ok) {
    throw new Error(result.error);
  }

  return applyTextEdits(text, result.edits);
}

describe('gdscript rename', () => {
  it('leaves a lambda parameter of the same name alone', () => {
    expect(
      rename(
        'func f():\n\tvar x = 1\n\tvar g = func(x): return x\n\tvar h = func(): return x\n\treturn x + g.call(2) + h.call()\n',
        'local',
        'x',
        'y',
        'f'
      )
    ).toBe(
      'func f():\n\tvar y = 1\n\tvar g = func(x): return x\n\tvar h = func(): return y\n\treturn y + g.call(2) + h.call()\n'
    );
    expect(
      rename('var x = 1\nvar cb = func(x): return x\n', 'variable', 'x', 'y')
    ).toBe('var y = 1\nvar cb = func(x): return x\n');
  });

  it('renames a class where another one extends it', () => {
    expect(
      rename(
        'class A:\n\tpass\n\nclass B extends A:\n\tpass\n',
        'class',
        'A',
        'Base'
      )
    ).toBe('class Base:\n\tpass\n\nclass B extends Base:\n\tpass\n');
  });

  it('renames constants in match patterns and guards', () => {
    expect(
      rename(
        'const IDLE = 0\nconst RUN = 1\n\nfunc f(s):\n\tmatch s:\n\t\tIDLE, RUN:\n\t\t\treturn 1\n\t\t[var n, _] when n > IDLE:\n\t\t\treturn n\n',
        'constant',
        'IDLE',
        'STILL'
      )
    ).toBe(
      'const STILL = 0\nconst RUN = 1\n\nfunc f(s):\n\tmatch s:\n\t\tSTILL, RUN:\n\t\t\treturn 1\n\t\t[var n, _] when n > STILL:\n\t\t\treturn n\n'
    );
  });

  it('keeps a name a match pattern binds', () => {
    expect(
      rename(
        'func f(s):\n\tvar x = 2\n\tmatch s:\n\t\t[var x]:\n\t\t\treturn x\n\t\t_:\n\t\t\treturn x\n',
        'local',
        'x',
        'y',
        'f'
      )
    ).toBe(
      'func f(s):\n\tvar y = 2\n\tmatch s:\n\t\t[var x]:\n\t\t\treturn x\n\t\t_:\n\t\t\treturn y\n'
    );
  });
});
