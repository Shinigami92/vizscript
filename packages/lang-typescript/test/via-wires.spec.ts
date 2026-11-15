import type { GraphDocument, GraphNode } from '@vizscript/core';
import {
  adjacentVias,
  foldVias,
  joinKey,
  keptWrapped,
  nodeKey,
  reconcileVias,
  viaGets,
  viaJoins,
  viaSetter,
  wrappedVias,
} from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { parseTypeScript } from '../src';

function node(doc: GraphDocument, title: string): GraphNode {
  const found = doc.functions
    .flatMap((f) => f.nodes)
    .find((n) => n.title === title);
  if (!found) {
    throw new Error(`no ${title}`);
  }

  return found;
}

const SOURCES = new WeakMap<GraphDocument, string>();
function parse(source: string): GraphDocument {
  const doc = parseTypeScript(source, 'a.ts');
  SOURCES.set(doc, source);
  return doc;
}

function codeOf(doc: GraphDocument, n: GraphNode): string {
  return (SOURCES.get(doc) ?? '').slice(n.range.start, n.range.end);
}

describe('wires from a SET (UE)', () => {
  const text = 'const rate = 0.19;\nconst item = { price: rate };\n';

  it('draws a remembered Get as a wire from the SET output', () => {
    const doc = parseTypeScript(text, 'a.ts');
    const get = node(doc, 'rate');
    const setter = node(doc, 'Set rate');
    const drawn = foldVias(doc, new Set([get.id]));
    const fn = drawn.functions[0];
    expect(fn?.nodes.some((n) => n.id === get.id)).toBe(false);
    expect(fn?.edges.find((e) => e.via === get.id)?.from).toEqual({
      node: setter.id,
      pin: 'out',
    });
  });

  it('keeps Gets without a SET before them', () => {
    const doc = parseTypeScript(
      'const item = { price: rate };\nconst rate = 0.19;\n',
      'a.ts'
    );
    const get = node(doc, 'rate');
    const fn = doc.functions[0];
    expect(fn && viaSetter(fn, get)).toBeUndefined();
    expect(foldVias(doc, new Set([get.id]))).toBe(doc);
  });

  it('draws a Get right after its SET as a wire, like UE', () => {
    const doc = parseTypeScript(
      'const cart = [];\nconst total = totalPrice(cart, 0.1);\n',
      'a.ts'
    );
    expect(adjacentVias(doc)).toEqual(new Set([node(doc, 'cart').id]));
  });

  it('draws a Get through pure nodes of the next node as a wire', () => {
    const doc = parseTypeScript(
      'async function f(): Promise<void> {\n  const response = await fetch("x");\n  if (!response.ok) {\n    return;\n  }\n}\n',
      'a.ts'
    );
    expect(adjacentVias(doc)).toEqual(new Set([node(doc, 'response').id]));
  });

  it('draws reads after a loop from the loop, not from before it', () => {
    const doc = parse(
      'let total = 0;\nfor (const item of items) {\n  total += item;\n}\nlog(total);\n'
    );
    const fn = doc.functions[0];
    const read = node(doc, 'total');
    expect(adjacentVias(doc)).toEqual(new Set([read.id]));
    // `total += item`, a SET without a declaration keyword.
    const setter = fn && viaSetter(fn, read);
    expect(setter && codeOf(doc, setter)).toBe('total += item;');
  });

  it('draws reads after a loop from the SET that ends its body', () => {
    const doc = parseTypeScript(
      'function f(items: number[]): number {\n  let total = 0;\n  for (const item of items) {\n    total += item;\n  }\n  const half = total - total / 2;\n  return half;\n}\n',
      'a.ts'
    );
    const reads = doc.functions
      .flatMap((f) => f.nodes)
      .filter((n) => n.kind === 'getVar' && n.title === 'total');
    expect(reads).toHaveLength(2);
    const vias = adjacentVias(doc);
    expect(reads.every((n) => vias.has(n.id))).toBe(true);
  });

  it('draws reads on a wrapped row as one Get node, not wires back', () => {
    const doc = parseTypeScript(
      'function f(items: number[]): number {\n  let total = 0;\n  for (const item of items) {\n    total += item;\n  }\n  const half = total - total / 2;\n  return half;\n}\n',
      'a.ts'
    );
    const fn = doc.functions.find((f) => f.name === 'f');
    const reads = (fn?.nodes ?? []).filter(
      (n) => n.kind === 'getVar' && n.title === 'total'
    );
    const [first, second] = reads;
    const setter = fn && first ? viaSetter(fn, first) : undefined;
    if (!fn || !first || !second || !setter) {
      throw new Error('no reads of total');
    }

    // The generated layout wrapped the code after the loop to a new row:
    // the SET is right of the reads, the second read is the leftmost.
    const layout = {
      [setter.id]: { x: 900, y: 0 },
      [first.id]: { x: 300, y: 200 },
      [second.id]: { x: 100, y: 260 },
    };
    const vias = adjacentVias(doc, layout);
    expect(vias.has(first.id) || vias.has(second.id)).toBe(false);
    expect(wrappedVias(doc, layout)).toEqual(
      new Map([
        [second.id, second.id],
        [first.id, second.id],
      ])
    );

    const drawn = foldVias(doc, new Set(), new Map(), layout).functions.find(
      (f) => f.name === 'f'
    );
    const shown = drawn?.nodes.filter(
      (n) => n.kind === 'getVar' && n.title === 'total'
    );
    expect(shown?.map((n) => n.id)).toEqual([second.id]);
    expect(drawn?.edges.filter((e) => e.from.node === second.id)).toHaveLength(
      2
    );

    // A read the user wired from the SET stays that wire.
    const remembered = foldVias(
      doc,
      new Set([first.id]),
      new Map(),
      layout
    ).functions.find((f) => f.name === 'f');
    expect(
      remembered?.edges.some(
        (e) => e.from.node === setter.id && e.via === first.id
      )
    ).toBe(true);
  });

  it('keeps the shared Get of wrapped reads after an edit', () => {
    const doc = parseTypeScript(
      'function f(items: number[]): number {\n  let total = 0;\n  for (const item of items) {\n    total += item;\n  }\n  const half = total - total / 2;\n  return half;\n}\n',
      'a.ts'
    );
    const reads = doc.functions
      .flatMap((f) => f.nodes)
      .filter((n) => n.kind === 'getVar' && n.title === 'total');
    const [first, second] = reads;
    if (!first || !second) {
      throw new Error('no reads of total');
    }

    const before = new Map([
      [second.id, second.id],
      [first.id, second.id],
    ]);
    // The edited graph's generated layout no longer wraps (no layout):
    // the reads would become wires, but their nodes stay where they are.
    expect(keptWrapped(before, doc, new Map(), {})).toEqual({
      [nodeKey(second.id)]: { x: 0, y: 0 },
      [joinKey(first.id, second.id)]: { x: 0, y: 0 },
    });
    const drawn = foldVias(
      doc,
      new Set(),
      viaJoins(keptWrapped(before, doc, new Map(), {}))
    ).functions.find((f) => f.name === 'f');
    expect(
      drawn?.nodes.filter((n) => n.kind === 'getVar' && n.title === 'total')
    ).toEqual([second]);
  });

  it('draws reads after a loop that skips items before its SET', () => {
    const doc = parse(
      'function f(items: number[]): number {\n  let total = 0;\n  for (const item of items) {\n    if (item <= 0) {\n      continue;\n    }\n    total += item;\n  }\n  return total;\n}\n'
    );
    expect(adjacentVias(doc)).toEqual(new Set([node(doc, 'total').id]));
  });

  it('keeps a Get the user wired as its node', () => {
    const doc = parse('const rate = 0.19;\nconst item = { price: rate };\n');
    const read = node(doc, 'rate');
    expect(adjacentVias(doc).has(read.id)).toBe(true);
    const drawn = foldVias(
      doc,
      new Set(),
      viaJoins({ [nodeKey(read.id)]: { x: 0, y: 0 } })
    );
    expect(drawn.functions[0]?.nodes.some((n) => n.id === read.id)).toBe(true);
  });

  it('keeps reads after a loop with two SETs of the variable', () => {
    const doc = parse(
      'function f(items: number[]): number {\n  let total = 0;\n  for (const item of items) {\n    if (item <= 0) {\n      total = 0;\n    } else {\n      total += item;\n    }\n  }\n  return total;\n}\n'
    );
    expect(adjacentVias(doc).size).toBe(0);
  });

  it('keeps reads after a loop whose body ends in a branch', () => {
    const doc = parseTypeScript(
      'function f(items: number[]): number {\n  let total = 0;\n  for (const item of items) {\n    total += item;\n    if (item > 2) {\n      log(item);\n    }\n  }\n  return total;\n}\n',
      'a.ts'
    );
    expect(adjacentVias(doc).size).toBe(0);
  });
});

