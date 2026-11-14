import { describe, expect, it } from 'vitest';
import type { GraphDocument, GraphNode, Pin, Positions } from '../src';
import {
  applyTextEdits,
  arrayElementType,
  arrayOf,
  computeNodeGeometry,
  createEdge,
  extractReroutes,
  hashString,
  isArrayType,
  isTypeCompatible,
  layoutDocument,
  makeRoomFor,
  NodeIdFactory,
  pinColor,
  reconcilePositions,
  reconcileReroutes,
  rerouteEntries,
  rerouteKey,
  reroutePatch,
  searchNodes,
} from '../src';

function node(
  id: string,
  purity: GraphNode['purity'],
  pins: Pin[],
  path = id
): GraphNode {
  return {
    id,
    kind: purity === 'pure' ? 'operator' : 'call',
    category: purity === 'pure' ? 'pure' : 'function',
    purity,
    title: id,
    range: { start: 0, end: 0 },
    pins,
    path,
  };
}

const execIn: Pin = {
  id: 'exec',
  name: '',
  direction: 'in',
  kind: 'exec',
  type: 'any',
};
const execOut: Pin = {
  id: 'then',
  name: '',
  direction: 'out',
  kind: 'exec',
  type: 'any',
};
const dataIn: Pin = {
  id: 'a',
  name: 'a',
  direction: 'in',
  kind: 'data',
  type: 'any',
};
const dataOut: Pin = {
  id: 'v',
  name: '',
  direction: 'out',
  kind: 'data',
  type: 'any',
};

function sampleDoc(): GraphDocument {
  const entry = {
    ...node('entry', 'impure', [execOut]),
    kind: 'entry' as const,
  };
  return {
    language: 'test',
    diagnostics: [],
    functions: [
      {
        id: 'fn:main',
        name: 'main',
        range: { start: 0, end: 0 },
        nodes: [
          entry,
          node('call1', 'impure', [execIn, execOut, dataIn]),
          node('pure1', 'pure', [dataOut]),
          node('call2', 'impure', [execIn, execOut]),
        ],
        edges: [
          createEdge(
            'exec',
            { node: 'entry', pin: 'then' },
            { node: 'call1', pin: 'exec' }
          ),
          createEdge(
            'exec',
            { node: 'call1', pin: 'then' },
            { node: 'call2', pin: 'exec' }
          ),
          createEdge(
            'data',
            { node: 'pure1', pin: 'v' },
            { node: 'call1', pin: 'a' }
          ),
        ],
      },
    ],
  };
}

const sizeOf = (n: GraphNode) => computeNodeGeometry(n);

