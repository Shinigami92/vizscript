import type { GraphNode } from '@vizscript/core';
import { compactTitle, isContainerNode, searchNodes } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { parsePythonDocument } from '../src';

/** A container node: its word, exec pins, input and output types. */
function describeNode(node: GraphNode): string {
  const types = (direction: string): string =>
    node.pins
      .filter((p) => p.direction === direction && p.kind === 'data')
      .map((p) => p.type)
      .join(', ');
  const exec = node.pins.some((p) => p.kind === 'exec') ? ' [exec]' : '';
  const out = types('out');
  return `${compactTitle(node)}${exec} (${types('in')})${out ? ` -> ${out}` : ''}`;
}

describe('container operations (UE container nodes)', () => {
  it('draws known operations on typed containers as UE nodes', () => {
    const doc = parsePythonDocument(
      `def f(items: list[str], d: dict[str, int], s: set[str]):
    items.append("x")
    n = len(items)
    has = "a" in d
    v = d.get("a")
    u = s | s
`,
      't.py'
    );
    expect(
      doc.functions
        .flatMap((f) => f.nodes)
        .filter((n) => isContainerNode(n))
        .map(describeNode)
    ).toEqual([
      'ADD [exec] (string[], string)',
      'LENGTH (string[]) -> number',
      'CONTAINS (Map<string, number>, string) -> bool',
      'FIND (Map<string, number>, string) -> number',
      'UNION (Set<string>, Set<string>) -> Set<string>',
    ]);
  });

  it('reads strings, removals by index and appends too', () => {
    const doc = parsePythonDocument(
      'def f(name: str, items: list[str], more: list[str], s: set[str]):\n    n = len(name)\n    last = items.pop(0)\n    items.extend(more)\n    s.update(s)\n',
      't.py'
    );
    expect(
      doc.functions
        .flatMap((f) => f.nodes)
        .filter((n) => isContainerNode(n))
        .map(describeNode)
    ).toEqual([
      'LENGTH (string) -> number',
      'REMOVE INDEX [exec] (string[], number) -> string',
      'APPEND [exec] (string[], string[])',
      'ADD ITEMS [exec] (Set<string>, Set<string>)',
    ]);
  });

  it('finds container nodes by their word', () => {
    const doc = parsePythonDocument(
      'def f(items: list[str]):\n    items.append("x")\n',
      't.py'
    );
    expect(
      searchNodes(doc, 'add').map((m) => `${m.node.title} ${m.text}`)
    ).toEqual(['append ADD']);
  });
});
