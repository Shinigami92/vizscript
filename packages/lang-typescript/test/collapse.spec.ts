import type { GraphDocument } from '@vizscript/core';
import { applyTextEdits } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyTypeScriptOp, parseTypeScript } from '../src';

/** Ids of the statement nodes whose code starts with one of `starts`. */
function nodesStarting(
  doc: GraphDocument,
  text: string,
  starts: ReadonlyArray<string>
): string[] {
  return doc.functions
    .flatMap((f) => f.nodes)
    .filter(
      (n) =>
        n.purity === 'impure' &&
        starts.some((s) => text.slice(n.range.start).startsWith(s))
    )
    .map((n) => n.id);
}

function collapse(
  text: string,
  starts: ReadonlyArray<string>,
  name: string
): string {
  const doc = parseTypeScript(text, 't.ts');
  const result = applyTypeScriptOp(
    text,
    {
      type: 'collapseToFunction',
      nodes: nodesStarting(doc, text, starts),
      name,
    },
    't.ts'
  );
  if (!result.ok) {
    throw new Error(result.error);
  }

  return applyTextEdits(text, result.edits);
}

const TOTAL = [
  'function total(items: Item[], discount = 0): number {',
  '  let sum = 0;',
  '  for (const item of items) {',
  '    sum += item.price;',
  '  }',
  '  const discounted = sum - sum * discount;',
  '  return discounted;',
  '}',
  '',
].join('\n');

describe('collapse to function', () => {
  it('turns statements into a function with inputs and a result', () => {
    expect(collapse(TOTAL, ['let sum', 'for ('], 'sumPrices')).toBe(
      [
        'function total(items: Item[], discount = 0): number {',
        '  let sum = sumPrices(items);',
        '  const discounted = sum - sum * discount;',
        '  return discounted;',
        '}',
        '',
        'function sumPrices(items: Item[]) {',
        '  let sum = 0;',
        '  for (const item of items) {',
        '    sum += item.price;',
        '  }',
        '  return sum;',
        '}',
        '',
      ].join('\n')
    );
  });

  it('collapses statements without a result', () => {
    const text =
      'function greet(name: string) {\n  const text = `Hi ${name}`;\n  console.log(text);\n  done();\n}\n';
    expect(collapse(text, ['const text', 'console.log'], 'say')).toBe(
      'function greet(name: string) {\n  say(name);\n  done();\n}\n\nfunction say(name: string) {\n  const text = `Hi ${name}`;\n  console.log(text);\n}\n'
    );
  });

  it('makes methods and awaits async code', () => {
    const text = [
      'class Shop {',
      '  async load(url: string) {',
      '    const response = await fetch(url);',
      '    this.data = await response.json();',
      '  }',
      '}',
      '',
    ].join('\n');
    expect(collapse(text, ['const response', 'this.data'], 'fetchData')).toBe(
      [
        'class Shop {',
        '  async load(url: string) {',
        '    await this.fetchData(url);',
        '  }',
        '',
        '  async fetchData(url: string) {',
        '    const response = await fetch(url);',
        '    this.data = await response.json();',
        '  }',
        '}',
        '',
      ].join('\n')
    );
  });

  it('refuses a return in the selection', () => {
    expect(() =>
      collapse(TOTAL, ['const discounted', 'return'], 'finish')
    ).toThrow('The selection contains a return');
  });
});

describe('descriptions', () => {
  it('writes a new description as a doc comment', () => {
    const text = 'function greet(name: string) {\n  return name;\n}\n';
    const entry = parseTypeScript(text, 't.ts')
      .functions.find((f) => f.name === 'greet')
      ?.nodes.find((n) => n.kind === 'entry');
    const result = applyTypeScriptOp(
      text,
      {
        type: 'setComment',
        node: entry?.id ?? '',
        text: 'Says hello.',
        doc: true,
      },
      't.ts'
    );
    expect(result.ok && applyTextEdits(text, result.edits)).toBe(
      '/**\n * Says hello.\n */\nfunction greet(name: string) {\n  return name;\n}\n'
    );
  });
});

function toggle(
  text: string,
  symbol: string,
  modifier: string,
  enabled = true
): string {
  const result = applyTypeScriptOp(
    text,
    { type: 'setModifier', symbol, modifier, enabled },
    't.ts'
  );
  if (!result.ok) {
    throw new Error(result.error);
  }

  return applyTextEdits(text, result.edits);
}

describe('function settings', () => {
  it('exports functions and makes them async', () => {
    const text = 'function load() {}\n';
    const exported = toggle(text, 'function:load', 'export');
    expect(exported).toBe('export function load() {}\n');
    expect(toggle(exported, 'function:load', 'async')).toBe(
      'export async function load() {}\n'
    );
    expect(
      toggle(
        'export default function load() {}\n',
        'function:load',
        'export',
        false
      )
    ).toBe('function load() {}\n');
  });

  it('writes access, static and async of methods in order', () => {
    const text = 'class A {\n  run() {}\n}\n';
    const asyncRun = toggle(text, 'method:A.run', 'async');
    expect(asyncRun).toBe('class A {\n  async run() {}\n}\n');
    const staticRun = toggle(asyncRun, 'method:A.run', 'static');
    expect(staticRun).toBe('class A {\n  static async run() {}\n}\n');
    const privateRun = toggle(staticRun, 'method:A.run', 'private');
    expect(privateRun).toBe('class A {\n  private static async run() {}\n}\n');
    expect(toggle(privateRun, 'method:A.run', 'protected')).toBe(
      'class A {\n  protected static async run() {}\n}\n'
    );
    expect(toggle(privateRun, 'method:A.run', 'public')).toBe(
      'class A {\n  static async run() {}\n}\n'
    );
  });
});

describe('enum members', () => {
  it('lists the members of enums', () => {
    const doc = parseTypeScript("enum Mode { Light, Dark = 'dark' }\n", 't.ts');
    expect(doc.symbols?.find((s) => s.kind === 'enum')?.members).toEqual([
      'Light',
      'Dark',
    ]);
  });
});
