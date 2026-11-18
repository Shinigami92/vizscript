import type { GraphNode, GraphOp } from '@vizscript/core';
import { applyTextEdits, compactTitle, isContainerNode } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyGDScriptOp, parseGDScriptDocument } from '../src';

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
    const doc = parseGDScriptDocument(
      `func f(items: Array[String], d: Dictionary[String, int]):
\titems.append("x")
\tvar n = items.size()
\tvar has = "a" in d
`,
      't.gd'
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
    ]);
  });

  it('draws `items.size() - 1` as LAST INDEX', () => {
    const doc = parseGDScriptDocument(
      'func f(items: Array[String]):\n\treturn items.size() - 1\n',
      't.gd'
    );
    expect(
      doc.functions
        .flatMap((f) => f.nodes)
        .filter((n) => isContainerNode(n))
        .map(describeNode)
    ).toEqual(['LAST INDEX (string[]) -> number']);
  });

  it('draws `x not in items` as CONTAINS wired into NOT', () => {
    const text =
      'func f(x: String, items: Array[String], flag: bool):\n\tvar ok = x not in items\n';
    const nodes = parseGDScriptDocument(text, 't.gd').functions.flatMap(
      (f) => f.nodes
    );
    const contains = nodes.find((n) => compactTitle(n) === 'CONTAINS');
    const not = nodes.find((n) => n.title === 'not');
    const entry = nodes.find((n) => n.kind === 'entry' && n.title === 'f');
    expect(contains && describeNode(contains)).toBe(
      'CONTAINS (string[], string) -> bool'
    );
    const apply = (op: GraphOp): string => {
      const result = applyGDScriptOp(text, op, 't.gd');
      return result.ok ? applyTextEdits(text, result.edits) : result.error;
    };
    expect(
      apply({ type: 'deleteNodes', nodeIds: [contains?.id ?? ''] })
    ).toContain('\tvar ok = not null\n');
    expect(
      apply({
        type: 'connect',
        from: {
          node: entry?.id ?? '',
          pin: entry?.pins.find((p) => p.name === 'flag')?.id ?? '',
        },
        to: { node: not?.id ?? '', pin: 'a' },
      })
    ).toContain('\tvar ok = not flag\n');
  });

  it('draws an element write as Set Array Elem, a dictionary’s as ADD', () => {
    const doc = parseGDScriptDocument(
      'func f(items: Array[String], stock: Dictionary[String, int]):\n\titems[3] = "date"\n\tstock["apple"] = 2\n',
      't.gd'
    );
    expect(
      doc.functions
        .flatMap((fn) => fn.nodes)
        .filter((n) => n.kind === 'setElement')
        .map(describeNode)
    ).toEqual([
      'Set Array Elem [exec] (string[], number, string)',
      'ADD [exec] (Map<string, number>, string, number)',
    ]);
  });
});
