import { noReroutesKey, pinKey, rerouteKey } from '@vizscript/core';
import type {
  FunctionGraph,
  GraphDocument,
  GraphEdge,
  GraphNode,
  MeasureText,
  Pin,
  Positions,
} from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { BUBBLE_GAP } from '../src/bubble';
import { rectContains } from '../src/camera';
import {
  BANNER_HEIGHT,
  COMMENT_HEADER,
  COMMENT_PADDING,
} from '../src/graph-view-constants';
import { Scene } from '../src/scene';

const measure: MeasureText = (text) => text.length * 7;

function pin(
  id: string,
  direction: Pin['direction'],
  kind: Pin['kind'] = 'exec'
): Pin {
  return {
    id,
    name: id,
    direction,
    kind,
    type: kind === 'exec' ? 'exec' : 'number',
  };
}

function node(
  id: string,
  kind: GraphNode['kind'],
  pins: Pin[],
  extra: Partial<GraphNode> = {}
): GraphNode {
  return {
    id,
    kind,
    category: kind === 'entry' ? 'entry' : 'function',
    purity: 'impure',
    title: id,
    range: { start: 0, end: 0 },
    path: id,
    pins,
    ...extra,
  };
}

function edge(
  id: string,
  from: string,
  to: string,
  kind: GraphEdge['kind'] = 'exec'
): GraphEdge {
  const [fromNode = '', fromPin = ''] = from.split('.');
  const [toNode = '', toPin = ''] = to.split('.');
  return {
    id,
    kind,
    from: { node: fromNode, pin: fromPin },
    to: { node: toNode, pin: toPin },
  };
}

/**
 * `main`: an entry, `a` right of it, `b` on the row below (a wrapped exec
 * chain), `loose` wired to nothing, and a comment box around `a` and `b`.
 */
function sample(extra: Partial<FunctionGraph> = {}): GraphDocument {
  return {
    language: 'test',
    diagnostics: [],
    functions: [
      {
        id: 'main',
        name: 'main',
        range: { start: 0, end: 0 },
        nodes: [
          node('entry', 'entry', [pin('then', 'out')]),
          node('a', 'call', [pin('exec', 'in'), pin('then', 'out')]),
          node(
            'b',
            'call',
            [pin('exec', 'in'), pin('then', 'out'), pin('n', 'in', 'data')],
            { comment: { text: 'Note', range: { start: 0, end: 0 } } }
          ),
          node('loose', 'call', [pin('exec', 'in')]),
        ],
        edges: [
          edge('e1', 'entry.then', 'a.exec'),
          edge('e2', 'a.then', 'b.exec'),
        ],
        comments: [
          {
            id: 'box',
            title: 'Box',
            range: { start: 0, end: 0 },
            titleRange: { start: 0, end: 0 },
            markers: [
              { start: 0, end: 0 },
              { start: 0, end: 0 },
            ],
            nodes: ['a', 'b'],
          },
        ],
        ...extra,
      },
    ],
  };
}

const POSITIONS: Positions = {
  entry: { x: 0, y: 0 },
  a: { x: 400, y: 0 },
  b: { x: 0, y: 200 },
  loose: { x: 800, y: 600 },
};

function loaded(positions: Positions = POSITIONS, doc = sample()): Scene {
  const scene = new Scene(measure);
  scene.load(doc, positions);
  return scene;
}

