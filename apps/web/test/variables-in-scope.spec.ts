import type { GraphDocument, GraphNode } from '@vizscript/core';
import { gdscriptBackend } from '@vizscript/lang-gdscript';
import { pythonBackend } from '@vizscript/lang-python';
import { rustBackend } from '@vizscript/lang-rust';
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

/** Locals offered at the node, by `scopeVariables` alone. */
function scoped(doc: GraphDocument, node: GraphNode): string[] {
  const index = indexDocument(doc);
  return scopeVariables(
    doc,
    index.nodes.get(node.id)?.fn.id,
    codeOffset(index, node.id)
  ).map((v) => v.expression);
}

describe('locals of a block', () => {
  it('ends a loop variable with its loop (TypeScript)', () => {
    const doc = typescriptBackend.parse(CODE, 'cart.ts');
    expect(
      scoped(
        doc,
        find(doc, (n) => n.title === '<=')
      )
    ).toContain('item');
    expect(
      scoped(
        doc,
        find(doc, (n) => n.kind === 'return')
      )
    ).not.toContain('item');
  });

  it('keeps a name declared in two loops visible in both', () => {
    const doc = typescriptBackend.parse(
      `function f(a: number[], b: number[]): void {
  for (const x of a) {
    console.log(x);
  }

  for (const x of b) {
    console.info(x);
  }
}
`,
      'two.ts'
    );
    expect(
      scoped(
        doc,
        find(doc, (n) => n.title === 'info')
      )
    ).toContain('x');
  });

  it('ends a block’s let with its block (Rust)', () => {
    const doc = rustBackend.parse(
      `fn f(items: Vec<u32>) -> u32 {
    for item in &items {
        let twice = item * 2;
        println!("{}", twice);
    }
    return items.len() as u32;
}
`,
      'main.rs'
    );
    expect(
      scoped(
        doc,
        find(doc, (n) => n.title === 'println!')
      ).toSorted()
    ).toEqual(['item', 'items', 'twice']);
    expect(
      scoped(
        doc,
        find(doc, (n) => n.kind === 'return')
      )
    ).toEqual(['items']);
  });

  it('ends a loop variable with its loop (GDScript)', () => {
    const doc = gdscriptBackend.parse(
      `func f(items: Array) -> int:
	for item in items:
		print(item)
	return items.size()
`,
      'a.gd'
    );
    expect(
      scoped(
        doc,
        find(doc, (n) => n.title === 'print')
      )
    ).toContain('item');
    expect(
      scoped(
        doc,
        find(doc, (n) => n.kind === 'return')
      )
    ).not.toContain('item');
  });

  it('keeps Python’s loop variable after the loop', () => {
    const doc = pythonBackend.parse(
      `def f(items):
    for item in items:
        print(item)
    return item
`,
      'a.py'
    );
    expect(
      scoped(
        doc,
        find(doc, (n) => n.kind === 'return')
      )
    ).toContain('item');
  });
});
