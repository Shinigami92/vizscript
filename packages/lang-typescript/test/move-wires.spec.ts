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

  it('moves a value to another input without keeping a copy', () => {
    const text =
      'const RATE = 0.19;\nfunction f(d: number) {\n  return d * (1 + RATE);\n}\n';
    const plus = parseTypeScript(text, 't.ts')
      .functions.find((fn) => fn.name === 'f')
      ?.nodes.find((n) => n.kind === 'operator' && n.title === '+');
    const [a, b] = plus?.pins.filter((p) => p.direction === 'in') ?? [];
    expect(
      apply(text, {
        type: 'moveWires',
        from: { node: plus?.id ?? '', pin: b?.id ?? '' },
        to: { node: plus?.id ?? '', pin: a?.id ?? '' },
      })
    ).toBe(
      'const RATE = 0.19;\nfunction f(d: number) {\n  return d * (RATE + undefined);\n}\n'
    );
  });

  it('keeps the node it replaces, without the moved value', () => {
    const text =
      'const RATE = 0.19;\nfunction f(d: number) {\n  return d * (1 + RATE);\n}\n';
    const nodes =
      parseTypeScript(text, 't.ts').functions.find((fn) => fn.name === 'f')
        ?.nodes ?? [];
    const plus = nodes.find((n) => n.kind === 'operator' && n.title === '+');
    const times = nodes.find((n) => n.kind === 'operator' && n.title === '*');
    // RATE moves from `+` onto `*`'s lower input: `1 + …` stays unwired.
    expect(
      apply(text, {
        type: 'moveWires',
        from: { node: plus?.id ?? '', pin: 'b' },
        to: { node: times?.id ?? '', pin: 'b' },
      })
    ).toBe(
      'const RATE = 0.19;\nfunction f(d: number) {\n  1 + undefined;\n  return d * (RATE);\n}\n'
    );
  });

  it('keeps the node a new wire replaces, like UE', () => {
    const text =
      'const RATE = 0.19;\nfunction f(d: number) {\n  return d * (1 + RATE);\n}\n';
    const nodes =
      parseTypeScript(text, 't.ts').functions.find((fn) => fn.name === 'f')
        ?.nodes ?? [];
    const rate = nodes.find((n) => n.kind === 'getVar' && n.title === 'RATE');
    const times = nodes.find((n) => n.kind === 'operator' && n.title === '*');
    expect(
      apply(text, {
        type: 'connect',
        from: { node: rate?.id ?? '', pin: 'value' },
        to: { node: times?.id ?? '', pin: 'b' },
      })
    ).toBe(
      'const RATE = 0.19;\nfunction f(d: number) {\n  1 + RATE;\n  return d * (RATE);\n}\n'
    );
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
