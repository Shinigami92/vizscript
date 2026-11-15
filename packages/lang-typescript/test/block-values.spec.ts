import type { GraphNode, GraphOp } from '@vizscript/core';
import { applyTextEdits } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyTypeScriptOp, parseTypeScript } from '../src';

function apply(text: string, op: (nodes: GraphNode[]) => GraphOp): string {
  const nodes = parseTypeScript(text, 't.ts').functions.flatMap((f) => f.nodes);
  const result = applyTypeScriptOp(text, op(nodes), 't.ts');
  if (!result.ok) {
    throw new Error(result.error);
  }

  return applyTextEdits(text, result.edits);
}

function find(nodes: GraphNode[], test: (n: GraphNode) => boolean): GraphNode {
  const node = nodes.find(test);
  if (!node) {
    throw new Error('Node not found.');
  }

  return node;
}

function output(node: GraphNode): string {
  return (
    node.pins.find((p) => p.direction === 'out' && p.kind === 'data')?.id ?? ''
  );
}

const LOOP = `function f(items: { p: number; q: number }[]) {
  for (const item of items) {
    if (item.q <= 0) {
      continue;
    }
  }
  return 1;
}
`;

describe('values bound in a block', () => {
  it('uses a loop item at the start of the loop body', () => {
    const text = apply(LOOP, (nodes) => {
      const loop = find(nodes, (n) => n.kind === 'forEach');
      return {
        type: 'useValue',
        pin: { node: loop.id, pin: output(loop) },
        expression: '$value.p',
      };
    });
    expect(text).toContain('for (const item of items) {\n    item.p;\n    if');
  });

  it('uses a caught error in its catch block', () => {
    const code =
      'function f() {\n  try {\n    g();\n  } catch (error) {\n  }\n}\n';
    const text = apply(code, (nodes) => {
      const handler = find(nodes, (n) => n.kind === 'try');
      return {
        type: 'useValue',
        pin: { node: handler.id, pin: 'error' },
        expression: '$value.message',
      };
    });
    expect(text).toContain('} catch (error) {\n    error.message;\n  }');
  });

  it('moves a lone value back to an earlier input when its inputs exist there', () => {
    const code = LOOP.replace('    }\n  }', '    }\n    item.p;\n  }');
    const text = apply(code, (nodes) => {
      const value = find(nodes, (n) => n.title === '.p');
      const less = find(nodes, (n) => n.title === '<=');
      return {
        type: 'connect',
        from: { node: value.id, pin: output(value) },
        to: { node: less.id, pin: 'a' },
      };
    });
    expect(text).toContain('if (item.p <= 0)');
    expect(text).not.toContain('item.p;');
  });

  it('uses a lone value where it stands in a new expression', () => {
    const code = LOOP.replace('    }\n  }', '    }\n    item.p + 1;\n  }');
    const text = apply(code, (nodes) => {
      const plus = find(nodes, (n) => n.title === '+');
      return {
        type: 'useValue',
        pin: { node: plus.id, pin: output(plus) },
        expression: '$value * 2',
      };
    });
    expect(text).toContain('    }\n    (item.p + 1) * 2;\n  }');
    expect(text).not.toContain('item.p + 1;');
  });

  it('drops an empty value that a wire replaces', () => {
    const code =
      'function f(items: number[]) {\n  for (const item of []) {\n  }\n}\n';
    const text = apply(code, (nodes) => {
      const entry = find(
        nodes,
        (n) => n.kind === 'entry' && n.pins.some((p) => p.id === 'param0')
      );
      const loop = find(nodes, (n) => n.kind === 'forEach');
      const array = loop.pins.find(
        (p) => p.kind === 'data' && p.direction === 'in'
      );
      return {
        type: 'connect',
        from: { node: entry.id, pin: 'param0' },
        to: { node: loop.id, pin: array?.id ?? '' },
      };
    });
    expect(text).toBe(
      'function f(items: number[]) {\n  for (const item of items) {\n  }\n}\n'
    );
  });

  it('moves a lone value back into a receiver', () => {
    const code = 'declare const a: string, b: string;\na.trim();\nb;\n';
    const text = apply(code, (nodes) => {
      const get = nodes.filter((n) => n.kind === 'getVar').at(-1);
      const trim = find(nodes, (n) => n.title === 'trim');
      return {
        type: 'connect',
        from: { node: get?.id ?? '', pin: 'value' },
        to: { node: trim.id, pin: 'target' },
        drop: true,
      };
    });
    expect(text).toBe('declare const a: string, b: string;\nb.trim();\n');
  });

  it('keeps a lone value in place when it reads a later variable', () => {
    const code =
      'function f(a: number) {\n  if (a <= 0) {\n  }\n  const k = 2;\n  k + 1;\n}\n';
    const result = applyTypeScriptOp(
      code,
      (() => {
        const nodes = parseTypeScript(code, 't.ts').functions.flatMap(
          (f) => f.nodes
        );
        const plus = find(nodes, (n) => n.title === '+');
        const less = find(nodes, (n) => n.title === '<=');
        return {
          type: 'connect',
          from: { node: plus.id, pin: output(plus) },
          to: { node: less.id, pin: 'a' },
        } satisfies GraphOp;
      })(),
      't.ts'
    );
    const text = result.ok ? applyTextEdits(code, result.edits) : code;
    expect(text).not.toContain('if (k + 1 <= 0)');
  });
});