function gets(doc: GraphDocument): GraphNode[] {
  return doc.functions
    .flatMap((f) => f.nodes)
    .filter((n) => n.kind === 'getVar' && n.title === 'RATE');
}

describe('a Get wired again (UE uses the same node)', () => {
  const text =
    'function f(d: number): number {\n  return d * RATE + RATE;\n}\n';

  it('draws a joined Get as a wire from the Get it joined', () => {
    const doc = parseTypeScript(text, 'a.ts');
    const [host, joined] = gets(doc);
    const drawn = foldVias(
      doc,
      new Set(),
      new Map([[joined?.id ?? '', host?.id ?? '']])
    );
    const fn = drawn.functions.find((f) => f.name === 'f');
    expect(fn?.nodes.some((n) => n.id === joined?.id)).toBe(false);
    expect(fn?.edges.find((e) => e.via === joined?.id)?.from).toEqual({
      node: host?.id,
      pin: 'value',
    });
  });

  it('keeps the join in the layout when the ids change', () => {
    const doc = parseTypeScript(text, 'a.ts');
    const [host, joined] = gets(doc);
    const key = joinKey(joined?.id ?? '', host?.id ?? '');
    expect(viaJoins({ [key]: { x: 0, y: 0 } })).toEqual(
      new Map([[joined?.id, host?.id]])
    );
    expect(viaGets({ [key]: { x: 0, y: 0 } }).size).toBe(0);
    // A statement before them: both ids follow.
    const next = text.replace('{\n', '{\n  log(d);\n');
    const after = parseTypeScript(next, 'a.ts');
    const entries = reconcileVias(
      doc,
      after,
      { [key]: { x: 0, y: 0 } },
      { before: text, edits: [{ start: 32, end: 32, text: '  log(d);\n' }] }
    );
    const [newHost, newJoined] = gets(after);
    expect(Object.keys(entries)).toEqual([
      joinKey(newJoined?.id ?? '', newHost?.id ?? ''),
    ]);
  });
});
