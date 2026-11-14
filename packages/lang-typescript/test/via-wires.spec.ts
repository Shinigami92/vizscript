import type { GraphDocument, GraphNode } from '@vizscript/core';
import {
  adjacentVias,
  foldVias,
  joinKey,
  reconcileVias,
  viaGets,
  viaJoins,
  viaSetter,
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

  it('keeps reads after a loop that changes the variable', () => {
    const doc = parseTypeScript(
      'let total = 0;\nfor (const item of items) {\n  total += item;\n}\nlog(total);\n',
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
