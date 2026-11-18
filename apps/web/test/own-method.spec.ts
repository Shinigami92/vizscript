import type { GraphNode, Pin } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { ownMethodName } from '../src/components/graph-canvas/graph-helpers';

const ITEMS: Pin = {
  id: 'param0',
  name: 'items',
  direction: 'out',
  kind: 'data',
  type: 'string[]',
};

function node(kind: GraphNode['kind'], title: string): GraphNode {
  return {
    id: title,
    kind,
    category: 'function',
    purity: 'pure',
    title,
    range: { start: 0, end: 0 },
    path: title,
    pins: [ITEMS],
  };
}

describe('ownMethodName', () => {
  it('makes a function input’s own calls its methods', () => {
    // `items.push` from the input `items` is `.push()` on it, so `items`
    // is wired to `this` alone, not passed as the value too.
    expect(ownMethodName(node('entry', 'arrays'), ITEMS, 'items.push')).toBe(
      'push'
    );
    expect(
      ownMethodName(node('entry', 'arrays'), ITEMS, 'other.push')
    ).toBeUndefined();
  });

  it('keeps a Get’s methods', () => {
    expect(ownMethodName(node('getVar', 'console'), ITEMS, 'console.log')).toBe(
      'log'
    );
    expect(
      ownMethodName(node('getVar', 'console'), ITEMS, 'console.log.call')
    ).toBeUndefined();
  });

  it('leaves calls on other values', () => {
    expect(
      ownMethodName(node('call', 'items'), ITEMS, 'items.push')
    ).toBeUndefined();
  });
});
