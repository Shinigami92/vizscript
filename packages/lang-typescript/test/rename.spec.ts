import { applyTextEdits } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyTypeScriptOp, parseTypeScript } from '../src';

/** Renames the first symbol `kind` `name` (in `scope`) to `to`. */
function rename(
  file: string,
  text: string,
  kind: string,
  name: string,
  to: string,
  scope = ''
): string {
  const symbol = parseTypeScript(text, file).symbols?.find(
    (s) => s.name === name && s.kind === kind && s.scope === scope
  );
  const result = applyTypeScriptOp(
    text,
    { type: 'renameSymbol', symbol: symbol?.id ?? '', name: to },
    file
  );
  if (!result.ok) {
    throw new Error(result.error);
  }

  return applyTextEdits(text, result.edits);
}

const CART =
  'class Cart {\n  static count = 0;\n  static make() { return new Cart(); }\n  add() { Cart.count++; return Cart.make(); }\n}\nCart.make();\n';

describe('typescript rename', () => {
  it('renames static members through the class name', () => {
    expect(rename('a.ts', CART, 'variable', 'count', 'total', 'Cart')).toBe(
      'class Cart {\n  static total = 0;\n  static make() { return new Cart(); }\n  add() { Cart.total++; return Cart.make(); }\n}\nCart.make();\n'
    );
    expect(rename('a.ts', CART, 'method', 'make', 'create', 'Cart')).toBe(
      'class Cart {\n  static count = 0;\n  static create() { return new Cart(); }\n  add() { Cart.count++; return Cart.create(); }\n}\nCart.create();\n'
    );
  });

  it('follows `this` like JavaScript does', () => {
    const text =
      'class A {\n  x = 1;\n  static x = 2;\n  m() { return this.x + A.x; }\n  static s() { return this.x; }\n  h = () => this.x;\n  f() { return function () { return this.x; }; }\n  o() { return { x: 3, get() { return this.x; } }; }\n}\n';
    expect(rename('a.ts', text, 'variable', 'x', 'y', 'A')).toBe(
      'class A {\n  y = 1;\n  static x = 2;\n  m() { return this.y + A.x; }\n  static s() { return this.x; }\n  h = () => this.y;\n  f() { return function () { return this.x; }; }\n  o() { return { x: 3, get() { return this.x; } }; }\n}\n'
    );
  });

  it('allows reserved words as member names, not as bindings', () => {
    const text =
      'interface R {\n  flag: boolean;\n}\nclass C {\n  constructor(private readonly x: number) {}\n  y = 1;\n}\nconst r: R = { flag: true };\nr.flag;\n';
    expect(rename('a.ts', text, 'variable', 'flag', 'private', 'R')).toContain(
      '  private: boolean;\n'
    );
    expect(rename('a.ts', text, 'variable', 'y', 'class', 'C')).toContain(
      '  class = 1;\n'
    );
    expect(() => rename('a.ts', text, 'variable', 'x', 'class', 'C')).toThrow(
      '"class" is a reserved word.'
    );
    expect(() => rename('a.ts', text, 'constant', 'r', 'class')).toThrow(
      '"class" is a reserved word.'
    );
  });

  it('renames components in JSX tags', () => {
    expect(
      rename(
        'a.tsx',
        "import * as ui from './ui';\nconst Button = () => <ui.Box><b>hi</b></ui.Box>;\nexport const App = () => <Button size={1}></Button>;\n",
        'function',
        'Button',
        'Btn'
      )
    ).toBe(
      "import * as ui from './ui';\nconst Btn = () => <ui.Box><b>hi</b></ui.Box>;\nexport const App = () => <Btn size={1}></Btn>;\n"
    );
  });

  it('updates static calls when an input is added', () => {
    const text =
      'class Cart {\n  static make(a: number) { return a; }\n}\nCart.make(1);\n';
    const symbol = parseTypeScript(text, 'a.ts').symbols?.find(
      (s) => s.name === 'make'
    );
    const result = applyTypeScriptOp(
      text,
      {
        type: 'addParameter',
        symbol: symbol?.id ?? '',
        name: 'b',
        argument: '2',
      },
      'a.ts'
    );
    expect(result.ok && applyTextEdits(text, result.edits)).toContain(
      'Cart.make(1, 2);'
    );
  });
});
