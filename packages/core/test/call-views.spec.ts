import { describe, expect, it } from 'vitest';
import type { ContainerOp } from '../src';
import {
  callViewKey,
  compactTitle,
  isExtraLayoutKey,
  reconcileLayout,
  shownAsCall,
  styleContainerNode,
  withCallViews,
} from '../src';
import type { GraphDocument, GraphNode, Pin } from '../src/ir';

const INCLUDES: ContainerOp = {
  word: 'CONTAINS',
  label: 'INCLUDES',
  on: ['array'],
  form: 'method',
  name: 'includes',
  args: ['element'],
  result: 'bool',
};

function pin(id: string, direction: Pin['direction'], extra = {}): Pin {
  return { id, name: id, direction, kind: 'data', type: 'any', ...extra };
}

/** `items.includes(x)`, a pure read, drawn as INCLUDES. */
function includes(): GraphNode {
  const node: GraphNode = {
    id: 'f/call:includes#0',
    kind: 'call',
    category: 'pure',
    purity: 'pure',
    title: 'includes',
    range: { start: 0, end: 17 },
    path: 'f.0',
    pins: [
      pin('target', 'in', { range: { start: 0, end: 5 } }),
      pin('arg0', 'in', { range: { start: 15, end: 16 } }),
      pin('return', 'out'),
    ],
  };
  styleContainerNode(node, INCLUDES, 'string[]', 'target');
  return node;
}

function doc(node: GraphNode): GraphDocument {
  return {
    language: 'typescript',
    diagnostics: [],
    functions: [
      { id: 'f', name: 'f', range: node.range, nodes: [node], edges: [] },
    ],
  };
}

describe('withCallViews', () => {
  it('draws a container node the layout names as its call', () => {
    const styled = doc(includes());
    const shown = withCallViews(styled, {
      [callViewKey('f/call:includes#0')]: { x: 0, y: 0 },
    }).functions[0]?.nodes[0];
    expect(shown && compactTitle(shown)).toBe('includes');
    expect(shown?.compact).toBeUndefined();
    expect(shown?.purity).toBe('pure');
    // What the container node knows stays: the value's type.
    expect(shown?.pins.map((p) => `${p.id}:${p.type}`)).toEqual([
      'target:string[]',
      'arg0:string',
      'return:bool',
    ]);
    expect(shown && shownAsCall(shown)).toEqual({
      word: 'CONTAINS',
      label: 'INCLUDES',
    });
  });

  it('keeps the document without such entries', () => {
    const styled = doc(includes());
    expect(withCallViews(styled, { 'f/call:includes#0': { x: 1, y: 2 } })).toBe(
      styled
    );
  });

  it('keeps the entries through a re-parse', () => {
    const key = callViewKey('f/call:includes#0');
    expect(isExtraLayoutKey(key)).toBe(true);
    const styled = doc(includes());
    expect(
      reconcileLayout(styled, styled, { [key]: { x: 0, y: 0 } })
    ).toMatchObject({ [key]: { x: 0, y: 0 } });
  });
});
