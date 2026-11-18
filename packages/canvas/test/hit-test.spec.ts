import type { GraphNode, Point } from '@vizscript/core';
import { computeNodeGeometry } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import type { Rect } from '../src/camera';
import type { FrameState, NodeState } from '../src/graph-view-types';
import type { HitScene } from '../src/hit-test';
import { hitTest, topFirst } from '../src/hit-test';

/** A call node with one input and one output, at `x`, `y`. */
function nodeAt(id: string, x: number, y: number, extra = {}): NodeState {
  const node: GraphNode = {
    id,
    kind: 'call',
    category: 'function',
    purity: 'pure',
    title: id,
    range: { start: 0, end: 0 },
    path: id,
    pins: [
      { id: 'in', name: 'in', direction: 'in', kind: 'data', type: 'number' },
      {
        id: 'out',
        name: 'out',
        direction: 'out',
        kind: 'data',
        type: 'number',
      },
    ],
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
    ...extra,
  };
}

/** Whether a node's rectangle meets `r`. */
function meets(ns: NodeState, r: Rect): boolean {
  return (
    ns.x < r.x + r.width &&
    r.x < ns.x + ns.geom.width &&
    ns.y < r.y + r.height &&
    r.y < ns.y + ns.geom.height
  );
}

/** A scene of `nodes` (the last drawn on top). */
function scene(
  nodes: ReadonlyArray<NodeState>,
  extra: Partial<HitScene> = {}
): HitScene {
  return {
    zoom: 1,
    editable: true,
    nodesAt: (rect) => nodes.filter((ns) => meets(ns, rect)).toReversed(),
    nodes,
    reroutes: new Map(),
    frames: [],
    literalRect: () => null,
    bubbleRect: () => null,
    ...extra,
  };
}

/** A frame over a large area, holding `nodeIds`. */
function frame(
  kind: FrameState['kind'],
  name: string,
  nodeIds: string[]
): FrameState {
  return {
    kind,
    fnId: 'f',
    name,
    nodeIds,
    bounds: { x: -300, y: -300, width: 1000, height: 1000 },
  };
}

/** `type id` of what is hit. */
function at(s: HitScene, world: Point): string {
  const hit = hitTest(s, world);
  switch (hit?.type) {
    case 'pin':
    case 'literal': {
      return `${hit.type} ${hit.ns.node.id}.${hit.pg.pin.id}`;
    }

    case 'node':
    case 'bubble': {
      const extra = hit.type === 'node' && hit.addPin ? ' addPin' : '';
      return `${hit.type} ${hit.ns.node.id}${extra}`;
    }

    case 'knot': {
      return `knot ${hit.edgeId}#${hit.index}`;
    }

    case 'frame': {
      return `frame ${hit.frame.name}`;
    }

    case undefined: {
      return 'nothing';
    }
  }
}

describe('hitTest', () => {
  const a = nodeAt('a', 0, 0);
  const inPin = a.geom.pins.get('in');
  const pinPoint = { x: (inPin?.x ?? 0) - 4, y: inPin?.y ?? 0 };

  it('finds pins first, a little outside the node too', () => {
    expect(at(scene([a]), pinPoint)).toBe('pin a.in');
    expect(at(scene([a]), { x: a.geom.width / 2, y: 10 })).toBe('node a');
    expect(at(scene([a]), { x: -100, y: -100 })).toBe('nothing');
  });

  it('takes the node drawn on top where nodes overlap', () => {
    const b = nodeAt('b', 30, 5);
    const point = { x: 60, y: 12 };
    expect(at(scene([a, b]), point)).toBe('node b');
    expect(at(scene([b, a]), point)).toBe('node a');
  });

  it('finds inline values and "Add pin +" (only when editable)', () => {
    const value = { x: 20, y: 20, width: 30, height: 14 };
    expect(
      at(
        scene([a], {
          literalRect: (_ns, pg) => (pg.pin.id === 'in' ? value : null),
        }),
        {
          x: 30,
          y: 25,
        }
      )
    ).toBe('literal a.in');
    const withAdd = nodeAt('c', 0, 0);
    withAdd.geom = {
      ...withAdd.geom,
      addPin: { x: 40, y: 50, width: 50 },
    };
    expect(at(scene([withAdd]), { x: 60, y: 50 })).toBe('node c addPin');
    expect(at(scene([withAdd], { editable: false }), { x: 60, y: 50 })).toBe(
      'node c'
    );
  });

  it('finds reroute points only where no node is drawn over them', () => {
    const reroutes = new Map([
      [
        'e',
        [
          { x: 500, y: 500 },
          { x: 20, y: 10 },
        ],
      ],
    ]);
    expect(at(scene([a], { reroutes }), { x: 502, y: 499 })).toBe('knot e#0');
    expect(at(scene([a], { reroutes }), { x: 20, y: 10 })).toBe('node a');
  });

  it('finds comment bubbles and frame headers, inner boxes first', () => {
    const bubble = { x: 0, y: -60, width: 200, height: 40 };
    expect(
      at(scene([a], { bubbleRect: () => bubble }), { x: 10, y: -50 })
    ).toBe('bubble a');
    const frames = [
      frame('function', 'fn', ['a', 'b', 'c']),
      frame('comment', 'box', ['a']),
    ];
    expect(at(scene([], { frames }), { x: -290, y: -295 })).toBe('frame box');
    expect(at(scene([], { frames }), { x: 0, y: 200 })).toBe('nothing');
  });
});

describe('topFirst', () => {
  it('reverses the drawing order, selected nodes first', () => {
    expect(topFirst(['a', 'b', 'c'], new Set())).toEqual(['c', 'b', 'a']);
    expect(topFirst(['a', 'b', 'c'], new Set(['a']))).toEqual(['a', 'c', 'b']);
  });
});
