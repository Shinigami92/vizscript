import type { GraphOp } from '@vizscript/core';
import { applyTextEdits, looksLikeCode } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyTypeScriptOp, parseTypeScript } from '../src';

function apply(text: string, op: GraphOp): string {
  const result = applyTypeScriptOp(text, op, 't.ts');
  if (!result.ok) {
    throw new Error(result.error);
  }

  return applyTextEdits(text, result.edits);
}

const TEXT = [
  'function greet(person: string): string {',
  '  return person;',
  '}',
  '',
].join('\n');

describe('operator and value nodes', () => {
  it('uses a dragged value in a new expression', () => {
    const doc = parseTypeScript(TEXT, 't.ts');
    const entry = doc.functions.find((f) => f.name === 'greet')?.nodes[0];
    const added = apply(TEXT, {
      type: 'useValue',
      pin: { node: entry?.id ?? '', pin: 'param0' },
      expression: '$value + undefined',
    });
    expect(added).toBe(
      'function greet(person: string): string {\n  person + undefined;\n  return person;\n}\n'
    );

    // Wiring the lone `+` into the Return moves it there.
    const next = parseTypeScript(added, 't.ts');
    const fn = next.functions.find((f) => f.name === 'greet');
    const plus = fn?.nodes.find((n) => n.kind === 'operator');
    const ret = fn?.nodes.find((n) => n.kind === 'return');
    const wired = apply(added, {
      type: 'connect',
      from: { node: plus?.id ?? '', pin: 'value' },
      to: { node: ret?.id ?? '', pin: 'value' },
    });
    expect(wired).toBe(
      'function greet(person: string): string {\n  return person + undefined;\n}\n'
    );

    // Typing text into the empty input writes a string.
    const op = parseTypeScript(wired, 't.ts')
      .functions.find((f) => f.name === 'greet')
      ?.nodes.find((n) => n.kind === 'operator');
    const right = op?.pins.find(
      (p) => p.direction === 'in' && p.literal?.raw === 'undefined'
    );
    expect(
      apply(wired, {
        type: 'setLiteral',
        node: op?.id ?? '',
        pin: right?.id ?? '',
        value: 'Hello, ',
      })
    ).toContain('return person + "Hello, ";');
  });

  it('tells code from text', () => {
    const doc = parseTypeScript(
      'const user = 1;\nfunction f(count: number) {}\n',
      't.ts'
    );
    expect(looksLikeCode('user', doc)).toBe(true);
    expect(looksLikeCode('count + 1', doc)).toBe(true);
    expect(looksLikeCode('Math.max(1, 2)', doc)).toBe(true);
    expect(looksLikeCode('42', doc)).toBe(true);
    expect(looksLikeCode('"x"', doc)).toBe(true);
    expect(looksLikeCode('Jane User', doc)).toBe(false);
    expect(looksLikeCode('Hello, ', doc)).toBe(false);
    expect(looksLikeCode('Hello!', doc)).toBe(false);
  });
});
