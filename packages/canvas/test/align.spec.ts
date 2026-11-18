import type { GraphEdge } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import type { AlignNode } from '../src/align';
import { alignNodes, levelEdge } from '../src/align';

const a: AlignNode = { id: 'a', x: 0, y: 0, width: 100, height: 40 };
const b: AlignNode = { id: 'b', x: 200, y: 50, width: 60, height: 80 };
const c: AlignNode = { id: 'c', x: 500, y: 10, width: 100, height: 20 };

/** `id x,y` of the moved nodes. */
function placed(moved: Map<string, { x: number; y: number }>): string[] {
  return [...moved].map(([id, p]) => `${id} ${p.x},${p.y}`);
}

describe('alignNodes (UE alignment tools)', () => {
  it('aligns edges and centers', () => {
    expect(placed(alignNodes('top', [a, b]))).toEqual(['a 0,0', 'b 200,0']);
    expect(placed(alignNodes('bottom', [a, b]))).toEqual([
      'a 0,90',
      'b 200,50',
    ]);
    // Middles at 20 and 90: both at 55.
    expect(placed(alignNodes('middle', [a, b]))).toEqual([
      'a 0,35',
      'b 200,15',
    ]);
    expect(placed(alignNodes('right', [a, b]))).toEqual([
      'a 160,0',
      'b 200,50',
    ]);
  });

  it('distributes with equal gaps, the outer nodes staying', () => {
    // Span 600, widths 260: gaps of 170.
    expect(placed(alignNodes('distributeHorizontally', [c, a, b]))).toEqual([
      'a 0,0',
      'b 270,50',
      'c 500,10',
    ]);
  });

  it('straightens wires, following nodes it moved', () => {
    const first: AlignNode = {
      ...b,
      level: { pinY: 30, other: 'a', otherY: 0, otherPinY: 20 },
    };
    const second: AlignNode = {
      ...c,
      level: { pinY: 10, other: 'b', otherY: 50, otherPinY: 30 },
    };
    // b's pin goes to a's (y 20): b at -10; c follows b's moved pin (20).
    expect(placed(alignNodes('straighten', [second, first]))).toEqual([
      'b 200,-10',
      'c 500,10',
    ]);
  });

  it('needs two nodes to align, one to straighten', () => {
    expect(alignNodes('top', [a]).size).toBe(0);
    expect(alignNodes('straighten', []).size).toBe(0);
  });
});

function edge(kind: GraphEdge['kind'], from: string, to: string): GraphEdge {
  return {
    id: `${from}-${to}`,
    kind,
    from: { node: from, pin: 'out' },
    to: { node: to, pin: 'in' },
  };
}

describe('levelEdge', () => {
  it('levels the exec input first, then data inputs, then outputs', () => {
    const edges = [edge('data', 'x', 'n'), edge('exec', 'y', 'n')];
    expect(levelEdge(edges, 'n')?.from.node).toBe('y');
    expect(levelEdge([edge('data', 'x', 'n')], 'n')?.from.node).toBe('x');
    expect(levelEdge([edge('data', 'n', 'z')], 'n')?.to.node).toBe('z');
    expect(levelEdge([], 'n')).toBeUndefined();
  });
});
