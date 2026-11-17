import type { GraphNode } from '@vizscript/core';
import { typeWildcardPins } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { parsePythonDocument } from '../src';

/** Title, pin types and output type of each element read. */
function reads(text: string): string[] {
  return parsePythonDocument(text, 't.py')
    .functions.flatMap((f) => f.nodes)
    .filter((n) => n.kind === 'getProperty')
    .map(describeRead);
}

function describeRead(node: GraphNode): string {
  const types = (direction: string): string =>
    node.pins
      .filter((p) => p.direction === direction && p.kind === 'data')
      .map((p) => p.type)
      .join(', ');
  return `${node.title}(${types('in')}) -> ${types('out')}`;
}

describe('element reads (UE GET)', () => {
  it('is a FIND node for a map', () => {
    expect(
      reads('def f(prices: dict[str, float]):\n    a = prices["tea"]\n')
    ).toEqual(['FIND(Map<string, number>, string) -> number']);
  });

  it('is a GET node typed by the container', () => {
    expect(
      reads(
        'def f(items: list[str], name: str, data):\n    a = items[0]\n    b = name[1]\n    c = data["k"]\n'
      )
    ).toEqual([
      'GET(string[], number) -> string',
      'GET(string, number) -> string',
      'GET(any, string) -> any',
    ]);
  });

  it('keeps slices as their own node', () => {
    expect(reads('def f(items: list[str]):\n    a = items[1:3]\n')).toEqual([
      '[1:3](string[]) -> string[]',
    ]);
  });

  it('types an unknown container like its wire (UE wildcard)', () => {
    const fn = parsePythonDocument(
      'def f(data):\n    a = data[0]\n',
      't.py'
    ).functions.find((f) => f.name === 'f');
    if (!fn) {
      throw new Error('no function');
    }

    // The checker found the type of `data`.
    const wire = fn.edges.find((e) => e.to.pin === 'target');
    const typed = typeWildcardPins({
      ...fn,
      nodes: fn.nodes.map((n) => ({
        ...n,
        pins: n.pins.map((p) =>
          n.id === wire?.from.node && p.id === wire.from.pin
            ? { ...p, type: 'string[]' }
            : p
        ),
      })),
    });
    expect(
      typed.nodes.filter((n) => n.kind === 'getProperty').map(describeRead)
    ).toEqual(['GET(string[], number) -> any']);
  });
});
