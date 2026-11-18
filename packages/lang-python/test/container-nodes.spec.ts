import type { GraphNode, GraphOp } from '@vizscript/core';
import {
  applyTextEdits,
  compactTitle,
  containerPinOf,
  isContainerNode,
  searchNodes,
} from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyPythonOp, parsePythonDocument } from '../src';

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

  it('draws `len(items) - 1` as LAST INDEX, other subtractions not', () => {
    const doc = parsePythonDocument(
      'def f(items: list[str], name: str):\n    a = len(items) - 1\n    b = len(items) - 2\n    c = len(name) - 1\n',
      't.py'
    );
    const nodes = doc.functions.flatMap((f) => f.nodes);
    expect(nodes.filter((n) => isContainerNode(n)).map(describeNode)).toEqual([
      'LAST INDEX (string[]) -> number',
      'LENGTH (string[]) -> number',
      'LENGTH (string) -> number',
    ]);
    expect(nodes.filter((n) => n.title === '-')).toHaveLength(2);
  });

  it('edits LAST INDEX as the whole `len(items) - 1`', () => {
    const text =
      'def f(items: list[str], more: list[str]):\n    last = len(items) - 1\n    print(more)\n';
    const nodes = parsePythonDocument(text, 't.py').functions.flatMap(
      (f) => f.nodes
    );
    const last = nodes.find((n) => compactTitle(n) === 'LAST INDEX');
    const entry = nodes.find((n) => n.kind === 'entry' && n.title === 'f');
    const print = nodes.find((n) => n.title === 'print');
    const apply = (op: GraphOp): string => {
      const result = applyPythonOp(text, op, 't.py');
      return result.ok ? applyTextEdits(text, result.edits) : result.error;
    };

    expect(last?.range).toEqual({
      start: text.indexOf('len('),
      end: text.indexOf(' - 1') + 4,
    });
    // Another list into its container pin.
    expect(
      apply({
        type: 'connect',
        from: {
          node: entry?.id ?? '',
          pin: entry?.pins.find((p) => p.name === 'more')?.id ?? '',
        },
        to: {
          node: last?.id ?? '',
          pin: containerPinOf(last as GraphNode)?.id ?? '',
        },
      })
    ).toContain('last = len(more) - 1\n');
    // Its value wired elsewhere is the whole expression.
    expect(
      apply({
        type: 'connect',
        from: {
          node: last?.id ?? '',
          pin: last?.pins.find((p) => p.direction === 'out')?.id ?? '',
        },
        to: { node: print?.id ?? '', pin: 'arg0' },
      })
    ).toContain('print(len(items) - 1)');
  });
});
