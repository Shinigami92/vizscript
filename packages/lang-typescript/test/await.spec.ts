import type { GraphDocument, GraphOp, OpResult } from '@vizscript/core';
import { applyTextEdits } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyTypeScriptOp, parseTypeScript } from '../src';

/** Awaits the result of the call `title` like the action menu's Await. */
function awaitCall(text: string, title: string, expression: string): string {
  const doc: GraphDocument = parseTypeScript(text, 't.ts');
  const call = doc.functions
    .flatMap((f) => f.nodes)
    .find((n) => n.kind === 'call' && n.title === title);
  const out = call?.pins.find(
    (p) => p.direction === 'out' && p.kind === 'data'
  );
  const op: GraphOp = {
    type: 'useValue',
    pin: { node: call?.id ?? '', pin: out?.id ?? '' },
    expression,
    awaits: true,
  };
  const result: OpResult = applyTypeScriptOp(text, op, 't.ts');
  expect(result.ok).toBe(true);
  return result.ok ? applyTextEdits(text, result.edits) : text;
}

describe('Await', () => {
  it('awaits a call in place and makes its function async', () => {
    expect(
      awaitCall("function f() {\n  fetch('x');\n}\n", 'fetch', 'await $value')
    ).toBe("async function f() {\n  await fetch('x');\n}\n");
    expect(
      awaitCall(
        "async function f() {\n  const r = fetch('x');\n}\n",
        'fetch',
        'await $value'
      )
    ).toBe("async function f() {\n  const r = await fetch('x');\n}\n");
    expect(
      awaitCall(
        'function f(): number {\n  return g();\n}\n',
        'g',
        'await $value'
      )
    ).toBe('async function f(): Promise<number> {\n  return await g();\n}\n');
  });
});

function toggleAsync(text: string, enabled: boolean): string {
  const result = applyTypeScriptOp(
    text,
    {
      type: 'setModifier',
      symbol: 'function:f',
      modifier: 'async',
      enabled,
    },
    't.ts'
  );
  return result.ok ? applyTextEdits(text, result.edits) : result.error;
}

describe('async', () => {
  it('wraps and unwraps the return type in a Promise', () => {
    expect(toggleAsync('function f(): number {\n  return 1;\n}\n', true)).toBe(
      'async function f(): Promise<number> {\n  return 1;\n}\n'
    );
    expect(
      toggleAsync(
        'async function f(): Promise<number> {\n  return 1;\n}\n',
        false
      )
    ).toBe('function f(): number {\n  return 1;\n}\n');
    expect(toggleAsync('function f() {\n}\n', true)).toBe(
      'async function f() {\n}\n'
    );
  });
});