describe('Scene.load', () => {
  it('places nodes at their positions and indexes them', () => {
    const scene = loaded({ a: { x: 400, y: 0 } });
    expect(scene.nodes.get('a')).toMatchObject({ x: 400, y: 0, fnId: 'main' });
    expect(scene.nodes.get('b')).toMatchObject({ x: 0, y: 0 });
    expect(scene.index.query({ x: 401, y: 1, width: 1, height: 1 })).toEqual([
      'a',
    ]);
  });

  it('collects wires and the pins they connect', () => {
    const scene = loaded();
    expect(scene.edges.map((e) => e.edge.id)).toEqual(['e1', 'e2']);
    expect(scene.edgesByNode.get('a')?.map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(scene.connectedPins).toEqual(
      new Set(
        ['entry.then', 'a.exec', 'a.then', 'b.exec'].map((ref) => {
          const [n = '', p = ''] = ref.split('.');
          return pinKey({ node: n, pin: p });
        })
      )
    );
  });

  it('keeps nodes not wired in out of the function frame', () => {
    const scene = loaded();
    const [frame, box] = scene.frames;
    expect(frame).toMatchObject({ kind: 'function', fnId: 'main' });
    expect(frame?.nodeIds).toEqual(['entry', 'a', 'b']);
    expect(box).toMatchObject({ kind: 'comment', boxId: 'box', name: 'Box' });
  });

  it('returns the nodes shown before', () => {
    const scene = loaded();
    const before = scene.nodes.get('a');
    const previous = scene.load(sample(), POSITIONS);
    expect(previous.get('a')).toBe(before);
    expect(scene.nodes.get('a')).not.toBe(before);
  });

  it('gives a wrapped exec chain two reroute points above the lower row', () => {
    const scene = loaded();
    const knots = scene.reroutes.get('e2');
    expect(knots).toHaveLength(2);
    expect(knots?.every((k) => k.y === 178)).toBe(true);
    expect(scene.reroutes.has('e1')).toBe(false);
  });

  it('keeps saved reroute points, and none where they were removed', () => {
    const saved = loaded({
      ...POSITIONS,
      [rerouteKey('e2', 0)]: { x: 10, y: 20 },
      [rerouteKey('gone', 0)]: { x: 1, y: 1 },
    });
    expect(saved.reroutes.get('e2')).toEqual([{ x: 10, y: 20 }]);
    expect(saved.reroutes.has('gone')).toBe(false);

    const removed = loaded({
      ...POSITIONS,
      [noReroutesKey('e2')]: { x: 0, y: 0 },
    });
    expect(removed.reroutes.has('e2')).toBe(false);
  });
});

describe('Scene frames and bounds', () => {
  it('puts comment boxes around their nodes and frames around the boxes', () => {
    const scene = loaded();
    scene.updateFrames();
    const [frame, box] = scene.frames;
    const a = scene.nodes.get('a');
    const b = scene.nodes.get('b');
    expect(box?.bounds?.x).toBe(-COMMENT_PADDING);
    // `a` is the top; `b`'s bubble stays below it.
    expect(box?.bounds?.y).toBe(-COMMENT_PADDING - COMMENT_HEADER);
    expect(box?.bounds?.height).toBe(
      200 + (b?.geom.height ?? 0) + COMMENT_PADDING * 2 + COMMENT_HEADER
    );
    expect(box?.bounds?.width).toBe(
      400 + (a?.geom.width ?? 0) + COMMENT_PADDING * 2
    );
    expect(
      frame?.bounds && box?.bounds && rectContains(frame.bounds, box.bounds)
    ).toBe(true);
    expect(scene.framesDirty).toBe(false);
  });

  it('measures sliding nodes where they go, with their bubbles', () => {
    const scene = loaded();
    const b = scene.nodes.get('b');
    if (!b?.bubble) {
      throw new Error('b has a bubble');
    }

    b.tween = { from: { x: 0, y: 200 }, to: { x: 50, y: 300 }, start: 0 };
    expect(scene.boundsOf(['b'])).toMatchObject({
      x: 50,
      y: 300 - b.bubble.height - BUBBLE_GAP,
    });
    expect(scene.boundsOf(['nope'])).toBeNull();
  });

  it('makes nodes with a problem taller by the banner', () => {
    const scene = loaded();
    const height = scene.nodes.get('a')?.geom.height ?? 0;
    expect(scene.setProblems(new Map([['a', 'error']]))).toBe(true);
    expect(scene.nodes.get('a')?.geom.height).toBe(height + BANNER_HEIGHT);
    expect(scene.setProblems(new Map([['a', 'warning']]))).toBe(false);
    expect(scene.setProblems(new Map())).toBe(true);
    expect(scene.nodes.get('a')?.geom.height).toBe(height);
  });
});

describe('Scene queries', () => {
  const view = { zoom: 1, editable: true, selection: new Set<string>() };

  it('finds the node and the function under a point', () => {
    const scene = loaded();
    const a = scene.nodes.get('a');
    const hit = scene.hitTest(
      { x: 400 + (a?.geom.width ?? 0) / 2, y: 2 },
      view
    );
    expect(hit?.type === 'node' && hit.ns.node.id).toBe('a');
    expect(scene.functionAt({ x: 10, y: 10 })).toBe('main');
    expect(scene.functionAt({ x: 5000, y: 5000 })).toBeUndefined();
  });

  it('lists the other ends of a pin’s wires', () => {
    const scene = loaded();
    const a = scene.nodes.get('a');
    const exec = a?.geom.pins.get('exec');
    if (!a || !exec) {
      throw new Error('a has an exec input');
    }

    expect(scene.wireEnds(a, exec).map((end) => end.ns.node.id)).toEqual([
      'entry',
    ]);
  });

  it('finds the wire near a point', () => {
    const scene = loaded();
    const entry = scene.nodes.get('entry');
    const a = scene.nodes.get('a');
    const out = entry?.geom.pins.get('then');
    const into = a?.geom.pins.get('exec');
    if (!entry || !a || !out || !into) {
      throw new Error('e1 has both ends');
    }

    const from = scene.pinWorld(entry, out);
    const to = scene.pinWorld(a, into);
    const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
    expect(scene.hitWire(mid, 8)?.edge.id).toBe('e1');
    expect(scene.hitWire({ x: mid.x, y: mid.y + 500 }, 8)).toBeNull();
  });
});
