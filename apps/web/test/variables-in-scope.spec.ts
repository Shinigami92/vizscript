import type { GraphDocument, GraphNode } from '@vizscript/core';
import { typescriptBackend } from '@vizscript/lang-typescript';
import { describe, expect, it } from 'vitest';
import {
  codeOffset,
  scopeVariables,
  variablesNear,
} from '../src/components/graph-canvas/graph-helpers';
import { indexDocument } from '../src/graph/doc-index';

const CODE = `const RATE = 2;

export function total(items: number[], discount = 0): number {
  let sum = 0;
  for (const item of items) {
    if (item <= 0) {
      continue;
    }

    sum += item;
  }

  const discounted = sum - sum * discount;
  return discounted * RATE;
}

console.log(total([1]));
const LATER = 3;
`;

function find(doc: GraphDocument, test: (n: GraphNode) => boolean): GraphNode {
  const node = doc.functions.flatMap((f) => f.nodes).find(test);
  if (!node) {
    throw new Error('No such node');
  }

  return node;
}

describe('variables offered for an input', () => {
  const doc = typescriptBackend.parse(CODE, 'cart.ts');
  const index = indexDocument(doc);
  const names = (node: GraphNode): string[] => {
    const fn = index.nodes.get(node.id)?.fn.id;
    return [
      ...variablesNear(index, node.id).map((v) => v.name),
      ...scopeVariables(doc, fn, codeOffset(index, node.id)).map(
        (v) => v.expression
      ),
    ].filter((name, i, all) => all.indexOf(name) === i);
  };

  it('leaves out locals declared after the node', () => {
    // `item <= 0` in the loop: `discounted` comes later; module variables
    // can be read whenever the function runs.
    const compare = find(doc, (n) => n.title === '<=');
    expect(names(compare).toSorted()).toEqual([
      'LATER',
      'RATE',
      'discount',
      'item',
      'items',
      'sum',
    ]);
  });

  it('offers locals declared before the node', () => {
    const ret = find(doc, (n) => n.kind === 'return');
    expect(names(ret)).toContain('discounted');
  });

  it('leaves out a declaration’s own name from its value', () => {
    const minus = find(doc, (n) => n.title === '-');
    expect(names(minus)).not.toContain('discounted');
  });

  it('orders module variables in the top-level code', () => {
    const log = find(doc, (n) => n.title === 'log');
    expect(names(log)).toContain('RATE');
    expect(names(log)).not.toContain('LATER');
  });
});
