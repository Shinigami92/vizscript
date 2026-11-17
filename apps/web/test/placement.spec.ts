import type { GraphNode, GraphOp } from '@vizscript/core';
import { applyTextEdits, floatingNodes } from '@vizscript/core';
import { applyTypeScriptOp, parseTypeScript } from '@vizscript/lang-typescript';
import { describe, expect, it } from 'vitest';
import {
  allNodeIds,
  anchoredTo,
  floatingLayout,
  placementFor,
  placeNewNodes,
} from '../src/components/script-workspace/placement';

const LAYOUT = {
  sizeOf: () => ({ width: 160, height: 60 }),
  spaceAbove: () => 0,
};

const backend = {
  parse: (text: string) => parseTypeScript(text, 't.ts'),
  applyOp: (text: string, op: GraphOp) => applyTypeScriptOp(text, op, 't.ts'),
};

function find(nodes: ReadonlyArray<GraphNode>, title: string): GraphNode {
  const node = nodes.find((n) => n.title === title);
  if (!node) {
    throw new Error(`no ${title}`);
  }

  return node;
}

describe('placing the nodes of an op', () => {
  it('puts the new expression of a used value where the wire was dropped', () => {
    const text =
      'declare function total(): number;\nfunction f() {\n  total();\n}\n';
    const doc = parseTypeScript(text, 't.ts');
    const call = find(
      doc.functions.flatMap((f) => f.nodes),
      'total'
    );
    const op: GraphOp = {
      type: 'useValue',
      pin: { node: call.id, pin: 'return' },
      expression: '$value + 1',
      position: { x: 500, y: 300 },
    };
    const placement = placementFor(op, doc);
    const result = applyTypeScriptOp(text, op, 't.ts');
    if (!placement || !result.ok) {
      throw new Error('no placement');
    }

    const source = applyTextEdits(text, result.edits);
    const next = parseTypeScript(source, 't.ts');
    const { placed } = placeNewNodes(
      placement,
      doc,
      next,
      { before: text, edits: result.edits },
      source,
      {},
      LAYOUT
    );
    const plus = find(
      next.functions.flatMap((f) => f.nodes),
      '+'
    );
    expect(placed?.[plus.id]).toEqual({ x: 496, y: 304 });
  });
});

describe('placing a node with the text of a later one', () => {
  it('places the new node, not its same-text twin further down', () => {
    const text =
      'function f(item: { price: number }) {\n  console.log(1);\n  item.price;\n}\n';
    const doc = parseTypeScript(text, 't.ts');
    const at = text.indexOf('  console.log');
    const edits = [{ start: at, end: at, text: '  item.price;\n' }];
    const source = applyTextEdits(text, edits);
    const next = parseTypeScript(source, 't.ts');
    const prices = next.functions
      .flatMap((f) => f.nodes)
      .filter((n) => n.title === '.price')
      .toSorted((a, b) => a.range.start - b.range.start);
    const { placed, selectAfter } = placeNewNodes(
      {
        world: { x: 800, y: 400 },
        known: allNodeIds(doc),
        matches: (n) => n.title === '.price',
        select: 'added',
      },
      doc,
      next,
      { before: text, edits },
      source,
      {},
      LAYOUT
    );
    // The new one (first in the code, `#0`) goes where it was dropped.
    expect(placed?.[prices[0]?.id ?? '']).toEqual({ x: 800, y: 400 });
    expect(placed?.[prices[1]?.id ?? '']).toBeUndefined();
    expect(selectAfter).toEqual([prices[0]?.id]);
  });
});

describe('laying out floating nodes', () => {
  it('lays statements out in the order they run', () => {
    const made = floatingNodes(
      'function f() {\n}\n',
      { type: 'code', code: 'throw new Error();' },
      'fn:f',
      'g',
      backend
    );
    if (!made.ok) {
      throw new Error(made.error);
    }

    const layout = floatingLayout(made.edit, { x: 0, y: 0 });
    const error = find(made.edit.nodes, 'new Error');
    const thrown = find(made.edit.nodes, 'Throw');
    // The hoisted `new Error()` runs first: left of its `throw`.
    expect(layout[error.id]?.x).toBeLessThan(layout[thrown.id]?.x ?? 0);
  });

  it('moves a layout so that a kept node stays where it is', () => {
    const laid = { a: { x: 0, y: 0 }, b: { x: 200, y: 0 } };
    expect(anchoredTo(laid, { b: { x: 1000, y: 50 } })).toEqual({
      a: { x: 800, y: 50 },
      b: { x: 1000, y: 50 },
    });
    expect(anchoredTo(laid, undefined)).toBe(laid);
  });
});
