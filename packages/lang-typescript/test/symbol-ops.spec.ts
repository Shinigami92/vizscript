import type { GraphOp } from '@vizscript/core';
import { applyTextEdits } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyTypeScriptOp, parseTypeScript } from '../src';

function apply(text: string, op: GraphOp): string {
  const result = applyTypeScriptOp(text, op, 'test.ts');
  if (!result.ok) {
    throw new Error(result.error);
  }

  return applyTextEdits(text, result.edits);
}

function error(text: string, op: GraphOp): string | undefined {
  const result = applyTypeScriptOp(text, op, 'test.ts');
  return result.ok ? undefined : result.error;
}

const GREETER = [
  'import { log } from "./log";',
  '',
  'const user = "Jane";',
  '',
  'export function greeter(person: string): string {',
  '  const prefix = "Hello, ";',
  '  return prefix + person;',
  '}',
  '',
  'log(greeter(user));',
  'export { user };',
  '',
].join('\n');

describe('adding symbols', () => {
  it('adds functions after the last one and variables after the last one', () => {
    // Before the code that runs the module.
    expect(
      apply(GREETER, { type: 'addFunction', scope: '', name: 'farewell' })
    ).toContain(
      '  return prefix + person;\n}\n\nfunction farewell() {\n}\n\nlog('
    );
    expect(
      apply('const a = 1;\n', { type: 'addFunction', scope: '', name: 'f' })
    ).toBe('const a = 1;\n\nfunction f() {\n}\n');
    expect(
      apply(GREETER, { type: 'addVariable', scope: '', name: 'count' })
    ).toContain('const user = "Jane";\nlet count;\n');
    expect(
      apply('import a from "a";\n\nrun();\n', {
        type: 'addVariable',
        scope: '',
        name: 'LIMIT',
        constant: true,
      })
    ).toBe('import a from "a";\n\nconst LIMIT = undefined;\n\nrun();\n');
    expect(apply('', { type: 'addFunction', scope: '', name: 'main' })).toBe(
      'function main() {\n}\n'
    );
  });

  it('adds a function after the given one', () => {
    const text = [
      'function a() {}',
      '',
      '/** Second. */',
      'export function b() {}',
      '',
      'function c() {}',
      '',
    ].join('\n');
    expect(
      apply(text, {
        type: 'addFunction',
        scope: '',
        name: 'f',
        after: 'function:a',
      })
    ).toBe(
      'function a() {}\n\nfunction f() {\n}\n\n/** Second. */\nexport function b() {}\n\nfunction c() {}\n'
    );
    expect(
      apply(text, {
        type: 'addFunction',
        scope: '',
        name: 'f',
        after: 'function:b',
      })
    ).toContain('export function b() {}\n\nfunction f() {\n}\n\nfunction c');
    // Not a declaration of the scope: after the last function, as before.
    expect(
      apply(text, {
        type: 'addFunction',
        scope: '',
        name: 'f',
        after: 'function:missing',
      })
    ).toBe(`${text}\nfunction f() {\n}\n`);
  });

  it('adds a method after the given one', () => {
    const text = 'class Cart {\n  add() {}\n\n  remove() {}\n}\n';
    expect(
      apply(text, {
        type: 'addFunction',
        scope: 'Cart',
        name: 'clear',
        after: 'method:Cart.add',
      })
    ).toBe(
      'class Cart {\n  add() {}\n\n  clear() {\n  }\n\n  remove() {}\n}\n'
    );
  });

  it('adds methods and fields to classes', () => {
    const text = 'class Cart {\n  items = [];\n\n  add() {}\n}\n';
    expect(
      apply(text, { type: 'addFunction', scope: 'Cart', name: 'clear' })
    ).toBe(
      'class Cart {\n  items = [];\n\n  add() {}\n\n  clear() {\n  }\n}\n'
    );
    expect(
      apply(text, { type: 'addVariable', scope: 'Cart', name: 'total' })
    ).toBe(
      'class Cart {\n  items = [];\n  total = undefined;\n\n  add() {}\n}\n'
    );
    expect(
      apply('class Empty {}\n', {
        type: 'addFunction',
        scope: 'Empty',
        name: 'run',
      })
    ).toBe('class Empty {\n  run() {\n  }\n}\n');
  });

  it('adds locals at the start of a function', () => {
    expect(
      apply(GREETER, {
        type: 'addVariable',
        scope: 'greeter',
        name: 'suffix',
        local: true,
      })
    ).toContain('{\n  let suffix;\n  const prefix');
  });

  it('rejects invalid and taken names', () => {
    expect(
      error(GREETER, { type: 'addFunction', scope: '', name: 'user' })
    ).toBe('"user" already exists here.');
    expect(
      error(GREETER, { type: 'addVariable', scope: '', name: 'class' })
    ).toBe('"class" is a reserved word.');
    expect(error(GREETER, { type: 'addVariable', scope: '', name: '1a' })).toBe(
      '"1a" is not a valid name.'
    );
  });
});

