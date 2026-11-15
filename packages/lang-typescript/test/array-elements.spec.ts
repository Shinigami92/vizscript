import type { GraphNode, GraphOp } from '@vizscript/core';
import { applyTextEdits } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyTypeScriptOp, parseTypeScript } from '../src';

const CART = `const cart = [
  { name: 'Keyboard', price: 89.9, quantity: 1 },
  { name: 'Cable', price: 4.5, quantity: 3 },
];
`;

function array(text: string): GraphNode {
  const node = parseTypeScript(text, 't.ts')
    .functions.flatMap((f) => f.nodes)
    .find((n) => n.kind === 'makeArray');
  if (!node) {
    throw new Error('No Make Array');
  }

  return node;
}

function apply(text: string, op: (node: GraphNode) => GraphOp): string {
  const result = applyTypeScriptOp(text, op(array(text)), 't.ts');
  if (!result.ok) {
    throw new Error(result.error);
  }

  return applyTextEdits(text, result.edits);
}

describe('array elements (UE: Insert, Duplicate, Delete, drag)', () => {
  it('adds an element of objects with their shape and empty values', () => {
    expect(apply(CART, (n) => ({ type: 'addArgument', node: n.id }))).toBe(
      CART.replace(
        "  { name: 'Cable', price: 4.5, quantity: 3 },\n",
        "  { name: 'Cable', price: 4.5, quantity: 3 },\n  { name: '', price: 0, quantity: 0 },\n"
      )
    );
  });

  it('inserts an empty element before one and duplicates one after it', () => {
    expect(
      apply(CART, (n) => ({ type: 'insertElement', node: n.id, index: 1 }))
    ).toContain("  { name: '', price: 0, quantity: 0 },\n  { name: 'Cable'");
    expect(
      apply(CART, (n) => ({
        type: 'insertElement',
        node: n.id,
        index: 0,
        copy: true,
      }))
    ).toContain(
      "  { name: 'Keyboard', price: 89.9, quantity: 1 },\n  { name: 'Keyboard', price: 89.9, quantity: 1 },\n  { name: 'Cable'"
    );
    expect(
      apply('const xs = [1, 2];\n', (n) => ({
        type: 'insertElement',
        node: n.id,
        index: 1,
      }))
    ).toBe('const xs = [1, 0, 2];\n');
  });

  it('moves an element', () => {
    expect(
      apply('const xs = [1, 2, 3];\n', (n) => ({
        type: 'moveElement',
        node: n.id,
        from: 0,
        to: 2,
      }))
    ).toBe('const xs = [2, 3, 1];\n');
    expect(
      apply(CART, (n) => ({ type: 'moveElement', node: n.id, from: 1, to: 0 }))
    ).toBe(
      "const cart = [\n  { name: 'Cable', price: 4.5, quantity: 3 },\n  { name: 'Keyboard', price: 89.9, quantity: 1 },\n];\n"
    );
  });
});
