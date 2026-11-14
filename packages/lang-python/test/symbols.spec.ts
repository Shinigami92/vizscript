import { summarizeSymbols } from '@vizscript/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePythonDocument } from '../src';

describe('pythonSymbols', () => {
  it('lists the declarations of the fixture', () => {
    const shop = readFileSync(
      join(import.meta.dirname, 'fixtures', 'shop.py'),
      'utf8'
    );
    expect(
      summarizeSymbols(parsePythonDocument(shop, 'shop.py'))
    ).toMatchSnapshot();
  });

  it('covers classes, enums, instance variables and locals', () => {
    const text = [
      'from enum import Enum',
      'MAX_ITEMS = 10',
      'name: str = "shop"',
      'class Color(Enum):',
      '    RED = 1',
      'class Cart:',
      '    count: int = 0',
      '    def __init__(self, owner: str):',
      '        self.owner = owner',
      '        self.items: list[str] = []',
      '    @staticmethod',
      '    def create(*args, **kwargs) -> "Cart":',
      '        total = 0',
      '        for item in args:',
      '            seen = True',
      '        a, b = 1, 2',
      '        return Cart("x")',
      'async def load(path, retries=3):',
      '    pass',
    ].join('\n');
    expect(summarizeSymbols(parsePythonDocument(text, 'cart.py')))
      .toMatchInlineSnapshot(`
        "import Enum ← Enum of enum
        constant MAX_ITEMS ~number = …
        variable name: str = …
        enum Color ~Color
        constant Color::RED ~number = …
        class Cart ~Cart → Cart
        variable Cart::count: int = …
        method Cart::__init__(owner: str) → Cart.__init__
        variable Cart::owner ~string = … [self.]
        variable Cart::items: list[str] = … [self.]
        method Cart::create(...args, ...kwargs): "Cart" [@staticmethod] → Cart.create
        local Cart.create::total ~number = …
        local Cart.create::item
        local Cart.create::seen ~bool = …
        local Cart.create::a ~number
        local Cart.create::b ~number
        function load(path, retries = …) [async] → load"
      `);
  });
});
