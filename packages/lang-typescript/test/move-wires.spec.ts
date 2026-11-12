import type { GraphOp } from '@vizscript/core';
import { applyTextEdits } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyTypeScriptOp, parseTypeScript } from '../src';

function apply(text: string, op: GraphOp): string {
  const result = applyTypeScriptOp(text, op, 't.ts');
  if (!result.ok) {
    throw new Error(result.error);
  }

  return applyTextEdits(text, result.edits);
}

describe('moving wires (Ctrl+drag)', () => {
  it('moves all wires of an output to another output', () => {
    const text =
      'function f(x: number, y: number) {\n  g(x);\n  h(x + 1);\n}\n';
    const entry = parseTypeScript(text, 't.ts')
      .functions.find((fn) => fn.name === 'f')
      ?.nodes.find((n) => n.kind === 'entry');
    expect(
      apply(text, {
        type: 'moveWires',
        from: { node: entry?.id ?? '', pin: 'param0' },
        to: { node: entry?.id ?? '', pin: 'param1' },
      })
    ).toBe('function f(x: number, y: number) {\n  g(y);\n  h(y + 1);\n}\n');
  });

  it('moves the wire of an input to another input', () => {
    const text = 'function f(x: number) {\n  g(x, 2);\n}\n';
    const call = parseTypeScript(text, 't.ts')
      .functions.find((fn) => fn.name === 'f')
      ?.nodes.find((n) => n.kind === 'call');
    expect(
      apply(text, {
        type: 'moveWires',
        from: { node: call?.id ?? '', pin: 'arg0' },
        to: { node: call?.id ?? '', pin: 'arg1' },
      })
    ).toBe('function f(x: number) {\n  g(undefined, x);\n}\n');
  });

  it('refuses exec pins', () => {
    const text = 'function f() {\n  g();\n}\n';
    const call = parseTypeScript(text, 't.ts')
      .functions.find((fn) => fn.name === 'f')
      ?.nodes.find((n) => n.kind === 'call');
    expect(() =>
      apply(text, {
        type: 'moveWires',
        from: { node: call?.id ?? '', pin: 'exec' },
        to: { node: call?.id ?? '', pin: 'then' },
      })
    ).toThrow('Only data wires can be moved together.');
  });
});

describe('pasting code', () => {
  it('re-indents pasted statements to where they go', () => {
    const text = 'function f() {\n  start();\n}\n';
    const call = parseTypeScript(text, 't.ts')
      .functions.find((fn) => fn.name === 'f')
      ?.nodes.find((n) => n.kind === 'call');
    expect(
      apply(text, {
        type: 'addNode',
        template: {
          type: 'code',
          code: '\n    if (ready) {\n        go();\n    }\n    done();\n',
        },
        after: { node: call?.id ?? '', pin: 'then' },
      })
    ).toBe(
      'function f() {\n  start();\n  if (ready) {\n    go();\n  }\n  done();\n}\n'
    );
  });
});
