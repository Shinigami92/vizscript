import { describe, expect, it } from 'vitest';
import { nodeCode } from '../src';
import type { GraphNode } from '../src/ir';

const TEXT = 'ok = x not in items\n';

function node(meta?: Record<string, unknown>): GraphNode {
  return {
    id: 'n',
    kind: 'operator',
    category: 'pure',
    purity: 'pure',
    title: 'in',
    range: { start: 5, end: 19 },
    path: 'n',
    pins: [],
    ...(meta ? { meta } : {}),
  };
}

describe('nodeCode', () => {
  it('is the text of the node’s range', () => {
    expect(nodeCode(TEXT, node())).toBe('x not in items');
  });

  it('is its own code where that differs (`x in items` of `not in`)', () => {
    expect(nodeCode(TEXT, node({ code: 'x in items' }))).toBe('x in items');
  });
});