describe('renaming symbols', () => {
  it('renames a variable, its uses and keeps the export name', () => {
    expect(
      apply(GREETER, {
        type: 'renameSymbol',
        symbol: 'constant:user',
        name: 'name',
      })
    ).toBe(
      GREETER.replace('const user', 'const name')
        .replace('greeter(user)', 'greeter(name)')
        .replace('export { user }', 'export { name as user }')
    );
  });

  it('renames functions and locals, but not shadowed names', () => {
    const text = [
      'function total(items) {',
      '  let sum = 0;',
      '  const add = (sum) => sum + 1;',
      '  for (const item of items) { sum += item; }',
      '  return { sum, add };',
      '}',
      'total([]);',
      '',
    ].join('\n');
    const renamed = apply(text, {
      type: 'renameSymbol',
      symbol: 'local:total.sum',
      name: 'acc',
    });
    expect(renamed).toContain('let acc = 0;');
    expect(renamed).toContain('const add = (sum) => sum + 1;');
    expect(renamed).toContain('acc += item;');
    expect(renamed).toContain('return { sum: acc, add };');
    expect(
      apply(text, {
        type: 'renameSymbol',
        symbol: 'function:total',
        name: 'sumAll',
      })
    ).toBe(
      text
        .replace('function total', 'function sumAll')
        .replace('total([])', 'sumAll([])')
    );
  });

  it('renames types and class members', () => {
    const text = [
      'interface Item { name: string }',
      'class Cart {',
      '  items: Item[] = [];',
      '  add(item: Item) { this.items.push(item); }',
      '}',
      '',
    ].join('\n');
    expect(
      apply(text, {
        type: 'renameSymbol',
        symbol: 'type:Item',
        name: 'Product',
      })
    ).toBe(
      text
        .replaceAll('Item', 'Product')
        .replace('items: Product[]', 'items: Product[]')
    );
    expect(
      apply(text, {
        type: 'renameSymbol',
        symbol: 'variable:Cart.items',
        name: 'lines',
      })
    ).toBe(
      text
        .replace('items: Item[]', 'lines: Item[]')
        .replace('this.items', 'this.lines')
    );
  });
});

describe('deleting symbols', () => {
  it('removes the declaration with its comment and blank line', () => {
    const text = 'const a = 1;\n\n// The answer\nconst b = 42;\n\nrun(a);\n';
    expect(apply(text, { type: 'deleteSymbol', symbol: 'constant:b' })).toBe(
      'const a = 1;\n\nrun(a);\n'
    );
    expect(
      apply('export function f() {\n}\n\nf();\n', {
        type: 'deleteSymbol',
        symbol: 'function:f',
      })
    ).toBe('f();\n');
  });

  it('refuses variables declared together', () => {
    expect(
      error('let a, b;\n', { type: 'deleteSymbol', symbol: 'variable:a' })
    ).toBe('a is declared together with b; change it in the code.');
  });
});

describe('adding types', () => {
  it('adds an interface after the imports and types', () => {
    expect(
      apply("import { a } from './a';\n\nconst x = 1;\n", {
        type: 'addType',
        name: 'Item',
      })
    ).toBe("import { a } from './a';\n\ninterface Item {\n}\n\nconst x = 1;\n");
    expect(
      apply('interface A {\n}\n\nconst x = 1;\n', {
        type: 'addType',
        name: 'B',
      })
    ).toBe('interface A {\n}\n\ninterface B {\n}\n\nconst x = 1;\n');
    expect(apply('const x = 1;\n', { type: 'addType', name: 'C' })).toBe(
      'interface C {\n}\n\nconst x = 1;\n'
    );
  });

  it('adds a class when asked for one', () => {
    expect(
      apply('const x = 1;\n', { type: 'addType', name: 'Repo', kind: 'class' })
    ).toBe('class Repo {\n}\n\nconst x = 1;\n');
  });
});

/** Turns `optional` of field `name` (of `scope`) on or off. */
function optional(
  text: string,
  scope: string,
  name: string,
  enabled: boolean
): string {
  const field = parseTypeScript(text, 'test.ts').symbols?.find(
    (s) => s.scope === scope && s.name === name
  );
  return apply(text, {
    type: 'setModifier',
    symbol: field?.id ?? '',
    modifier: 'optional',
    enabled,
  });
}

describe('optional fields', () => {
  it('marks interface and class fields with `?`', () => {
    expect(
      optional('interface R {\n  branch: string;\n}\n', 'R', 'branch', true)
    ).toBe('interface R {\n  branch?: string;\n}\n');
    expect(
      optional('interface R {\n  branch?: string;\n}\n', 'R', 'branch', false)
    ).toBe('interface R {\n  branch: string;\n}\n');
    expect(
      optional('class C {\n  token!: string;\n}\n', 'C', 'token', true)
    ).toBe('class C {\n  token?: string;\n}\n');
  });

  it('knows optional fields', () => {
    const symbols =
      parseTypeScript(
        'interface R {\n  a?: string;\n}\nclass C {\n  b?: number;\n  c = 1;\n}\n',
        'test.ts'
      ).symbols ?? [];
    const of = (name: string): string[] =>
      symbols.find((s) => s.name === name)?.modifiers ?? [];
    expect(of('a')).toContain('optional');
    expect(of('b')).toContain('optional');
    expect(of('c')).not.toContain('optional');
  });

  it('refuses variables', () => {
    const text = 'let x = 1;\n';
    const x = parseTypeScript(text, 'test.ts').symbols?.find(
      (s) => s.name === 'x'
    );
    expect(
      error(text, {
        type: 'setModifier',
        symbol: x?.id ?? '',
        modifier: 'optional',
        enabled: true,
      })
    ).toBe('Only fields can be optional.');
  });
});
