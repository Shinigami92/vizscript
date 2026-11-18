import type { GraphNode } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { selectionCode } from '../src/components/graph-canvas/graph-helpers';
import type { DocIndex } from '../src/graph/doc-index';

const TEXT = 'def f(x, items):\n    ok = x not in items\n';
const WHOLE = { start: TEXT.indexOf('x not'), end: TEXT.lastIndexOf('\n') };

function node(id: string, extra: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    kind: 'operator',
    category: 'pure',
    purity: 'pure',
    title: id,
    range: WHOLE,
    path: id,
    pins: [],
    ...extra,
  };
}

/** `x not in items` as CONTAINS (its own code `x in items`) → NOT. */
const NODES = [
  node('contains', { meta: { code: 'x in items' } }),
  node('not'),
  node('items', {
    range: { start: TEXT.indexOf('items\n'), end: WHOLE.end },
  }),
];

const INDEX = {
  nodes: new Map(NODES.map((n) => [n.id, { node: n }])),
} as unknown as DocIndex;

describe('selectionCode', () => {
  it('copies a node’s own code when it differs from its range', () => {
    expect(selectionCode(INDEX, TEXT, ['contains'])).toMatchObject({
      code: 'x in items',
      expression: true,
    });
  });

  it('copies two nodes over the same code once', () => {
    expect(selectionCode(INDEX, TEXT, ['contains', 'not']).code).toBe(
      'x not in items'
    );
    expect(selectionCode(INDEX, TEXT, ['not', 'contains', 'items']).code).toBe(
      'x not in items'
    );
  });

  it('copies a value inside another selected one with it', () => {
    expect(selectionCode(INDEX, TEXT, ['items'])).toMatchObject({
      code: 'items',
    });
    expect(selectionCode(INDEX, TEXT, ['not', 'items']).code).toBe(
      'x not in items'
    );
  });
});
