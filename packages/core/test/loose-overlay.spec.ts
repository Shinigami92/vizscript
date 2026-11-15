import { describe, expect, it } from 'vitest';
import type { FloatingNodes, GraphEdit } from '../src';
import { looseFromLayout, looseLayoutKeys, splitLoose } from '../src';

function group(id: string): FloatingNodes {
  return {
    type: 'addNodes',
    id,
    fnId: 'fn:f',
    code: 'x',
    nodes: [],
    edges: [],
  };
}

function wire(
  kind: 'data' | 'exec',
  from: string,
  to: string
): Extract<GraphEdit, { type: 'addEdge' }> {
  return {
    type: 'addEdge',
    kind,
    from: { node: from, pin: 'out' },
    to: { node: to, pin: 'in' },
  };
}

describe('loose graph-only nodes', () => {
  it('keeps groups wired to nothing of the code loose', () => {
    const edits: GraphEdit[] = [
      group('a'),
      group('b'),
      // A value of the code read by `a`: still loose.
      wire('data', 'fn:f/getVar:x#0', 'overlay:a/n'),
      wire('data', 'overlay:a/n', 'overlay:b/m'),
    ];
    const { loose, active } = splitLoose({ edits });
    expect(loose.edits).toEqual(edits);
    expect(active.edits).toEqual([]);
  });

  it('makes groups active that feed the code or are in its flow', () => {
    const feeds = [group('a'), wire('data', 'overlay:a/n', 'fn:f/call:g#0')];
    expect(splitLoose({ edits: feeds }).loose.edits).toEqual([]);

    const runs = [group('b'), wire('exec', 'fn:f/call:g#0', 'overlay:b/m')];
    expect(splitLoose({ edits: runs }).active.edits).toEqual(runs);

    // A group wired to an active one is active too.
    const chained = [
      group('c'),
      group('d'),
      wire('data', 'overlay:c/n', 'overlay:d/m'),
      wire('data', 'overlay:d/m', 'fn:f/call:g#0'),
    ];
    expect(splitLoose({ edits: chained }).loose.edits).toEqual([]);
  });

  it('keeps edits of the code active', () => {
    const removal: GraphEdit = { type: 'removeNode', node: 'fn:f/call:g#0' };
    const { loose, active } = splitLoose({ edits: [group('a'), removal] });
    expect(loose.edits).toEqual([group('a')]);
    expect(active.edits).toEqual([removal]);
  });
});

describe('loose nodes in the layout', () => {
  it('stores a group in parts of keys and reads it back', () => {
    const code = `for (const x of xs) {\n  log("${'é'.repeat(200)}", x | 1);\n}`;
    const loose: GraphEdit[] = [
      {
        ...group('g1'),
        code,
        nodes: [
          {
            id: 'overlay:g1/fn:f/forEach:a#0',
            path: '',
            kind: 'forEach',
            title: 'For Each',
            category: 'flow',
            purity: 'impure',
            range: { start: 0, end: 1 },
            pins: [
              {
                id: 'exec',
                name: '',
                direction: 'in',
                kind: 'exec',
                type: 'any',
              },
            ],
          },
        ],
      },
      wire('data', 'fn:f/getVar:xs#0', 'overlay:g1/fn:f/forEach:a#0'),
    ];
    const keys = looseLayoutKeys({ edits: loose });
    expect(Object.keys(keys).every((k) => k.length <= 512)).toBe(true);
    expect(Object.keys(keys).length).toBeGreaterThan(2);
    const back = looseFromLayout({ ...keys, other: { x: 1, y: 2 } });
    expect(back.groups).toEqual([
      { id: 'g1', fnId: 'fn:f', statement: true, code },
    ]);
    expect(back.wires).toEqual([loose[1]]);
  });
});
