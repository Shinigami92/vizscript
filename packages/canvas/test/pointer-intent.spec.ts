import type { GraphEdge, Pin, PinGeometry } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import type { Hit, NodeState } from '../src/graph-view-types';
import type { PointerPress } from '../src/pointer-intent';
import { classifyPointerDown } from '../src/pointer-intent';

const ns = { node: { id: 'n' } } as unknown as NodeState;

function pinGeometry(pin: Partial<Pin> = {}): PinGeometry {
  return {
    pin: {
      id: 'p',
      name: '',
      direction: 'in',
      kind: 'data',
      type: 'any',
      ...pin,
    },
  } as unknown as PinGeometry;
}

const EDGE = {
  id: 'e',
  kind: 'data',
  from: { node: 'a', pin: 'o' },
  to: { node: 'b', pin: 'i' },
} as GraphEdge;

/** The intent's type for a left click on `hit`, with `extra` changes. */
function intent(hit: Hit | null, extra: Partial<PointerPress> = {}): string {
  return classifyPointerDown({
    hit,
    button: 0,
    pointerType: 'mouse',
    spaceDown: false,
    shift: false,
    ctrl: false,
    alt: false,
    editable: true,
    wireEnds: () => [],
    wireAt: () => null,
    ...extra,
  }).type;
}

/** A boolean value on a pin. */
function booleanLiteral(value: string): Hit {
  return {
    type: 'literal',
    ns,
    pg: pinGeometry({
      literal: { kind: 'boolean', value, raw: value, editable: true },
    }),
  };
}

describe('classifyPointerDown', () => {
  it('pans with the middle or right button, Space or a touch', () => {
    const node: Hit = { type: 'node', ns };
    expect(intent(node, { button: 1 })).toBe('pan');
    expect(intent(node, { button: 2 })).toBe('pan');
    expect(intent(node, { spaceDown: true })).toBe('pan');
    expect(intent(null, { pointerType: 'touch' })).toBe('pan');
    expect(intent(node, { button: 3 })).toBe('none');
  });

  it('starts a wire from a pin, moves its wires with Ctrl, breaks them with Alt', () => {
    const pin: Hit = { type: 'pin', ns, pg: pinGeometry() };
    expect(intent(pin)).toBe('wire');
    expect(intent(pin, { alt: true })).toBe('disconnectPin');
    expect(intent(pin, { ctrl: true })).toBe('wire');
    expect(
      intent(pin, { ctrl: true, wireEnds: () => [{ ns, pg: pinGeometry() }] })
    ).toBe('moveWires');
    // Read-only: the pin's node is selected instead.
    expect(intent(pin, { editable: false })).toBe('node');
  });

  it('toggles a boolean value like a checkbox', () => {
    expect(
      classifyPointerDown({
        hit: booleanLiteral('true'),
        button: 0,
        pointerType: 'mouse',
        spaceDown: false,
        shift: false,
        ctrl: false,
        alt: false,
        editable: true,
        wireEnds: () => [],
        wireAt: () => null,
      })
    ).toMatchObject({ type: 'toggleCheckbox', value: 'false' });
    expect(intent(booleanLiteral('false'), { editable: false })).toBe('node');
  });

  it("acts on a node's ▼ row and Add pin, else selects it", () => {
    expect(intent({ type: 'node', ns, advanced: true })).toBe('toggleAdvanced');
    expect(intent({ type: 'node', ns, addPin: true })).toBe('addArgument');
    expect(intent({ type: 'node', ns })).toBe('node');
    expect(intent({ type: 'bubble', ns })).toBe('node');
  });

  it('removes a reroute point with Alt, else selects it', () => {
    const knot: Hit = { type: 'knot', edgeId: 'e', index: 0 };
    expect(intent(knot)).toBe('knot');
    expect(intent(knot, { alt: true })).toBe('removeKnot');
  });

  it('breaks a wire with Alt on empty space, else draws a marquee', () => {
    expect(intent(null)).toBe('marquee');
    expect(intent(null, { alt: true })).toBe('marquee');
    expect(intent(null, { alt: true, wireAt: () => EDGE })).toBe('breakWire');
    expect(
      intent(null, { alt: true, wireAt: () => EDGE, editable: false })
    ).toBe('marquee');
  });
});