describe('ids', () => {
  it('hashes deterministically', () => {
    expect(hashString('abc')).toBe(hashString('abc'));
    expect(hashString('abc')).not.toBe(hashString('abd'));
  });

  it('counts occurrences of identical nodes', () => {
    const ids = new NodeIdFactory('fn:x');
    expect(ids.create('getVar', 'user')).toMatch(/#0$/);
    expect(ids.create('getVar', ' user ')).toMatch(/#1$/);
  });
});

function fnOf(prefix: string): GraphDocument['functions'][number] {
  return {
    id: `fn:${prefix}`,
    name: prefix,
    range: { start: 0, end: 0 },
    nodes: [
      { ...node(`${prefix}0`, 'impure', [execOut]), kind: 'entry' },
      node(`${prefix}1`, 'impure', [execIn, execOut]),
    ],
    edges: [
      createEdge(
        'exec',
        { node: `${prefix}0`, pin: 'then' },
        { node: `${prefix}1`, pin: 'exec' }
      ),
    ],
  };
}

describe('layoutDocument', () => {
  it('lays out exec flow left to right with pure inputs to the left', () => {
    const positions = layoutDocument(sampleDoc(), { sizeOf });
    const { entry, call1, pure1, call2 } = positions;
    expect(entry && call1 && pure1 && call2).toBeTruthy();
    expect(call1!.x).toBeGreaterThan(entry!.x);
    expect(call2!.x).toBeGreaterThan(call1!.x);
    expect(pure1!.x).toBeLessThan(call1!.x);
    expect(pure1!.x).toBeGreaterThan(entry!.x);
  });

  it('keeps saved positions and moves unsaved children along', () => {
    const auto = layoutDocument(sampleDoc(), { sizeOf });
    const saved = { call1: { x: auto.call1!.x + 500, y: auto.call1!.y + 100 } };
    const positions = layoutDocument(sampleDoc(), { sizeOf }, saved);
    expect(positions.call1).toEqual(saved.call1);
    expect(positions.call2!.x - auto.call2!.x).toBe(500);
    expect(positions.pure1!.y - auto.pure1!.y).toBe(100);
    expect(positions.entry).toEqual(auto.entry);
  });

  it('keeps a Return on the row it ends instead of wrapping it', () => {
    const ids = ['e', 'a', 'b', 'c'];
    const nodes: GraphNode[] = [
      { ...node('e', 'impure', [execOut]), kind: 'entry' },
      node('a', 'impure', [execIn, execOut]),
      node('b', 'impure', [execIn, execOut]),
      { ...node('c', 'impure', [execIn]), kind: 'return' },
    ];
    const doc: GraphDocument = {
      language: 'test',
      diagnostics: [],
      functions: [
        {
          id: 'fn:f',
          name: 'f',
          range: { start: 0, end: 0 },
          nodes,
          edges: ids
            .slice(1)
            .map((id, i) =>
              createEdge(
                'exec',
                { node: ids[i] ?? '', pin: 'then' },
                { node: id, pin: 'exec' }
              )
            ),
        },
      ],
    };
    const positions = layoutDocument(doc, { sizeOf, maxRowWidth: 200 });
    // `b` wraps to a new row; the Return after it stays next to it.
    expect(positions.c?.y).toBe(positions.b?.y);
    expect(positions.c?.x ?? 0).toBeGreaterThan(positions.b?.x ?? 0);
  });

  it('moves a function down when another one grew into it', () => {
    const doc: GraphDocument = {
      language: 'test',
      diagnostics: [],
      functions: [fnOf('a'), fnOf('b')],
    };
    const auto = layoutDocument(doc, { sizeOf });
    // A node of `a` saved where `b` starts (and all of `b` saved too).
    const saved: Positions = {
      a1: { x: auto.b1?.x ?? 0, y: auto.b1?.y ?? 0 },
      b0: auto.b0 ?? { x: 0, y: 0 },
      b1: auto.b1 ?? { x: 0, y: 0 },
    };
    const moved = layoutDocument(doc, { sizeOf }, saved);
    expect(moved.a1).toEqual(saved.a1);
    expect(moved.b0?.y ?? 0).toBeGreaterThanOrEqual(
      (saved.a1?.y ?? 0) +
        sizeOf(doc.functions[0]?.nodes[1] ?? node('x', 'impure', [])).height +
        110
    );
    expect(moved.b1?.x).toBe(saved.b1?.x);
  });

  it('keeps a node dropped into an earlier function where it was dropped', () => {
    const doc: GraphDocument = {
      language: 'test',
      diagnostics: [],
      functions: [fnOf('a'), fnOf('b')],
    };
    const auto = layoutDocument(doc, { sizeOf });
    // `b1` dragged up to where `a` is.
    const dropped = { x: auto.b1?.x ?? 0, y: auto.a0?.y ?? 0 };
    const shown = { ...auto, b1: dropped };
    const room = makeRoomFor(doc, shown, new Set(['b1']), { sizeOf });
    // `a` moves up, `b` stays.
    expect(room.a0?.y).toBeLessThan(auto.a0?.y ?? 0);
    expect(room.b0).toBeUndefined();

    const saved: Positions = { ...shown, ...room };
    const laid = layoutDocument(doc, { sizeOf }, saved);
    expect(laid.b1).toEqual(dropped);
    expect(laid.b0).toEqual(auto.b0);
    expect(laid.a0).toEqual(room.a0);
  });

  it('leaves room above nodes for bubbles and comment boxes', () => {
    const doc: GraphDocument = {
      language: 'test',
      diagnostics: [],
      functions: [fnOf('a'), fnOf('b')],
    };
    const plain = layoutDocument(doc, { sizeOf });
    const second = doc.functions[1];
    if (!second) {
      throw new Error('no function');
    }

    second.comments = [
      {
        id: 'box',
        title: 'Box',
        range: { start: 0, end: 0 },
        titleRange: { start: 0, end: 0 },
        markers: [
          { start: 0, end: 0 },
          { start: 0, end: 0 },
        ],
        nodes: ['b1'],
      },
    ];
    const spaced = layoutDocument(doc, {
      sizeOf,
      spaceAbove: (n) => (n.id === 'b0' ? 50 : 0),
      commentBoxTop: 40,
    });
    // The second function moves down by the larger of its row's needs:
    // the entry's bubble (50) or the box title around its first call (40).
    expect(spaced.a0).toEqual(plain.a0);
    expect(spaced.b0!.y - plain.b0!.y).toBe(50);
    // Nodes of one exec row stay aligned.
    expect(spaced.b1!.y).toBe(spaced.b0!.y);
  });
});

describe('reconcilePositions', () => {
  it('matches renamed nodes by structural path', () => {
    const previous = sampleDoc();
    const next = sampleDoc();
    const fn = next.functions[0]!;
    fn.nodes[2] = { ...fn.nodes[2]!, id: 'pure1-changed' };
    const result = reconcilePositions(previous, next, {
      pure1: { x: 1, y: 2 },
      call1: { x: 3, y: 4 },
    });
    expect(result).toEqual({
      'pure1-changed': { x: 1, y: 2 },
      call1: { x: 3, y: 4 },
    });
  });
});

describe('applyTextEdits', () => {
  it('applies edits back to front', () => {
    expect(
      applyTextEdits('hello world', [
        { start: 0, end: 5, text: 'goodbye' },
        { start: 6, end: 11, text: 'moon' },
      ])
    ).toBe('goodbye moon');
  });

  it('throws on overlapping edits', () => {
    expect(() =>
      applyTextEdits('abc', [
        { start: 0, end: 2, text: '' },
        { start: 1, end: 3, text: '' },
      ])
    ).toThrow('Overlapping text edits');
  });
});

describe('array types', () => {
  it('builds and reads element types', () => {
    expect(arrayOf('string')).toBe('string[]');
    expect(arrayOf('any')).toBe('array');
    expect(arrayElementType('Vector3[]')).toBe('Vector3');
    expect(arrayElementType('array')).toBe('any');
    expect(isArrayType('number[]')).toBe(true);
    expect(isArrayType('object')).toBe(false);
  });

  it('colors arrays by their elements and checks compatibility', () => {
    expect(pinColor('string[]')).toBe(pinColor('string'));
    expect(pinColor('number[]', 'light')).toBe(pinColor('number', 'light'));
    expect(pinColor('number', 'light')).not.toBe(pinColor('number'));
    expect(isTypeCompatible('string[]', 'array')).toBe(true);
    expect(isTypeCompatible('string[]', 'number[]')).toBe(false);
    expect(isTypeCompatible('string[]', 'string')).toBe(false);
    expect(isTypeCompatible('Node[]', 'object[]')).toBe(true);
  });
});

describe('isTypeCompatible', () => {
  it('is permissive for any and objects', () => {
    expect(isTypeCompatible('any', 'string')).toBe(true);
    expect(isTypeCompatible('User', 'object')).toBe(true);
    expect(isTypeCompatible('string', 'number')).toBe(false);
  });
});

describe('layoutDocument wrapping', () => {
  it('wraps long exec chains into rows', () => {
    const count = 40;
    const ids = Array.from({ length: count }, (_, i) => `n${i}`);
    const entry = {
      ...node('entry', 'impure', [execOut]),
      kind: 'entry' as const,
    };
    const doc: GraphDocument = {
      language: 'test',
      diagnostics: [],
      functions: [
        {
          id: 'fn:long',
          name: 'long',
          range: { start: 0, end: 0 },
          nodes: [
            entry,
            ...ids.map((id) => node(id, 'impure', [execIn, execOut])),
          ],
          edges: ['entry', ...ids]
            .slice(0, -1)
            .map((from, i) =>
              createEdge(
                'exec',
                { node: from, pin: 'then' },
                { node: ids[i] ?? '', pin: 'exec' }
              )
            ),
        },
      ],
    };
    const positions = layoutDocument(doc, { sizeOf, maxRowWidth: 1000 });
    const xs = Object.values(positions).map((p) => p.x);
    const rows = new Set(Object.values(positions).map((p) => p.y));
    expect(Math.max(...xs)).toBeLessThan(1400);
    expect(rows.size).toBeGreaterThan(3);
  });
});

function makeRerouteDoc(callId: string): GraphDocument {
  return {
    language: 'test',
    diagnostics: [],
    functions: [
      {
        id: 'fn',
        name: 'fn',
        range: { start: 0, end: 0 },
        nodes: [
          node('entry', 'impure', [execOut], 'e'),
          node(callId, 'impure', [execIn, execOut], 'call0'),
        ],
        edges: [
          createEdge(
            'exec',
            { node: 'entry', pin: 'then' },
            { node: callId, pin: 'exec' }
          ),
        ],
      },
    ],
  };
}

describe('reroutes', () => {
  it('round-trips through layout keys', () => {
    const edge = 'a::then->b::exec';
    const patch = reroutePatch(
      edge,
      [],
      [
        { x: 10.4, y: 20 },
        { x: 30, y: 40 },
      ]
    );
    const positions = { a: { x: 0, y: 0 }, ...patch } as Positions;
    expect(extractReroutes(positions)).toEqual({
      [edge]: [
        { x: 10, y: 20 },
        { x: 30, y: 40 },
      ],
    });
    expect(Object.keys(rerouteEntries(positions))).toHaveLength(2);

    const shrink = reroutePatch(
      edge,
      [
        { x: 0, y: 0 },
        { x: 0, y: 0 },
      ],
      [{ x: 5, y: 5 }]
    );
    expect(shrink[rerouteKey(edge, 1)]).toBeNull();
  });

  it('follows nodes matched by structural path', () => {
    const before = makeRerouteDoc('old');
    const after = makeRerouteDoc('new');
    const oldEdge = before.functions[0]?.edges[0]?.id ?? '';
    const newEdge = after.functions[0]?.edges[0]?.id ?? '';
    const result = reconcileReroutes(before, after, {
      entry: { x: 0, y: 0 },
      [rerouteKey(oldEdge, 0)]: { x: 1, y: 2 },
    });
    expect(result).toEqual({ [rerouteKey(newEdge, 0)]: { x: 1, y: 2 } });
  });
});

describe('searchNodes', () => {
  it('matches titles and inline values', () => {
    const literalPin: Pin = {
      ...execIn,
      id: 'arg0',
      kind: 'data',
      name: 'message',
      literal: {
        value: 'Hello',
        raw: "'Hello'",
        kind: 'string',
        editable: true,
      },
    };
    const doc: GraphDocument = {
      language: 'test',
      diagnostics: [],
      functions: [
        {
          id: 'fn',
          name: 'greet',
          range: { start: 0, end: 0 },
          nodes: [
            {
              ...node('entry', 'impure', [execOut]),
              kind: 'entry',
              title: 'greet',
            },
            {
              ...node('log', 'impure', [execIn, literalPin]),
              title: 'console.log',
            },
          ],
          edges: [],
        },
      ],
    };
    expect(searchNodes(doc, 'LOG').map((m) => m.node.id)).toEqual(['log']);
    expect(searchNodes(doc, 'hello')[0]?.field).toBe('value');
    expect(searchNodes(doc, 'mess')[0]?.field).toBe('pin');
    expect(searchNodes(doc, '  ')).toEqual([]);
  });
});

function singleFunctionDoc(nodes: GraphNode[]): GraphDocument {
  return {
    language: 'test',
    diagnostics: [],
    functions: [
      { id: 'fn', name: 'fn', range: { start: 0, end: 0 }, nodes, edges: [] },
    ],
  };
}

describe('reconcilePositions after an insertion', () => {
  it('keeps the position of a node whose text and path both changed', () => {
    const before = singleFunctionDoc([
      { ...node('call-old', 'impure', [], 'body/0'), title: 'set' },
    ]);
    const after = singleFunctionDoc([
      {
        ...node('var-new', 'impure', [], 'body/0'),
        kind: 'setVar',
        title: 'Set x',
      },
      { ...node('call-new', 'impure', [], 'body/1'), title: 'set' },
    ]);
    expect(
      reconcilePositions(before, after, { 'call-old': { x: 5, y: 6 } })
    ).toEqual({ 'call-new': { x: 5, y: 6 } });
  });
});

describe('layoutDocument with saved positions', () => {
  it('moves new nodes away from nodes the user placed', () => {
    const a = node('a', 'impure', [execIn, execOut]);
    const b = node('b', 'impure', [execIn, execOut]);
    const doc: GraphDocument = {
      language: 'test',
      diagnostics: [],
      functions: [
        {
          id: 'fn',
          name: 'fn',
          range: { start: 0, end: 0 },
          nodes: [a, b],
          edges: [
            createEdge(
              'exec',
              { node: 'a', pin: 'then' },
              { node: 'b', pin: 'exec' }
            ),
          ],
        },
      ],
    };
    const auto = layoutDocument(doc, { sizeOf });
    // The user dropped `a` exactly where `b` would go.
    const saved = { a: auto.b ?? { x: 0, y: 0 } };
    const result = layoutDocument(doc, { sizeOf }, saved);
    const size = sizeOf(b);
    const overlap =
      Math.abs((result.a?.x ?? 0) - (result.b?.x ?? 0)) < size.width &&
      Math.abs((result.a?.y ?? 0) - (result.b?.y ?? 0)) < size.height;
    expect(overlap).toBe(false);
  });
});
