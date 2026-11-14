import type { GraphDocument, Pin } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { parseRustDocument } from '../src';

const TEXT = `use std::collections::HashMap;

struct Item {
    name: String,
    price: f64,
    tags: Vec<String>,
}

enum Size {
    Small,
    Big,
}

impl Item {
    fn new(name: &str) -> Self {
        Item { name: name.to_string(), price: 1.0, tags: vec![] }
    }

    fn label(&self) -> String {
        format!("{} ({})", self.name.to_uppercase(), self.tags.len())
    }
}

async fn load(id: u32) -> Option<Item> {
    None
}

async fn run(items: &[Item], counts: HashMap<String, u32>) {
    let first = items.first();
    let size = Size::Big;
    let count = counts.get("a");
    let doubled = items.len() * 2;
    let prices: Vec<f64> = items.iter().map(|i| i.price).collect();
    let total = prices.iter().sum::<f64>();
    if let Some(item) = first {
        println!("{}", item.label());
    }
    for (index, item) in items.iter().enumerate() {
        let name = item.name.trim();
        let loaded = load(index as u32).await;
        println!("{} {:?}", name, loaded.is_some());
    }
    let rounded = (total * 1.5).round();
}
`;

function outputs(doc: GraphDocument): Map<string, Pin> {
  const pins = new Map<string, Pin>();
  for (const node of doc.functions.flatMap((f) => f.nodes)) {
    for (const pin of node.pins) {
      if (pin.range && pin.direction === 'out' && pin.kind === 'data') {
        pins.set(TEXT.slice(pin.range.start, pin.range.end), pin);
      }
    }
  }

  return pins;
}

describe('the Rust type lookup', () => {
  const doc = parseRustDocument(TEXT, 'shop.rs');
  const pins = outputs(doc);
  const typeOf = (code: string): string | undefined => pins.get(code)?.typeText;

  it('follows lets, fields, methods and standard types', () => {
    expect(typeOf('items.first()')).toBe('Option<Item>');
    expect(typeOf('counts.get("a")')).toBe('Option<u32>');
    expect(typeOf('items.len() * 2')).toBe('usize');
    expect(typeOf('prices.iter().sum::<f64>()')).toBe('f64');
    expect(typeOf('item.label()')).toBe('String');
    expect(typeOf('item.name.trim()')).toBe('str');
    expect(typeOf('load(index as u32).await')).toBe('Option<Item>');
    expect(typeOf('loaded.is_some()')).toBe('bool');
    expect(typeOf('(total * 1.5).round()')).toBe('f64');
    expect(typeOf('self.tags.len()')).toBe('usize');
  });

  it('types the names of lets and patterns', () => {
    const symbols = doc.symbols ?? [];
    const type = (name: string): unknown =>
      symbols.find((s) => s.name === name)?.dataType;
    expect(type('first')).toBe('Item');
    expect(type('size')).toBe('Size');
    expect(type('doubled')).toBe('number');
    expect(type('total')).toBe('number');
    expect(type('index')).toBe('number');
    expect(type('name')).toBe('string');
  });

  it('drops results of macros that give nothing', () => {
    const prints = doc.functions
      .flatMap((f) => f.nodes)
      .filter((n) => n.title === 'println!');
    expect(prints.length).toBe(2);
    expect(
      prints.flatMap((n) => n.pins.filter((p) => p.id === 'return'))
    ).toEqual([]);
  });

  it('lists methods of standard types for the action menu', () => {
    expect(
      doc.typeMembers?.['Option<Item>']?.find((m) => m.name === 'unwrap')
    ).toMatchObject({
      kind: 'method',
      type: 'Item',
      detail: 'unwrap() -> Item',
    });
  });

  it('names and types the arguments of std methods', () => {
    const get = doc.functions
      .flatMap((f) => f.nodes)
      .find((n) => n.title === 'get');
    expect(
      get?.pins
        .filter((p) => p.direction === 'in' && p.kind === 'data')
        .map((p) => [p.id, p.name, p.type])
    ).toEqual([
      ['target', 'self', 'object'],
      ['arg0', 'key', 'string'],
    ]);
  });
});
