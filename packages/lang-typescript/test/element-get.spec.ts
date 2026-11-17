import type { GraphNode } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { parseTypeScript } from '../src';

/** Title, pin types and output type of each element read. */
function reads(text: string): string[] {
  return parseTypeScript(text, 't.ts')
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
        'function f(items: string[], name: string, data: any) {\n  const a = items[0];\n  const b = name[1];\n  const c = data["k"];\n}\n'
      )
    ).toEqual([
      'GET(string[], number) -> string',
      'GET(string, number) -> string',
      'GET(any, string) -> any',
    ]);
  });

  it('keeps optional reads and properties as they are', () => {
    expect(
      reads('function f(items?: string[]) {\n  const a = items?.[0];\n}\n')
    ).toEqual(['?.[ ](string[], number) -> string']);
  });
});
