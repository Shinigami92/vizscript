import { summarizeSymbols } from '@vizscript/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTypeScript } from '../src';

function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
}

describe('typeScriptSymbols', () => {
  it('lists the declarations of the fixtures', () => {
    for (const name of ['greeter.ts', 'exports.ts', 'control-flow.ts']) {
      expect(
        summarizeSymbols(parseTypeScript(fixture(name), name))
      ).toMatchSnapshot(name);
    }
  });

  it('covers classes, types, locals and parameters', () => {
    const text = [
      'interface Item { name: string }',
      'type Id = string | number;',
      'enum Color { Red, Green }',
      'export class Cart<T> extends Base {',
      '  static count = 0;',
      '  private items: Item[] = [];',
      '  #secret = "x";',
      '  get size(): number { return this.items.length; }',
      '  async add(item: Item, ...rest: Item[]): Promise<void> {',
      '    const total = this.items.length + 1;',
      '    for (const other of rest) { let seen = true; }',
      '    const inner = () => { const hidden = 1; };',
      '  }',
      '}',
      'function greet({ name }: Item, times = 2) {}',
      'let counter;',
    ].join('\n');
    expect(summarizeSymbols(parseTypeScript(text, 'cart.ts')))
      .toMatchInlineSnapshot(`
      "type Item ~Item [interface]
      type Id ~Id [type]
      enum Color ~Color
      class Cart ~Cart [export]
      variable Cart::count ~number = … [static]
      variable Cart::items: Item[] = … [private]
      variable Cart::#secret ~string = …
      method Cart::size.get(): number [get] → Cart.size
      method Cart::add(item: Item, ...rest: Item[]): Promise<void> [async] → Cart.add
      local Cart.add::total = … [const]
      local Cart.add::other [const]
      local Cart.add::seen ~bool = … [let]
      local Cart.add::inner ~function = … [const]
      function greet({ name }: Item, times = …) → greet
      variable counter [let]"
    `);
  });
});
