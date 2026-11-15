import type { PinGeometry } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import type { NodeState } from '../src/graph-view-types';
import { resolvePin, samePin } from '../src/pin-ref';

/** A node's state as a new document makes it: new objects, same ids. */
function nodeState(id: string, pinIds: ReadonlyArray<string>): NodeState {
  const pins = new Map<string, PinGeometry>(
    pinIds.map((pin) => [
      pin,
      { pin: { id: pin }, x: 0, y: 0, side: 'left', row: 0 } as PinGeometry,
    ])
  );
  return { node: { id }, geom: { pins } } as unknown as NodeState;
}

function pinOf(ns: NodeState, pin: string): { ns: NodeState; pg: PinGeometry } {
  const pg = ns.geom.pins.get(pin);
  if (!pg) {
    throw new Error(`no pin ${pin}`);
  }

  return { ns, pg };
}

describe('pin references', () => {
  it('compares pins by id across documents', () => {
    const before = nodeState('n1', ['in', 'out']);
    const after = nodeState('n1', ['in', 'out']);
    expect(samePin(pinOf(before, 'out'), pinOf(after, 'out'))).toBe(true);
    expect(samePin(pinOf(before, 'in'), pinOf(after, 'out'))).toBe(false);
    expect(
      samePin(pinOf(before, 'out'), pinOf(nodeState('n2', ['out']), 'out'))
    ).toBe(false);
  });

  it('finds the pin in the new nodes, or nothing when it is gone', () => {
    const before = nodeState('n1', ['in', 'out']);
    const after = nodeState('n1', ['in']);
    const nodes = new Map([['n1', after]]);
    expect(resolvePin(nodes, pinOf(before, 'in'))).toEqual({
      ns: after,
      pg: after.geom.pins.get('in'),
    });
    expect(resolvePin(nodes, pinOf(before, 'out'))).toBeNull();
    expect(resolvePin(new Map(), pinOf(before, 'in'))).toBeNull();
  });
});
