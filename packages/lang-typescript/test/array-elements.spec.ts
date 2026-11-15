import type { GraphNode, GraphOp } from '@vizscript/core';
import { applyTextEdits, valueHost } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyTypeScriptOp, parseTypeScript, typescriptBackend } from '../src';

function typeScriptTypes(): NonNullable<typeof typescriptBackend.typeSystem> {
  const types = typescriptBackend.typeSystem;
  if (!types) {
    throw new Error('No type system');
  }

  return types;
}

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

const FN =
  'interface Item {\n  name: string;\n  price: number;\n}\n\nfunction total(items: Item[] = []) {\n  return items;\n}\n';

function inDefault(text: string, op: (node: GraphNode) => GraphOp): string {
  const param = parseTypeScript(text, 't.ts').symbols?.find(
    (s) => s.name === 'total'
  )?.params?.[0];
  const range = param?.defaultRange;
  const host = range
    ? valueHost(text, range, param?.type?.text, typeScriptTypes())
    : undefined;
  const node = parseTypeScript(host?.text ?? '', 't.ts')
    .functions.flatMap((f) => f.nodes)
    .find((n) => n.kind === 'makeArray' && n.range.start === host?.start);
  if (!range || !node) {
    throw new Error('No default array');
  }

  const result = applyTypeScriptOp(
    text,
    { type: 'inValue', range, typeText: param?.type?.text, op: op(node) },
    't.ts'
  );
  if (!result.ok) {
    throw new Error(result.error);
  }

  return applyTextEdits(text, result.edits);
}

describe('array defaults of inputs (no nodes: edited on a host file)', () => {
  it('adds an element of the declared type to an empty default', () => {
    const once = inDefault(FN, (n) => ({ type: 'addArgument', node: n.id }));
    expect(once).toContain("items: Item[] = [{ name: '', price: 0 }]");
    const twice = inDefault(once, (n) => ({
      type: 'insertElement',
      node: n.id,
      index: 0,
      copy: true,
    }));
    expect(twice).toContain(
      "items: Item[] = [{ name: '', price: 0 }, { name: '', price: 0 }]"
    );
  });
});
