import { describe, expect, it } from 'vitest';
import type { GraphDocument, Positions } from '../src';
import {
  boxColorKey,
  isExtraLayoutKey,
  joinKey,
  looseLayoutKeys,
  noReroutesKey,
  reconcileLayout,
  rerouteKey,
  viaKey,
} from '../src';

const EMPTY: GraphDocument = {
  language: 'test',
  diagnostics: [],
  functions: [],
};

/** One entry of every kind besides node positions. */
const EXTRA: Positions = {
  [rerouteKey('a:out->b:in', 0)]: { x: 1, y: 2 },
  [noReroutesKey('c:out->d:in')]: { x: 0, y: 0 },
  [viaKey('get1')]: { x: 0, y: 0 },
  [joinKey('get2', 'get3')]: { x: 0, y: 0 },
  [boxColorKey('box')]: { x: 2, y: 0 },
  ...looseLayoutKeys({
    edits: [
      {
        type: 'addNodes',
        id: 'loose1',
        fnId: 'fn:f',
        code: 'print(x)',
        nodes: [],
        edges: [],
      },
      {
        type: 'addEdge',
        kind: 'data',
        from: { node: 'fn:f/getVar:x#0', pin: 'value' },
        to: { node: 'overlay:loose1/n', pin: 'arg0' },
      },
    ],
  }),
};

describe('layout entries', () => {
  it('tells every kind of entry from node positions', () => {
    expect(Object.keys(EXTRA).filter((key) => !isExtraLayoutKey(key))).toEqual(
      []
    );

    expect(isExtraLayoutKey('fn:f/call:g#0')).toBe(false);
  });

  it('keeps every kind of entry through a re-parse', () => {
    // A node that is gone loses its position; nothing else is lost.
    const positions = { ...EXTRA, 'fn:f/call:gone#0': { x: 5, y: 5 } };
    expect(reconcileLayout(EMPTY, EMPTY, positions)).toEqual(EXTRA);
    expect(reconcileLayout(undefined, EMPTY, positions)).toEqual(EXTRA);
  });
});
