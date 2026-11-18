import type { Conversion, Pin, PinGeometry } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { knotId } from '../src/graph-view-constants';
import type { Hit, NodeState } from '../src/graph-view-types';
import type { PinRef } from '../src/pin-ref';
import {
  connectOp,
  hoverOf,
  knotsInRect,
  moveDropTarget,
  panCamera,
  pastThreshold,
  pinchCamera,
  snappedOffset,
  wireDropTarget,
} from '../src/pointer-drag';

function ref(node: string, pin: Partial<Pin> & Pick<Pin, 'direction'>): PinRef {
  return {
    ns: { node: { id: node }, fnId: 'f', full: {} } as unknown as NodeState,
    pg: {
      pin: { id: 'p', name: '', kind: 'data', type: 'any', ...pin },
    } as unknown as PinGeometry,
  };
}

function pinHit(end: PinRef): Hit {
  return { type: 'pin', ns: end.ns, pg: end.pg };
}

const TO_STRING: Conversion = {
  from: 'number',
  to: 'string',
  template: 'String($value)',
};

describe('drag cameras', () => {
  it('pans by the screen offset at the start zoom', () => {
    expect(panCamera({ x: 10, y: 20, zoom: 2 }, 40, -20)).toEqual({
      x: -10,
      y: 30,
      zoom: 2,
    });
    expect(pastThreshold(1, 2)).toBe(false);
    expect(pastThreshold(3, 0)).toBe(true);
  });

  it('zooms a pinch by the spread of the fingers, moving with them', () => {
    const start = {
      camera: { x: 0, y: 0, zoom: 1 },
      mid: { x: 100, y: 100 },
      distance: 100,
    };
    // Twice as far apart around the same midpoint: zoom 2 there.
    const camera = pinchCamera(start, { x: 0, y: 100 }, { x: 200, y: 100 });
    expect(camera.zoom).toBe(2);
    expect(camera.x).toBe(50);
    // Moved by 20 px without spreading: the view follows.
    const moved = pinchCamera(start, { x: 70, y: 100 }, { x: 170, y: 100 });
    expect(moved).toEqual({ x: -20, y: 0, zoom: 1 });
  });
});

describe('dragging nodes and marquees', () => {
  it('snaps the grabbed node to the grid', () => {
    expect(snappedOffset({ x: 0, y: 0 }, 13, 2)).toEqual({ x: 16, y: 0 });
  });

  it('finds reroute points inside a rectangle', () => {
    const reroutes = new Map([
      [
        'e',
        [
          { x: 5, y: 5 },
          { x: 50, y: 50 },
        ],
      ],
      ['f', [{ x: 10, y: 0 }]],
    ]);
    expect(
      knotsInRect(reroutes, { x: 0, y: 0, width: 20, height: 20 })
    ).toEqual([knotId('e', 0), knotId('f', 0)]);
  });
});

describe('dragging wires', () => {
  const out = ref('a', { direction: 'out', type: 'number' });
  const input = ref('b', { direction: 'in', type: 'number' });
  const text = ref('b', { direction: 'in', type: 'string' });

  it('targets a fitting pin, says why another does not fit', () => {
    expect(
      wireDropTarget(out, pinHit(input), undefined, () => false)
    ).toMatchObject({
      target: input,
      problem: null,
      replaces: null,
      empty: false,
    });
    expect(
      wireDropTarget(out, pinHit(text), undefined, () => false)
    ).toMatchObject({
      target: null,
      problem: 'number is not compatible with string.',
    });
    expect(
      wireDropTarget(out, pinHit(text), [TO_STRING], () => false)
    ).toMatchObject({
      target: text,
      convert: TO_STRING,
    });
    expect(wireDropTarget(out, null, undefined, () => false)).toMatchObject({
      target: null,
      empty: true,
    });
  });

  it('replaces the wire of a data input or an exec output', () => {
    expect(
      wireDropTarget(
        out,
        pinHit(input),
        undefined,
        (end) => end.ns.node.id === 'b'
      ).replaces
    ).toBe('input');
    const execOut = ref('a', { direction: 'out', kind: 'exec' });
    const execIn = ref('b', { direction: 'in', kind: 'exec' });
    expect(
      wireDropTarget(
        execIn,
        pinHit(execOut),
        undefined,
        (end) => end.ns.node.id === 'a'
      ).replaces
    ).toBe('output');
  });

  it('moves wires only where all of them fit', () => {
    const drag = { from: out, ends: [text] };
    const other = ref('c', { direction: 'out', type: 'string' });
    expect(moveDropTarget(drag, pinHit(other))).toEqual({
      target: other,
      problem: null,
    });
    expect(moveDropTarget(drag, pinHit(input))).toMatchObject({ target: null });
  });

  it('connects output to input, with a conversion', () => {
    expect(connectOp(input, out, TO_STRING)).toEqual({
      type: 'connect',
      from: { node: 'a', pin: 'p' },
      to: { node: 'b', pin: 'p' },
      convert: 'String($value)',
    });
  });
});

describe('hoverOf', () => {
  const pin = ref('n', { direction: 'in' });

  it('shows UE-like cursors', () => {
    expect(hoverOf(pinHit(pin), null, true, false)).toMatchObject({
      cursor: 'crosshair',
      node: 'n',
      pin: 'p',
    });
    expect(hoverOf(pinHit(pin), null, false, false).cursor).toBe('move');
    expect(hoverOf(null, 'e', true, false)).toMatchObject({
      cursor: 'pointer',
      edge: 'e',
    });
    expect(hoverOf(null, null, true, true).cursor).toBe('grab');
    expect(
      hoverOf({ type: 'node', ns: pin.ns, addPin: true }, null, true, false)
    ).toMatchObject({ cursor: 'pointer', addPin: 'n' });
  });
});
