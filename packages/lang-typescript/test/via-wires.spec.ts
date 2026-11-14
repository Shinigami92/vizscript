import type { GraphDocument, GraphNode } from '@vizscript/core';
import { foldVias, viaSetter } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { parseTypeScript } from '../src';

function node(doc: GraphDocument, title: string): GraphNode {
  const found = doc.functions
    .flatMap((f) => f.nodes)
    .find((n) => n.title === title);
  if (!found) {
    throw new Error(`no ${title}`);
  }

  return found;
}

describe('wires from a SET (UE)', () => {
  const text = 'const rate = 0.19;\nconst item = { price: rate };\n';

  it('draws a remembered Get as a wire from the SET output', () => {
    const doc = parseTypeScript(text, 'a.ts');
    const get = node(doc, 'rate');
    const setter = node(doc, 'Set rate');
    const drawn = foldVias(doc, new Set([get.id]));
    const fn = drawn.functions[0];
    expect(fn?.nodes.some((n) => n.id === get.id)).toBe(false);
    expect(fn?.edges.find((e) => e.via === get.id)?.from).toEqual({
      node: setter.id,
      pin: 'out',
    });
  });

  it('keeps Gets without a SET before them', () => {
    const doc = parseTypeScript(
      'const item = { price: rate };\nconst rate = 0.19;\n',
      'a.ts'
    );
    const get = node(doc, 'rate');
    const fn = doc.functions[0];
    expect(fn && viaSetter(fn, get)).toBeUndefined();
    expect(foldVias(doc, new Set([get.id]))).toBe(doc);
  });
});
