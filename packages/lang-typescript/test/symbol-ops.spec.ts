import type { GraphOp } from '@vizscript/core';
import { applyTextEdits } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyTypeScriptOp } from '../src';

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
  it('adds functions at the end and variables after the last one', () => {
    expect(
      apply(GREETER, { type: 'addFunction', scope: '', name: 'farewell' })
    ).toBe(`${GREETER}\nfunction farewell() {\n}\n`);
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
});
