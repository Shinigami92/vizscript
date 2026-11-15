import type { GraphDocument, GraphNode } from '@vizscript/core';
import { typescriptBackend } from '@vizscript/lang-typescript';
import { describe, expect, it } from 'vitest';
import { functionOfNode } from '../src/components/script-workspace/symbol-lookup';

const CODE = `class Cart {
  save(): void {}
  clear(): void {
    this.save();
  }
}

function total(n: number): number {
  return n;
}

console.log(total(1));
`;

function find(doc: GraphDocument, kind: string, title: string): GraphNode {
  const node = doc.functions
    .flatMap((f) => f.nodes)
    .find((n) => n.kind === kind && n.title === title);
  if (!node) {
    throw new Error(`No ${kind} ${title}`);
  }

  return node;
}

describe('functionOfNode', () => {
  const doc = typescriptBackend.parse(CODE, 'cart.ts');
  const of = (node: GraphNode): string | undefined =>
    functionOfNode(doc, [node.id])?.name;

  it('shows the function of its entry and return nodes', () => {
    const entry = doc.functions
      .find((f) => f.name === 'total')
      ?.nodes.find((n) => n.kind === 'entry');
    const ret = doc.functions
      .find((f) => f.name === 'total')
      ?.nodes.find((n) => n.kind === 'return');
    expect(entry && of(entry)).toBe('total');
    expect(ret && of(ret)).toBe('total');
  });

  it('shows the called function of this file', () => {
    expect(of(find(doc, 'call', 'total'))).toBe('total');
    expect(of(find(doc, 'call', 'save'))).toBe('save');
  });

  it('ignores calls of other functions', () => {
    expect(of(find(doc, 'call', 'log'))).toBeUndefined();
  });
});
