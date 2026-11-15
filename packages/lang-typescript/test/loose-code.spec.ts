import type { GraphDocument, GraphNode } from '@vizscript/core';
import { looseCode } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { parseTypeScript } from '../src';

function nodes(doc: GraphDocument): GraphNode[] {
  return doc.functions.flatMap((f) => f.nodes);
}

const TEXT = [
  'declare function g(n: number): void;',
  'function f(items: number[], k: number) {',
  '  for (const item of items) {',
  '    if (item > 0) {',
  '      g(item * k);',
  '    }',
  '  }',
  '}',
  '',
].join('\n');

describe('nodes an edit takes out of the code', () => {
  it('keeps the body of a deleted block as one group of statements', () => {
    const doc = parseTypeScript(TEXT, 't.ts');
    const loop = nodes(doc).find((n) => n.kind === 'forEach');
    const body = new Set(
      nodes(doc)
        .filter(
          (n) =>
            n.id !== loop?.id &&
            n.kind !== 'entry' &&
            loop !== undefined &&
            n.range.start > loop.range.start
        )
        .map((n) => n.id)
    );
    const [part, ...rest] = looseCode(
      TEXT,
      doc,
      body,
      new Set([loop?.id ?? '']),
      'undefined'
    );
    expect(rest).toEqual([]);
    expect(part?.statement).toBe(true);
    // The loop's item is gone: its uses are empty inputs; `k` (a parameter
    // still in the code) stays wired.
    expect(part?.code).toBe(
      'if (undefined > 0) {\n  g(undefined * undefined);\n}'
    );
    expect(part?.feeds.map((f) => f?.pin ?? null)).toEqual([
      null,
      null,
      'param1',
    ]);
  });

  it('keeps a value as an expression', () => {
    const doc = parseTypeScript(TEXT, 't.ts');
    const times = nodes(doc).find((n) => n.title === '*');
    const call = nodes(doc).find((n) => n.title === 'g');
    const [part] = looseCode(
      TEXT,
      doc,
      new Set([times?.id ?? '']),
      new Set([call?.id ?? '']),
      'undefined'
    );
    expect(part).toMatchObject({
      statement: false,
      code: 'undefined * undefined',
    });
  });
});
