import type { GraphNode, GraphOp } from '@vizscript/core';
import { applyTextEdits } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyTypeScriptOp, parseTypeScript } from '../src';

const DECL =
  'declare const a: number, b: number, c: number, d: number, x: boolean, y: boolean, s: string;\n';

function apply(code: string, op: (nodes: GraphNode[]) => GraphOp): string {
  const text = `${DECL}${code}`;
  const nodes = parseTypeScript(text, 't.ts').functions.flatMap((f) => f.nodes);
  const result = applyTypeScriptOp(text, op(nodes), 't.ts');
  if (!result.ok) {
    throw new Error(result.error);
  }

  return applyTextEdits(text, result.edits).slice(DECL.length);
}

function node(nodes: GraphNode[], title: string): GraphNode {
  const found = nodes.find((n) => n.title === title);
  if (!found) {
    throw new Error(`No node ${title}`);
  }

  return found;
}

function setInput(
  code: string,
  title: string,
  pin: string,
  expression: string
): string {
  return apply(code, (nodes) => ({
    type: 'setInput',
    pin: { node: node(nodes, title).id, pin },
    expression,
  }));
}

describe('values written into operands keep their meaning', () => {
  it('adds parentheses where the operator binds tighter', () => {
    expect(setInput('const v = a * b * c;\n', '*', 'b', 'a + d')).toBe(
      'const v = a * (a + d) * c;\n'
    );
    expect(setInput('const v = a - b;\n', '-', 'b', 'c - d')).toBe(
      'const v = a - (c - d);\n'
    );
    expect(setInput('const v = x == y;\n', '==', 'b', 'a & b')).toBe(
      'const v = x == (a & b);\n'
    );
    expect(setInput('const v = !x;\n', '!', 'a', 'x && y')).toBe(
      'const v = !(x && y);\n'
    );
    expect(setInput('const v = a ?? b;\n', '??', 'b', 'c || d')).toBe(
      'const v = a ?? (c || d);\n'
    );
    expect(
      setInput('const v = s.length;\n', '.length', 'target', 's + s')
    ).toBe('const v = (s + s).length;\n');
  });

  it('leaves values alone that bind tighter', () => {
    expect(setInput('const v = a + b;\n', '+', 'b', 'c * d')).toBe(
      'const v = a + c * d;\n'
    );
    expect(setInput('const v = a - b;\n', '-', 'a', 'c - d')).toBe(
      'const v = c - d - b;\n'
    );
    expect(setInput('const v = a * b;\n', '*', 'a', 'Math.max(c, d)')).toBe(
      'const v = Math.max(c, d) * b;\n'
    );
    expect(setInput('const v = a * b;\n', '*', 'a', '-c')).toBe(
      'const v = -c * b;\n'
    );
    expect(setInput('const v = a * b;\n', '*', 'a', '(c + d)')).toBe(
      'const v = (c + d) * b;\n'
    );
  });

  it('wraps a wired value and a typed value', () => {
    expect(
      apply('a + b;\nconst v = c * 2;\n', (nodes) => ({
        type: 'connect',
        from: {
          node: node(nodes, '+').id,
          pin:
            node(nodes, '+').pins.find((p) => p.direction === 'out')?.id ?? '',
        },
        to: { node: node(nodes, '*').id, pin: 'a' },
      }))
    ).toMatch(/\nconst v = \(a \+ b\) \* 2;\n$/);
    expect(
      apply('const v = a * undefined;\n', (nodes) => ({
        type: 'setLiteral',
        node: node(nodes, '*').id,
        pin: 'b',
        value: 'Math.PI + c',
      }))
    ).toBe('const v = a * (Math.PI + c);\n');
  });

  it('wraps a value used in a new expression', () => {
    expect(
      apply('const v = a + b;\n', (nodes) => {
        const plus = node(nodes, '+');
        return {
          type: 'useValue',
          pin: {
            node: plus.id,
            pin: plus.pins.find((p) => p.direction === 'out')?.id ?? '',
          },
          expression: '$value * undefined',
        };
      })
    ).toContain('(a + b) * undefined');
  });
});

describe('typed values', () => {
  it('take code in boolean and number values', () => {
    expect(
      apply('if (true) {\n}\n', (nodes) => ({
        type: 'setLiteral',
        node: node(nodes, 'Branch').id,
        pin: 'condition',
        value: '!x',
      }))
    ).toBe('if (!x) {\n}\n');
    expect(
      apply('const v = a * 2;\n', (nodes) => ({
        type: 'setLiteral',
        node: node(nodes, '*').id,
        pin: 'b',
        value: 'c + d',
      }))
    ).toBe('const v = a * (c + d);\n');
    expect(() =>
      apply('if (true) {\n}\n', (nodes) => ({
        type: 'setLiteral',
        node: node(nodes, 'Branch').id,
        pin: 'condition',
        value: 'maybe',
      }))
    ).toThrow('A boolean must be true or false.');
  });
});
