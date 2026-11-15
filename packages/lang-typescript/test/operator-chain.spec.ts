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

function operators(text: string): GraphNode[] {
  return parseTypeScript(text, 't.ts')
    .functions.flatMap((f) => f.nodes)
    .filter((n) => n.kind === 'operator');
}

function inputs(node: GraphNode | undefined): string[] {
  return (node?.pins ?? [])
    .filter((p) => p.direction === 'in')
    .map((p) => p.id);
}

const DECL = 'declare const a: number, b: number, c: number;\n';

/** Adds a pin to the last operator of `code` (the outermost). */
function addPin(code: string): string {
  const text = `${DECL}${code}`;
  return apply(text, {
    type: 'addArgument',
    node: operators(text).at(-1)?.id ?? '',
  }).slice(DECL.length);
}

function removePin(code: string, pin: string): string {
  const text = `${DECL}${code}`;
  return apply(text, {
    type: 'removeArgument',
    pin: { node: operators(text)[0]?.id ?? '', pin },
  }).slice(DECL.length);
}

describe('operator chains (UE math nodes with Add pin)', () => {
  it('lowers a chain of one operator as one node', () => {
    const [plus, ...rest] = operators(`${DECL}const x = a + b + c;\n`);
    expect(rest).toEqual([]);
    expect(plus?.title).toBe('+');
    expect(inputs(plus)).toEqual(['a', 'b', 'c']);
    expect(plus && canAddPin(plus)).toBe(true);
  });

  it('keeps other operators and parentheses as their own nodes', () => {
    expect(operators(`${DECL}const x = (a + b) + c;\n`)).toHaveLength(2);
    expect(operators(`${DECL}const x = a - b + c;\n`)).toHaveLength(2);
    expect(operators(`${DECL}const x = a + b * c;\n`)).toHaveLength(2);
    const [less] = operators(`${DECL}const x = a < b;\n`);
    expect(less && canAddPin(less)).toBe(false);
  });

  it('adds a value that changes nothing', () => {
    expect(addPin('const x = a + b;\n')).toBe('const x = a + b + 0;\n');
    expect(addPin('const x = a * b;\n')).toBe('const x = a * b * 1;\n');
    expect(addPin("const x = 'n' + a;\n")).toBe("const x = 'n' + a + '';\n");
    expect(addPin('const x = a > 0 && b > 0;\n')).toBe(
      'const x = a > 0 && b > 0 && true;\n'
    );
    expect(addPin('f(a + (b));\n')).toBe('f(a + (b) + 0);\n');
  });

  it('removes a value with its operator', () => {
    expect(removePin('const x = a + b + c;\n', 'b')).toBe('const x = a + c;\n');
    expect(removePin('const x = a + b + c;\n', 'a')).toBe('const x = b + c;\n');
    expect(removePin('const x = a + (b) + (c);\n', 'c')).toBe(
      'const x = a + (b);\n'
    );
    expect(() => removePin('const x = a + b;\n', 'b')).toThrow(
      'An operator needs two values.'
    );
  });
});
