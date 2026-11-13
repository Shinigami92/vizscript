import type { GraphOp } from '@vizscript/core';
import { applyTextEdits } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyGDScriptOp, parseGDScriptDocument } from '../src';

function apply(text: string, op: GraphOp): string {
  const result = applyGDScriptOp(text, op, 'x.gd');
  if (!result.ok) {
    throw new Error(result.error);
  }

  return applyTextEdits(text, result.edits);
}

describe('values', () => {
  it('keeps a float literal a float', () => {
    const text = 'func f(delta: float) -> float:\n\treturn 980.0 * delta\n';
    const doc = parseGDScriptDocument(text, 'x.gd');
    const times = doc.functions
      .flatMap((f) => f.nodes)
      .find((n) => n.title === '*');
    if (!times) {
      throw new Error('no *');
    }

    expect(
      apply(text, {
        type: 'setLiteral',
        node: times.id,
        pin: 'a',
        value: '900',
      })
    ).toContain('return 900.0 * delta\n');
  });

  it('starts a Set with the value it is given', () => {
    const text = 'var score: int = 0\n\n\nfunc f() -> void:\n\tpass\n';
    const doc = parseGDScriptDocument(text, 'x.gd');
    const entry = doc.functions
      .find((f) => f.name === 'f')
      ?.nodes.find((n) => n.kind === 'entry');
    if (!entry) {
      throw new Error('no entry');
    }

    const set = (value?: string): string =>
      apply(text, {
        type: 'addNode',
        template: {
          type: 'setVar',
          name: 'score',
          declaration: 'none',
          ...(value === undefined ? {} : { value }),
        },
        after: { node: entry.id, pin: 'then' },
      });
    expect(set('0')).toContain('\tscore = 0\n');
    expect(set()).toContain('\tscore = null\n');
  });
});
