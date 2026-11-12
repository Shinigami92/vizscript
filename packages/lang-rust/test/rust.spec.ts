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
});
