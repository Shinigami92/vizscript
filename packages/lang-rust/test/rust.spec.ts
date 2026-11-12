import type { GraphDocument, GraphOp } from '@vizscript/core';
import { applyTextEdits, summarizeGraph } from '@vizscript/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyRustOp, dataTypeOf, parseRust, parseRustDocument } from '../src';

const shop = readFileSync(
  join(import.meta.dirname, 'fixtures', 'shop.rs'),
  'utf8'
);

function apply(text: string, op: GraphOp): string {
  const result = applyRustOp(text, op, 'src/main.rs');
  if (!result.ok) {
    throw new Error(result.error);
  }

  return applyTextEdits(text, result.edits);
}

function fn(doc: GraphDocument, name: string) {
  const found = doc.functions.find((f) => f.name === name);
  if (!found) {
    throw new Error(`no function ${name}`);
  }

  return found;
}

describe('parseRust', () => {
  it('parses the fixture without diagnostics', () => {
    const { items, diagnostics } = parseRust(shop);
    expect(diagnostics).toEqual([]);
    expect(items.map((s) => s.type)).toEqual([
      'Use',
      'Use',
      'Const',
      'Struct',
      'Impl',
      'Function',
      'Function',
      'Function',
      'Function',
    ]);
  });

  it('accepts a reference before a let chain', () => {
    const text = [
      'fn f(node: &Node) {',
      '    if let Some(a) = &node.children',
      '        && let Some(b) = a.last()',
      '    {',
      '        b.go();',
      '    }',
      '}',
      '',
    ].join('\n');
    expect(parseRust(text).diagnostics).toEqual([]);
  });

  it('reports real syntax errors', () => {
    expect(parseRust('fn f( {\n}\n').diagnostics.length).toBeGreaterThan(0);
  });
});

describe('dataTypeOf', () => {
  it('maps Rust types to pin types', () => {
    expect(dataTypeOf('i32')).toBe('number');
    expect(dataTypeOf('&str')).toBe('string');
    expect(dataTypeOf("&'static str")).toBe('string');
    expect(dataTypeOf('String')).toBe('string');
    expect(dataTypeOf('bool')).toBe('bool');
    expect(dataTypeOf('Vec<Item>')).toBe('Item[]');
    expect(dataTypeOf('&[Item]')).toBe('Item[]');
    expect(dataTypeOf('Option<f64>')).toBe('number');
    expect(dataTypeOf('HashMap<String, f64>')).toBe('object');
    expect(dataTypeOf('()')).toBe('void');
    expect(dataTypeOf('Self', 'Item')).toBe('Item');
    expect(dataTypeOf('crate::Item')).toBe('Item');
  });
});

describe('parseRustDocument', () => {
  it('lowers the fixture', () => {
    expect(
      summarizeGraph(parseRustDocument(shop, 'shop.rs'))
    ).toMatchSnapshot();
  });

  it('returns the last expression of a function', () => {
    const doc = parseRustDocument(shop, 'shop.rs');
    const total = fn(doc, 'Item::total');
    const ret = total.nodes.find((n) => n.kind === 'return');
    expect(ret?.pins.find((p) => p.id === 'value')?.range).toBeDefined();
    const labels = fn(doc, 'label');
    expect(labels.nodes.filter((n) => n.kind === 'return')).toHaveLength(3);
  });

  it('casts the rightmost operand of a binary expression', () => {
    const text = 'fn f(a: f64, b: u32) -> f64 {\n    a * b as f64\n}\n';
    const doc = parseRustDocument(text, 'main.rs');
    const nodes = fn(doc, 'f').nodes;
    const times = nodes.find((n) => n.title === '*');
    const cast = nodes.find((n) => n.title === 'as f64');
    const end = text.indexOf('\n}');
    expect(times?.range).toEqual({ start: text.indexOf('a *'), end });
    expect(cast?.range).toEqual({ start: text.indexOf('b as'), end });
    expect(
      fn(doc, 'f').edges.some(
        (e) => e.from.node === cast?.id && e.to.node === times?.id
      )
    ).toBe(true);
  });

  it('shows todo!() as an empty input, not a call', () => {
    const doc = parseRustDocument(
      'fn f() -> f64 {\n    todo!() * 2.0\n}\n',
      'main.rs'
    );
    const nodes = fn(doc, 'f').nodes;
    expect(nodes.some((n) => n.title === 'todo!')).toBe(false);
    const times = nodes.find((n) => n.title === '*');
    expect(times?.pins.find((p) => p.id === 'a')?.literal?.kind).toBe(
      'undefined'
    );
  });

  it('collects symbols', () => {
    const doc = parseRustDocument(shop, 'shop.rs');
    expect(
      doc.symbols?.map(
        (s) =>
          `${s.kind} ${s.scope ? `${s.scope}.` : ''}${s.name}: ${s.dataType}`
      )
    ).toMatchSnapshot();
  });
});

