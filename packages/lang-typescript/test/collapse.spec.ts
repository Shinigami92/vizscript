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
