import type { GraphDocument, GraphEdge, GraphNode, Pin } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { indexDocument, wireType } from '../src/graph/doc-index';

function pin(
  id: string,
  direction: Pin['direction'],
  extra: Partial<Pin>
): Pin {
  return { id, name: id, direction, kind: 'data', type: 'any', ...extra };
}

function node(id: string, p: Pin): GraphNode {
  return { id, kind: 'call', title: id, pins: [p] } as unknown as GraphNode;
}

function docWith(from: Pin, to: Pin): GraphDocument {
  return {
    functions: [
      {
        id: 'f',
        name: 'f',
        nodes: [node('a', from), node('b', to)],
        edges: [],
      },
    ],
  } as unknown as GraphDocument;
}

const edge = (kind: GraphEdge['kind']): GraphEdge => ({
  id: 'e',
  kind,
  from: { node: 'a', pin: 'out' },
  to: { node: 'b', pin: 'in' },
});

/** The name of a wire carrying `type`. */
function typeNameOf(type: string): string | undefined {
  return wireType(
    indexDocument(docWith(pin('out', 'out', { type }), pin('in', 'in', {}))),
    edge('data')
  )?.name;
}

describe('wireType', () => {
  it('names exec wires Exec', () => {
    const index = indexDocument(null);
    expect(wireType(index, edge('exec'))).toEqual({ name: 'Exec' });
  });

  it('names the value type and the exact type', () => {
    const index = indexDocument(
      docWith(
        pin('out', 'out', { type: 'Item[]', typeText: '{ name: string }[]' }),
        pin('in', 'in', {})
      )
    );
    expect(wireType(index, edge('data'))).toEqual({
      name: 'Array of Item',
      detail: '{ name: string }[]',
    });
  });

  it('names maps and sets', () => {
    expect(typeNameOf('Map<string, Item[]>')).toBe(
      'Map of String to Array of Item'
    );
    expect(typeNameOf('Set<number>')).toBe('Set of Number');
    expect(typeNameOf('map')).toBe('Map');
  });

  it("takes the input's type when the output has none", () => {
    const index = indexDocument(
      docWith(
        pin('out', 'out', {}),
        pin('in', 'in', { type: 'number', typeText: 'number' })
      )
    );
    expect(wireType(index, edge('data'))).toEqual({ name: 'Number' });
  });
});
