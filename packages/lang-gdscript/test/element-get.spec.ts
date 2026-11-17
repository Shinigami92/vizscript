import type { GraphNode } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { parseGDScriptDocument } from '../src';

/** Title, pin types and output type of each element read. */
function reads(text: string): string[] {
  return parseGDScriptDocument(text, 't.gd')
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
  it('is a GET node typed by the container', () => {
    expect(
      reads(
        'func f(items: Array[String], name: String, data):\n\tvar a = items[0]\n\tvar b = name[1]\n\tvar c = data["k"]\n'
      )
    ).toEqual([
      'GET(string[], number) -> string',
      'GET(string, number) -> string',
      'GET(any, string) -> any',
    ]);
  });
});
