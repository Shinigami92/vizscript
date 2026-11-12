import { describe, expect, it } from 'vitest';
import {
  clickSelection,
  distanceToWire,
  easeOut,
  fitCamera,
  formatCameraParam,
  lerpCamera,
  marqueeSelection,
  parseCameraParam,
  screenToWorld,
  SpatialIndex,
  wireCurve,
  worldToScreen,
  zoomAt,
} from '../src';
import { BUBBLE_LINE_HEIGHT, BUBBLE_PADDING_Y, layoutBubble } from '../src';

describe('camera URL param', () => {
  it('round-trips and rounds', () => {
    const text = formatCameraParam({ x: -40.6, y: 120.2, zoom: 0.85432 });
    expect(text).toBe('-41,120,0.854');
    expect(parseCameraParam(text)).toEqual({ x: -41, y: 120, zoom: 0.854 });
  });

  it('rejects malformed values and clamps the zoom', () => {
    expect(parseCameraParam('1,2')).toBeNull();
    expect(parseCameraParam('a,b,c')).toBeNull();
    expect(parseCameraParam('1,2,0')).toBeNull();
    expect(parseCameraParam(undefined)).toBeNull();
    expect(parseCameraParam(['3,4,99'])?.zoom).toBe(2);
  });
});

describe('camera', () => {
  it('round-trips between screen and world', () => {
    const camera = { x: 100, y: -50, zoom: 0.5 };
    const world = screenToWorld(camera, { x: 40, y: 80 });
    expect(worldToScreen(camera, world)).toEqual({ x: 40, y: 80 });
  });

  it('keeps the anchor fixed while zooming', () => {
    const camera = { x: 10, y: 20, zoom: 1 };
    const anchor = { x: 300, y: 200 };
    const before = screenToWorld(camera, anchor);
    const after = screenToWorld(zoomAt(camera, anchor, 1.7), anchor);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it('clamps zoom', () => {
    expect(zoomAt({ x: 0, y: 0, zoom: 1 }, { x: 0, y: 0 }, 100).zoom).toBe(2);
  });

  it('fits bounds into the viewport', () => {
    const camera = fitCamera(
      { x: 0, y: 0, width: 1000, height: 500 },
      500,
      500,
      0
    );
    expect(camera.zoom).toBe(0.5);
    expect(worldToScreen(camera, { x: 500, y: 250 })).toEqual({
      x: 250,
      y: 250,
    });
  });

  it('eases between two cameras', () => {
    const from = { x: 0, y: 0, zoom: 1 };
    const to = { x: 100, y: 50, zoom: 0.25 };
    expect(lerpCamera(from, to, 0, 400, 200)).toEqual(from);
    const end = lerpCamera(from, to, 1, 400, 200);
    expect(end.x).toBeCloseTo(to.x);
    expect(end.y).toBeCloseTo(to.y);
    expect(end.zoom).toBeCloseTo(to.zoom);
    // Halfway in zoom steps (geometric), not in zoom values.
    expect(lerpCamera(from, to, 0.5, 400, 200).zoom).toBeCloseTo(0.5);
  });

  it('eases out', () => {
    expect(easeOut(0)).toBe(0);
    expect(easeOut(1)).toBe(1);
    expect(easeOut(0.5)).toBeGreaterThan(0.5);
    expect(easeOut(2)).toBe(1);
  });
});

describe('wires', () => {
  it('measures distance to a bezier wire', () => {
    const wire = wireCurve({ x: 0, y: 0 }, { x: 200, y: 0 });
    expect(distanceToWire(wire, { x: 100, y: 0 })).toBeLessThan(0.5);
    expect(distanceToWire(wire, { x: 100, y: 30 })).toBeCloseTo(30, 0);
  });
});

describe('SpatialIndex', () => {
  it('queries intersecting items', () => {
    const index = new SpatialIndex<string>(100);
    index.insert('a', { x: 0, y: 0, width: 50, height: 50 });
    index.insert('b', { x: 500, y: 500, width: 50, height: 50 });
    index.insert('c', { x: 90, y: 90, width: 200, height: 200 });
    expect(
      index.query({ x: 40, y: 40, width: 60, height: 60 }).toSorted()
    ).toEqual(['a', 'c']);
    index.remove('a');
    expect(index.query({ x: 0, y: 0, width: 10, height: 10 })).toEqual([]);
  });
});

describe('selection', () => {
  const none = { add: false, toggle: false };

  it('selects a single node on click', () => {
    expect([...clickSelection(new Set(['a']), 'b', none)]).toEqual(['b']);
  });

  it('keeps the group when clicking a selected node', () => {
    expect([...clickSelection(new Set(['a', 'b']), 'b', none)]).toEqual([
      'a',
      'b',
    ]);
  });

  it('toggles with ctrl and adds with shift', () => {
    expect([
      ...clickSelection(new Set(['a', 'b']), 'b', { add: false, toggle: true }),
    ]).toEqual(['a']);
    expect([
      ...clickSelection(new Set(['a']), 'b', { add: true, toggle: false }),
    ]).toEqual(['a', 'b']);
  });

  it('combines marquee hits with the base selection', () => {
    expect([
      ...marqueeSelection(new Set(['a']), ['b'], { add: true, toggle: false }),
    ]).toEqual(['a', 'b']);
    expect([
      ...marqueeSelection(new Set(['a']), ['a', 'b'], {
        add: false,
        toggle: true,
      }),
    ]).toEqual(['b']);
    expect([...marqueeSelection(new Set(['a']), ['b'], none)]).toEqual(['b']);
  });
});

function measure(text: string): number {
  return text.length * 7;
}

describe('layoutBubble', () => {
  it('wraps words and keeps paragraphs', () => {
    const bubble = layoutBubble('one two three four\nfive', measure, 70);
    expect(bubble.lines).toEqual(['one two', 'three four', 'five']);
    expect(bubble.height).toBe(3 * BUBBLE_LINE_HEIGHT + BUBBLE_PADDING_Y * 2);
  });

  it('truncates long comments with an ellipsis', () => {
    const bubble = layoutBubble('a b c d e f g h i j', measure, 14, 3);
    expect(bubble.lines).toEqual(['a', 'b', 'c…']);
  });
});
