import type { GraphNode } from '@vizscript/core';
import { computeNodeGeometry } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import {
  NODE_APPEAR_MS,
  NODE_MOTION_MS,
  NODE_PULSE_MS,
} from '../src/graph-view-constants';
import type { NodeState } from '../src/graph-view-types';
import {
  continueMove,
  fadeInAdded,
  finishMoves,
  stepNodes,
  stopMotion,
} from '../src/node-motion';

function nodeAt(id: string, x: number, y: number): NodeState {
  const node: GraphNode = {
    id,
    kind: 'call',
    category: 'function',
    purity: 'pure',
    title: id,
    range: { start: 0, end: 0 },
    path: id,
    pins: [],
  };
  return {
    node,
    full: node,
    advanced: 0,
    fnId: 'f',
    geom: computeNodeGeometry(node),
    x,
    y,
    bubble: null,
  };
}

function byId(...nodes: NodeState[]): Map<string, NodeState> {
  return new Map(nodes.map((ns) => [ns.node.id, ns]));
}

describe('continueMove', () => {
  it('slides a moved node from where it was drawn', () => {
    const before = nodeAt('a', 0, 0);
    const now = nodeAt('a', 100, 50);
    continueMove(before, now, 10);
    expect(now).toMatchObject({
      x: 0,
      y: 0,
      tween: { from: { x: 0, y: 0 }, to: { x: 100, y: 50 }, start: 10 },
    });
  });

  it('keeps a slide to the same target going, and leaves still nodes', () => {
    const before = nodeAt('a', 40, 20);
    before.tween = { from: { x: 0, y: 0 }, to: { x: 100, y: 50 }, start: 5 };
    const now = nodeAt('a', 100, 50);
    continueMove(before, now, 10);
    expect(now.tween).toBe(before.tween);
    expect(now).toMatchObject({ x: 40, y: 20 });

    const still = nodeAt('b', 7, 7);
    continueMove(nodeAt('b', 7, 7), still, 10);
    expect(still.tween).toBeUndefined();
    continueMove(undefined, still, 10);
    expect(still.tween).toBeUndefined();
  });
});

describe('fadeInAdded', () => {
  it('fades in only what an edit added', () => {
    const a = nodeAt('a', 0, 0);
    const b = nodeAt('b', 0, 0);
    fadeInAdded(byId(a, b), byId(nodeAt('a', 0, 0)), 3);
    expect(a.appear).toBeUndefined();
    expect(b.appear).toBe(3);
  });

  it('shows another file without fading', () => {
    const a = nodeAt('a', 0, 0);
    fadeInAdded(byId(a), new Map(), 3);
    fadeInAdded(byId(a), byId(nodeAt('x', 0, 0)), 3);
    expect(a.appear).toBeUndefined();
  });
});

describe('stepNodes', () => {
  it('eases slides and reports the ones that settled', () => {
    const a = nodeAt('a', 0, 0);
    a.tween = { from: { x: 0, y: 0 }, to: { x: 100, y: 0 }, start: 0 };
    const half = stepNodes([a], NODE_MOTION_MS / 2);
    expect(half).toEqual({ moved: true, settled: [], running: true });
    expect(a.x).toBeGreaterThan(50);

    const end = stepNodes([a], NODE_MOTION_MS);
    expect(end).toEqual({ moved: true, settled: [a], running: false });
    expect(a).toMatchObject({ x: 100, y: 0, tween: undefined });
  });

  it('ends fade-ins and pulses after their time', () => {
    const a = nodeAt('a', 0, 0);
    a.appear = 0;
    a.pulse = 0;
    expect(stepNodes([a], NODE_APPEAR_MS).running).toBe(true);
    expect(a.appear).toBeUndefined();
    expect(stepNodes([a], NODE_PULSE_MS)).toEqual({
      moved: false,
      settled: [],
      running: false,
    });
    expect(a.pulse).toBeUndefined();
  });
});

describe('finishMoves and stopMotion', () => {
  it('puts sliding nodes at their targets', () => {
    const a = nodeAt('a', 0, 0);
    const b = nodeAt('b', 5, 5);
    a.tween = { from: { x: 0, y: 0 }, to: { x: 30, y: 40 }, start: 0 };
    expect(finishMoves([a, b])).toEqual([a]);
    expect(a).toMatchObject({ x: 30, y: 40, tween: undefined });
  });

  it('also ends fade-ins and pulses', () => {
    const a = nodeAt('a', 0, 0);
    a.appear = 1;
    a.pulse = 1;
    expect(stopMotion([a])).toEqual([]);
    expect(a.appear).toBeUndefined();
    expect(a.pulse).toBeUndefined();
  });
});