describe('applyRustOp', () => {
  it('edits a literal', () => {
    const doc = parseRustDocument(shop, 'shop.rs');
    const main = fn(doc, 'main');
    const call = main.nodes.find((n) => n.title === 'println!');
    if (!call) {
      throw new Error('no println');
    }

    const next = apply(shop, {
      type: 'setLiteral',
      node: call.id,
      pin: 'arg0',
      value: 'Sum: {} €',
    });
    expect(next).toContain('println!("Sum: {} €", total_price(&cart, 0.1));');
  });

  it('adds a statement after another', () => {
    const doc = parseRustDocument(shop, 'shop.rs');
    const main = fn(doc, 'main');
    const set = main.nodes.find((n) => n.title === 'Set cart');
    if (!set) {
      throw new Error('no Set cart');
    }

    const next = apply(shop, {
      type: 'addNode',
      template: { type: 'call', callee: 'println!', args: ['"start"'] },
      after: { node: set.id, pin: 'then' },
    });
    expect(next).toContain(
      'Item::new("Cable", 4.5)];\n    println!("start");\n'
    );
  });

  it('deletes a statement', () => {
    const doc = parseRustDocument(shop, 'shop.rs');
    const main = fn(doc, 'main');
    const set = main.nodes.find((n) => n.title === 'Set by_name');
    if (!set) {
      throw new Error('no Set by_name');
    }

    const next = apply(shop, { type: 'deleteNodes', nodeIds: [set.id] });
    expect(next).not.toContain('by_name');
    expect(parseRust(next).diagnostics).toEqual([]);
  });

  it('switches an assignment operator', () => {
    const doc = parseRustDocument(shop, 'shop.rs');
    const set = fn(doc, 'total_price').nodes.find(
      (n) => n.title === 'Set total' && n.subtitle === '+='
    );
    if (!set) {
      throw new Error('no Set total');
    }

    expect(
      apply(shop, { type: 'setAssignOperator', node: set.id, operator: '-=' })
    ).toContain('total -= item.total();');
  });

  it('adds functions, methods, fields and types', () => {
    let text = apply(shop, { type: 'addFunction', scope: '', name: 'helper' });
    expect(text.endsWith('\n\nfn helper() {\n}\n')).toBe(true);
    text = apply(text, { type: 'addFunction', scope: 'Item', name: 'clear' });
    expect(text).toContain(
      '        self.price * self.quantity as f64\n    }\n\n    fn clear(&self) {\n    }\n}'
    );
    text = apply(text, { type: 'addVariable', scope: 'Item', name: 'tag' });
    expect(text).toContain('    quantity: u32,\n    tag: i32,\n}');
    text = apply(text, { type: 'addType', name: 'Order' });
    expect(text).toContain('}\n\nstruct Order {\n}');
    expect(parseRust(text).diagnostics).toEqual([]);
  });

  it('renames a local and its uses', () => {
    const doc = parseRustDocument(shop, 'shop.rs');
    const total = doc.symbols?.find(
      (s) => s.kind === 'local' && s.name === 'total'
    );
    if (!total) {
      throw new Error('no local total');
    }

    const next = apply(shop, {
      type: 'renameSymbol',
      symbol: total.id,
      name: 'sum',
    });
    expect(next).toContain('let mut sum = 0.0;');
    expect(next).toContain('sum += item.total();');
    expect(next).toContain('let discounted = sum - sum * discount;');
  });

  it('renames a struct field with its shorthand', () => {
    const doc = parseRustDocument(shop, 'shop.rs');
    const price = doc.symbols?.find((s) => s.id === 'variable:Item.price');
    if (!price) {
      throw new Error('no field price');
    }

    const next = apply(shop, {
      type: 'renameSymbol',
      symbol: price.id,
      name: 'cost',
    });
    expect(next).toContain('pub cost: f64,');
    expect(next).toContain(
      'Self { name: name.to_string(), cost: price, quantity: 1 }'
    );
    expect(next).toContain('self.cost * self.quantity');
  });

  it('switches function qualifiers in order', () => {
    const doc = parseRustDocument(shop, 'shop.rs');
    const find = doc.symbols?.find((s) => s.id === 'function:find');
    if (!find) {
      throw new Error('no find');
    }

    let next = apply(shop, {
      type: 'setModifier',
      symbol: find.id,
      modifier: 'unsafe',
      enabled: true,
    });
    expect(next).toContain('pub unsafe fn find(');
    next = apply(next, {
      type: 'setModifier',
      symbol: find.id,
      modifier: 'async',
      enabled: true,
    });
    expect(next).toContain('pub async unsafe fn find(');
    next = apply(next, {
      type: 'setModifier',
      symbol: find.id,
      modifier: 'pub',
      enabled: false,
    });
    expect(next).toContain('\nasync unsafe fn find(');
  });

  it('collapses statements into a function with a result type', () => {
    const text = [
      'struct Item {',
      '    price: f64,',
      '}',
      '',
      'fn main() {',
      '    let cart = vec![Item { price: 1.0 }];',
      '    println!("{}", cart.len());',
      '}',
      '',
    ].join('\n');
    const doc = parseRustDocument(text, 'main.rs');
    const nodes = fn(doc, 'main')
      .nodes.filter(
        (n) =>
          n.purity === 'impure' &&
          text.slice(n.range.start).startsWith('let cart')
      )
      .map((n) => n.id);
    const next = apply(text, {
      type: 'collapseToFunction',
      nodes,
      name: 'make_cart',
    });
    expect(next).toContain('    let cart = make_cart();\n');
    expect(next).toContain(
      'fn make_cart() -> Vec<Item> {\n    let cart = vec![Item { price: 1.0 }];\n    cart\n}'
    );
  });

  it('adds a return with a value when a function gets a result', () => {
    const text = 'fn f() {\n    println!("x");\n}\n';
    const next = apply(text, {
      type: 'setReturnType',
      symbol: 'function:f',
      typeText: 'f64',
    });
    expect(next).toBe(
      'fn f() -> f64 {\n    println!("x");\n    return todo!();\n}\n'
    );
  });

  it('keeps a float literal a float', () => {
    const text = 'fn f(a: f64) -> f64 {\n    a * 1.5\n}\n';
    const doc = parseRustDocument(text, 'main.rs');
    const times = fn(doc, 'f').nodes.find((n) => n.title === '*');
    if (!times) {
      throw new Error('no *');
    }

    expect(
      apply(text, { type: 'setLiteral', node: times.id, pin: 'b', value: '2' })
    ).toContain('a * 2.0\n');
  });

  it('leaves todo!() when the value of a function is deleted', () => {
    const text = [
      "fn label(n: usize) -> &'static str {",
      '    match n {',
      '        0 => "empty",',
      '        _ => "some",',
      '    }',
      '}',
      '',
    ].join('\n');
    const doc = parseRustDocument(text, 'main.rs');
    const nodes = fn(doc, 'label').nodes.filter((n) => n.kind !== 'entry');
    expect(
      apply(text, { type: 'deleteNodes', nodeIds: nodes.map((n) => n.id) })
    ).toBe("fn label(n: usize) -> &'static str {\n    todo!()\n}\n");
  });

  it('deletes the impl blocks of a deleted struct', () => {
    const text = [
      'use std::fmt;',
      '',
      'struct Item {',
      '    price: f64,',
      '}',
      '',
      'impl Item {',
      '    fn total(&self) -> f64 {',
      '        self.price',
      '    }',
      '}',
      '',
      'impl fmt::Display for Item {',
      '    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {',
      '        write!(f, "{}", self.price)',
      '    }',
      '}',
      '',
      'fn main() {',
      '}',
      '',
    ].join('\n');
    expect(apply(text, { type: 'deleteSymbol', symbol: 'class:Item' })).toBe(
      'use std::fmt;\n\nfn main() {\n}\n'
    );
  });

  it('leaves no blank lines in an emptied impl block', () => {
    const text = [
      'struct Item {}',
      '',
      'impl Item {',
      '    fn a(&self) {',
      '    }',
      '',
      '    fn b(&self) {',
      '    }',
      '}',
      '',
    ].join('\n');
    let next = apply(text, { type: 'deleteSymbol', symbol: 'method:Item.b' });
    expect(next).toContain('impl Item {\n    fn a(&self) {\n    }\n}');
    next = apply(text, { type: 'deleteSymbol', symbol: 'method:Item.a' });
    expect(next).toContain('impl Item {\n    fn b(&self) {\n    }\n}');
  });

  it('wires an if let binding only inside its block', () => {
    const text = [
      'fn main() {',
      '    let cart = vec![1];',
      '    if let Some(first) = cart.first() {',
      '        println!("{}", 1);',
      '    }',
      '    println!("{}", 2);',
      '}',
      '',
    ].join('\n');
    const nodes = fn(parseRustDocument(text, 'main.rs'), 'main').nodes;
    const ifLet = nodes.find((n) => n.title === 'If Let');
    const [inside, after] = nodes.filter((n) => n.title === 'println!');
    if (!ifLet || !inside || !after) {
      throw new Error('missing nodes');
    }

    const from = { node: ifLet.id, pin: 'bind0' };
    expect(
      apply(text, {
        type: 'connect',
        from,
        to: { node: inside.id, pin: 'arg1' },
      })
    ).toContain('println!("{}", first);\n    }');
    const outside = applyRustOp(text, {
      type: 'connect',
      from,
      to: { node: after.id, pin: 'arg1' },
    });
    expect(outside).toEqual({
      ok: false,
      error: 'first only exists inside its block.',
    });
  });

  it('types struct fields without a default value', () => {
    const text = 'struct Item {\n    name: i32,\n}\n';
    const next = apply(text, {
      type: 'setSymbolType',
      symbol: 'variable:Item.name',
      typeText: 'String',
      defaultValue: 'String::new()',
    });
    expect(next).toBe('struct Item {\n    name: String,\n}\n');
    expect(
      applyRustOp(text, {
        type: 'setSymbolValue',
        symbol: 'variable:Item.name',
        value: '1',
        kind: 'expression',
      }).ok
    ).toBe(false);
    expect(
      applyRustOp(text, {
        type: 'setSymbolType',
        symbol: 'variable:Item.name',
        typeText: null,
      }).ok
    ).toBe(false);
  });

  it('gives new inputs a type', () => {
    const text = 'fn f(a: u8) {\n}\n\nfn main() {\n    f(1);\n}\n';
    const next = apply(text, {
      type: 'addParameter',
      symbol: 'function:f',
      name: 'b',
    });
    expect(next).toContain('fn f(a: u8, b: i32) {');
    expect(next).toContain('f(1, todo!());');
    expect(
      applyRustOp(next, {
        type: 'setParameterType',
        symbol: 'function:f',
        index: 1,
        typeText: null,
      }).ok
    ).toBe(false);
  });

  it('updates calls inside macro arguments', () => {
    const text = [
      'fn total(a: f64, b: f64) -> f64 {',
      '    a + b',
      '}',
      '',
      'fn main() {',
      '    println!("{}", total(1.0, 2.0));',
      '}',
      '',
    ].join('\n');
    const next = apply(text, {
      type: 'removeParameter',
      symbol: 'function:total',
      index: 1,
    });
    expect(next).toContain('println!("{}", total(1.0));');
  });

  it('renames fields, methods and types inside macro arguments', () => {
    const text = [
      'struct Item {',
      '    quantity: u32,',
      '}',
      '',
      'impl Item {',
      '    fn total(&self) -> u32 {',
      '        self.quantity',
      '    }',
      '}',
      '',
      'fn main() {',
      '    let items = vec![Item { quantity: 1 }];',
      '    println!("{} {}", items[0].quantity, items[0].total());',
      '}',
      '',
    ].join('\n');
    let next = apply(text, {
      type: 'renameSymbol',
      symbol: 'variable:Item.quantity',
      name: 'qty',
    });
    expect(next).toContain('items[0].qty, items[0].total()');
    expect(next).toContain('vec![Item { qty: 1 }]');
    next = apply(next, {
      type: 'renameSymbol',
      symbol: 'method:Item.total',
      name: 'sum',
    });
    expect(next).toContain('items[0].qty, items[0].sum()');
    next = apply(next, {
      type: 'renameSymbol',
      symbol: 'class:Item',
      name: 'Line',
    });
    expect(next).toContain('vec![Line { qty: 1 }]');
  });
});
