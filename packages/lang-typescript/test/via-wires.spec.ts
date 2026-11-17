import type { GraphDocument, GraphNode } from '@vizscript/core';
import {
  adjacentVias,
  foldVias,
  joinedNode,
  joinKey,
  keptWrapped,
  nodeKey,
  reconcileVias,
  statementJoins,
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

  it('keeps a read after a loop a Get node: the loop may not run', () => {
    const doc = parse(
      'let total = 0;\nfor (const item of items) {\n  total += item;\n}\nlog(total);\n'
    );
    const fn = doc.functions[0];
    const read = node(doc, 'total');
    expect(adjacentVias(doc).has(read.id)).toBe(false);
    // Wired by hand, it comes from the nearest SET before it in the code:
    // `total += item`, a SET without a declaration keyword.
    const setter = fn && viaSetter(fn, read);
    expect(setter && codeOf(doc, setter)).toBe('total += item;');
  });

  it('keeps reads after a loop Get nodes, also from the SET ending its body', () => {
    const doc = parseTypeScript(
      'function f(items: number[]): number {\n  let total = 0;\n  for (const item of items) {\n    total += item;\n  }\n  const half = total - total / 2;\n  return half;\n}\n',
      'a.ts'
    );
    const reads = doc.functions
      .flatMap((f) => f.nodes)
      .filter((n) => n.kind === 'getVar' && n.title === 'total');
    expect(reads).toHaveLength(2);
    const vias = adjacentVias(doc);
    expect(reads.some((n) => vias.has(n.id))).toBe(false);
  });

  it('draws reads on a wrapped row as one Get node, not wires back', () => {
    const doc = parseTypeScript(
      'function f(n: number): number {\n  let total = n * 2;\n  const half = total - total / 2;\n  return half;\n}\n',
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
      'function f(n: number): number {\n  let total = n * 2;\n  const half = total - total / 2;\n  return half;\n}\n',
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
    // Still wrapped, but the new layout would pick the other read.
    const fn = doc.functions.find((f) => f.name === 'f');
    const setter = fn ? viaSetter(fn, first) : undefined;
    const other = {
      [setter?.id ?? '']: { x: 900, y: 0 },
      [first.id]: { x: 100, y: 200 },
      [second.id]: { x: 300, y: 260 },
    };
    expect(Object.keys(keptWrapped(before, doc, new Map(), other))).toEqual([
      nodeKey(second.id),
      joinKey(first.id, second.id),
    ]);
    // Drawn as before by the new layout: nothing to keep.
    const same = {
      ...other,
      [first.id]: { x: 300, y: 200 },
      [second.id]: { x: 100, y: 260 },
    };
    expect(keptWrapped(before, doc, new Map(), same)).toEqual({});

    const drawn = foldVias(
      doc,
      new Set(),
      viaJoins(keptWrapped(before, doc, new Map(), {}))
    ).functions.find((f) => f.name === 'f');
    expect(
      drawn?.nodes.filter((n) => n.kind === 'getVar' && n.title === 'total')
    ).toEqual([second]);
  });

  it('keeps reads after a loop that skips items Get nodes', () => {
    const doc = parse(
      'function f(items: number[]): number {\n  let total = 0;\n  for (const item of items) {\n    if (item <= 0) {\n      continue;\n    }\n    total += item;\n  }\n  return total;\n}\n'
    );
    expect(adjacentVias(doc).size).toBe(0);
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

const LOOP = (body: string): string =>
  `interface Item { price: number; quantity: number }\ndeclare function g(n: number): void;\nfunction f(items: Item[]) {\n  for (const item of items) {\n${body}\n  }\n}\n`;
const quantities = (doc: GraphDocument): GraphNode[] =>
  doc.functions.flatMap((f) => f.nodes).filter((n) => n.title === '.quantity');

describe('pure node joins (UE: one pure node, many wires)', () => {
  it('draws identical expressions of one statement as one node', () => {
    const doc = parseTypeScript(
      LOOP('    g(item.price * item.quantity + item.quantity);'),
      'a.ts'
    );
    const [host, copy] = quantities(doc);
    if (!host || !copy) {
      throw new Error('no .quantity');
    }

    const drawn = foldVias(doc, new Set());
    expect(quantities(drawn).map((n) => n.id)).toEqual([host.id]);
    const wires = drawn.functions
      .flatMap((f) => f.edges)
      .filter((e) => e.from.node === host.id);
    expect(wires).toHaveLength(2);
    expect(wires.some((e) => e.via === copy.id)).toBe(true);
  });

  it('draws the leftmost copy in the layout as the shared node', () => {
    const doc = parseTypeScript(
      LOOP('    g(item.price * item.quantity + item.quantity);'),
      'a.ts'
    );
    const [first, second] = quantities(doc);
    if (!first || !second) {
      throw new Error('no .quantity');
    }

    const layout = {
      [first.id]: { x: 300, y: 0 },
      [second.id]: { x: 100, y: 0 },
    };
    expect(statementJoins(doc, layout).get(first.id)).toBe(second.id);
    expect(statementJoins(doc).get(second.id)).toBe(first.id);
  });

  it('keeps identical expressions of two statements apart', () => {
    const doc = parseTypeScript(
      LOOP('    g(item.quantity);\n    g(item.quantity);'),
      'a.ts'
    );
    expect(quantities(foldVias(doc, new Set()))).toHaveLength(2);
  });

  it('draws a copy the user wired as its host, across statements', () => {
    const doc = parseTypeScript(
      LOOP('    g(item.quantity);\n    g(item.quantity);'),
      'a.ts'
    );
    const [host, copy] = quantities(doc);
    if (!host || !copy) {
      throw new Error('no .quantity');
    }

    const joins = viaJoins({ [joinKey(copy.id, host.id)]: { x: 0, y: 0 } });
    const drawn = foldVias(doc, new Set(), joins);
    expect(quantities(drawn).map((n) => n.id)).toEqual([host.id]);
    // The copy's own input (the loop item) is not drawn twice.
    const fn = drawn.functions.find((f) => f.name === 'f');
    expect(fn?.edges.filter((e) => e.to.node === copy.id)).toEqual([]);
  });

  it('ignores a join of different expressions', () => {
    const doc = parseTypeScript(
      LOOP('    g(item.quantity);\n    g(item.price);'),
      'a.ts'
    );
    const host = node(doc, '.quantity');
    const other = node(doc, '.price');
    const joins = viaJoins({ [joinKey(other.id, host.id)]: { x: 0, y: 0 } });
    const drawn = foldVias(doc, new Set(), joins);
    expect(
      drawn.functions.flatMap((f) => f.nodes).some((n) => n.id === other.id)
    ).toBe(true);
  });
});

describe('edits of a joined pure node', () => {
  it('finds the node of a copy that stands where a node of its host does', () => {
    const doc = parseTypeScript(
      LOOP('    g(item.quantity + 1);\n    g(item.quantity + 1);'),
      'a.ts'
    );
    const fn = doc.functions.find((f) => f.name === 'f');
    const [host, copy] = (fn?.nodes ?? []).filter((n) => n.title === '+');
    const [hostQuantity, copyQuantity] = quantities(doc);
    const loop = fn?.nodes.find((n) => n.kind === 'forEach');
    if (!fn || !host || !copy || !hostQuantity || !copyQuantity || !loop) {
      throw new Error('missing nodes');
    }

    expect(joinedNode(fn, host.id, copy.id, host.id)).toBe(copy.id);
    expect(joinedNode(fn, host.id, copy.id, hostQuantity.id)).toBe(
      copyQuantity.id
    );
    // Not a part of the expression: no node of the copy stands for it.
    expect(joinedNode(fn, host.id, copy.id, loop.id)).toBeUndefined();
  });
});
