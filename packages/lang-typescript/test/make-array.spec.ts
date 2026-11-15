import type { GraphNode, GraphOp } from '@vizscript/core';
import { applyTextEdits, canAddPin } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyTypeScriptOp, parseTypeScript } from '../src';

function apply(text: string, op: GraphOp): string {
  const result = applyTypeScriptOp(text, op, 't.ts');
  if (!result.ok) {
    throw new Error(result.error);
  }

  return applyTextEdits(text, result.edits);
}

function makeArray(text: string): GraphNode | undefined {
  return parseTypeScript(text, 't.ts')
    .functions.flatMap((f) => f.nodes)
    .find((n) => n.kind === 'makeArray');
}

function addPin(text: string): string {
  return apply(text, { type: 'addArgument', node: makeArray(text)?.id ?? '' });
}

function removePin(text: string, pin: string): string {
  return apply(text, {
    type: 'removeArgument',
    pin: { node: makeArray(text)?.id ?? '', pin },
  });
}

describe('Make Array (UE Add pin)', () => {
  it('has Add pin', () => {
    const node = makeArray('const xs = [1, 2];\n');
    expect(node && canAddPin(node)).toBe(true);
  });

  it("adds an element with its type's empty value", () => {
    expect(addPin('const xs = [1, 2];\n')).toBe('const xs = [1, 2, 0];\n');
    expect(addPin("const xs = ['a'];\n")).toBe("const xs = ['a', ''];\n");
    expect(addPin('const xs = [true];\n')).toBe('const xs = [true, false];\n');
    expect(addPin('const xs = [1, (2)];\n')).toBe('const xs = [1, (2), 0];\n');
    expect(addPin('const xs = [];\n')).toBe('const xs = [undefined];\n');
    // One per line: the new one too, keeping a trailing comma.
    expect(addPin('const xs = [\n  1,\n  2,\n];\n')).toBe(
      'const xs = [\n  1,\n  2,\n  0,\n];\n'
    );
    expect(addPin('const xs = [\n  1,\n  2\n];\n')).toBe(
      'const xs = [\n  1,\n  2,\n  0\n];\n'
    );
  });

  it('removes an element with its comma', () => {
    expect(removePin('const xs = [1, 2, 3];\n', 'e1')).toBe(
      'const xs = [1, 3];\n'
    );
    expect(removePin('const xs = [1, 2];\n', 'e1')).toBe('const xs = [1];\n');
    expect(removePin('const xs = [1];\n', 'e0')).toBe('const xs = [];\n');
  });

  it('removes an element on a line of its own with that line', () => {
    const list = 'const xs = [\n  1,\n  2,\n  3,\n];\n';
    expect(removePin(list, 'e2')).toBe('const xs = [\n  1,\n  2,\n];\n');
    expect(removePin(list, 'e0')).toBe('const xs = [\n  2,\n  3,\n];\n');
    expect(removePin(addPin(list), 'e3')).toBe(list);
  });
});

describe('long arrays', () => {
  it('puts the elements on lines of their own past the print width', () => {
    const text =
      "interface Item {\n  name: string;\n  price: number;\n}\n\nconst cart: Item[] = [{ name: 'Keyboard', price: 89.9 }];\n";
    expect(addPin(text)).toContain(
      "const cart: Item[] = [\n  { name: 'Keyboard', price: 89.9 },\n  { name: '', price: 0 },\n];\n"
    );
  });
});
