import type { GraphNode } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { parseRustDocument } from '../src';

/** Title, pin types and output type of each element read. */
function reads(text: string): string[] {
  return parseRustDocument(text, 't.rs')
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
      reads('fn f(items: Vec<String>) {\n    let a = &items[0];\n}\n')
    ).toEqual(['GET(string[], number) -> string']);
  });

  it('keeps a range as a slice of the container', () => {
    expect(
      reads('fn f(items: Vec<String>) {\n    let a = &items[1..3];\n}\n')
    ).toEqual(['[..](string[], number[]) -> string[]']);
  });
});
