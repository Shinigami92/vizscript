import type { GraphNode, GraphOp } from '@vizscript/core';
import { applyTextEdits } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyTypeScriptOp, parseTypeScript } from '../src';

function nodes(text: string): GraphNode[] {
  return parseTypeScript(text, 't.ts').functions.flatMap((f) => f.nodes);
}

function apply(text: string, op: GraphOp): string {
  const result = applyTypeScriptOp(text, op, 't.ts');
  if (!result.ok) {
    throw new Error(result.error);
  }

  return applyTextEdits(text, result.edits);
}

const TEXT =
  'declare function g(n: number): void;\nfunction f(a: number) {\n  g(a + 1);\n  g(a + 1);\n}\n';

describe('several ops as one edit', () => {
  it('writes each op of `all` in one edit', () => {
    const pluses = nodes(TEXT).filter((n) => n.title === '+');
    expect(pluses).toHaveLength(2);
    const op: GraphOp = {
      type: 'all',
      ops: pluses.map((n) => ({
        type: 'setLiteral',
        node: n.id,
        pin: 'b',
        value: '2',
      })),
    };
    expect(apply(TEXT, op)).toBe(
      'declare function g(n: number): void;\nfunction f(a: number) {\n  g(a + 2);\n  g(a + 2);\n}\n'
    );
  });

  it('fails when the edits of its ops overlap', () => {
    const plus = nodes(TEXT).find((n) => n.title === '+');
    const set = (value: string): GraphOp => ({
      type: 'setLiteral',
      node: plus?.id ?? '',
      pin: 'b',
      value,
    });
    const result = applyTypeScriptOp(
      TEXT,
      { type: 'all', ops: [set('2'), set('3')] },
      't.ts'
    );
    expect(result.ok).toBe(false);
  });
});

describe('disconnect with drop', () => {
  it('removes the value instead of keeping it as a statement', () => {
    const call = nodes(TEXT).find((n) => n.title === 'g');
    const pin = call?.pins.find(
      (p) => p.range && TEXT.slice(p.range.start, p.range.end) === 'a + 1'
    );
    const pinRef = { node: call?.id ?? '', pin: pin?.id ?? '' };
    expect(apply(TEXT, { type: 'disconnect', pin: pinRef })).toContain(
      'a + 1;\n  g('
    );
    expect(
      apply(TEXT, { type: 'disconnect', pin: pinRef, drop: true })
    ).not.toContain('a + 1;\n  g(');
  });
});
