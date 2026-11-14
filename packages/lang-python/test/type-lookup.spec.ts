import type { GraphDocument, ImportedDeclaration, Pin } from '@vizscript/core';
import { portableSymbols } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { parsePythonDocument, pythonLibrary } from '../src';

const TEXT = `import json
from dataclasses import dataclass


class Item:
    def __init__(self, name: str, price: float):
        self.name = name
        self.price = price
        self.tags = ["new"]

    def total(self, quantity: int) -> float:
        return self.price * quantity


async def load(path: str) -> list[Item]:
    return []


async def main(paths: list[str]):
    items = await load(paths[0])
    first = items[0]
    label = first.name.upper()
    words = label.split(" ")
    count = len(words) + 1
    ratio = count / 2
    for index, word in enumerate(words):
        print(index, word.strip())
    prices = {"a": 1.5, "b": 2.0}
    cheap = prices.get("a")
    data = json.dumps(prices)
    print(first.total(2), cheap, data, ratio)
`;

/** Declarations of `import json`, as the web app reads them. */
function jsonImport(): ImportedDeclaration {
  const stub = pythonLibrary('json');
  if (!stub) {
    throw new Error('no json stub');
  }

  const doc = parsePythonDocument(stub.text, stub.fileName);
  return {
    name: 'json',
    members: portableSymbols(doc.symbols ?? [], stub.text),
  };
}

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

describe('the Python type lookup', () => {
  const doc = parsePythonDocument(TEXT, 'shop.py', {
    imports: [jsonImport()],
  });
  const pins = outputs(doc);
  const typeOf = (code: string): string | undefined => pins.get(code)?.typeText;

  it('follows assignments, classes, built-ins and imports', () => {
    expect(typeOf('await load(paths[0])')).toBe('list[Item]');
    expect(typeOf('items[0]')).toBe('Item');
    expect(typeOf('first.name.upper()')).toBe('str');
    expect(typeOf('label.split(" ")')).toBe('list[str]');
    expect(typeOf('len(words) + 1')).toBe('int');
    expect(typeOf('count / 2')).toBe('float');
    expect(typeOf('word.strip()')).toBe('str');
    expect(typeOf('prices.get("a")')).toBe('float');
    expect(typeOf('json.dumps(prices)')).toBe('str');
    expect(typeOf('first.total(2)')).toBe('float');
    expect(typeOf('self.price * quantity')).toBe('float');
  });

  it('types untyped declarations and instance fields', () => {
    const symbols = doc.symbols ?? [];
    const type = (name: string): unknown =>
      symbols.find((s) => s.name === name)?.dataType;
    expect(type('price')).toBe('number');
    expect(type('tags')).toBe('string[]');
    expect(type('first')).toBe('Item');
    expect(type('index')).toBe('number');
    expect(type('word')).toBe('string');
    expect(type('prices')).toBe('object');
  });

  it('drops results of functions that return None', () => {
    const prints = doc.functions
      .flatMap((f) => f.nodes)
      .filter((n) => n.title === 'print');
    expect(prints.length).toBe(2);
    expect(
      prints.flatMap((n) => n.pins.filter((p) => p.id === 'return'))
    ).toEqual([]);
  });

  it('lists members of built-in types for the action menu', () => {
    expect(doc.typeMembers?.str?.find((m) => m.name === 'split')).toMatchObject(
      {
        kind: 'method',
        type: 'string[]',
        detail: 'split(sep: str = None, maxsplit: int = -1) -> list[str]',
      }
    );
    expect(
      doc.typeMembers?.['dict[str, float]']?.find((m) => m.name === 'get')?.type
    ).toBe('number');
  });

  it('gives method calls a pin per parameter', () => {
    const strip = doc.functions
      .flatMap((f) => f.nodes)
      .find((n) => n.title === 'strip');
    expect(
      strip?.pins
        .filter(
          (p) => p.direction === 'in' && p.kind === 'data' && p.id !== 'target'
        )
        .map((p) => [p.id, p.type, p.literal?.value])
    ).toEqual([['param:chars', 'string', 'None']]);
  });
});
