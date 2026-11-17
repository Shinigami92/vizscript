import type { GraphNode, GraphOp } from '@vizscript/core';
import { applyTextEdits } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyGDScriptOp, parseGDScriptDocument } from '../src';

function apply(text: string, op: GraphOp): string {
  const result = applyGDScriptOp(text, op, 't.gd');
  if (!result.ok) {
    throw new Error(result.error);
  }

  return applyTextEdits(text, result.edits);
}

function makeObject(text: string): GraphNode | undefined {
  return parseGDScriptDocument(text, 't.gd')
    .functions.flatMap((f) => f.nodes)
    .find((n) => n.kind === 'makeObject');
}

describe('Make Dictionary (UE Add pin)', () => {
  it('adds an empty entry with the given key', () => {
    for (const [text, expected] of [
      [
        'func f():\n\tvar d = {"a": 1}\n',
        'func f():\n\tvar d = {"a": 1, "b": null}\n',
      ],
      ['func f():\n\tvar d = {}\n', 'func f():\n\tvar d = {"b": null}\n'],
    ] as const) {
      expect(
        apply(text, {
          type: 'addArgument',
          node: makeObject(text)?.id ?? '',
          name: 'b',
        })
      ).toBe(expected);
    }
  });

  it('removes an entry with its comma', () => {
    const text = 'func f():\n\tvar d = {"a": 1, "b": 2}\n';
    expect(
      apply(text, {
        type: 'removeArgument',
        pin: { node: makeObject(text)?.id ?? '', pin: 'p1' },
      })
    ).toBe('func f():\n\tvar d = {"a": 1}\n');
  });

  it('renames a key in both dictionary styles', () => {
    for (const [text, expected] of [
      ['func f():\n\tvar d = {"a": 1}\n', 'func f():\n\tvar d = {"b": 1}\n'],
      ['func f():\n\tvar d = {a = 1}\n', 'func f():\n\tvar d = {b = 1}\n'],
    ] as const) {
      expect(
        apply(text, {
          type: 'renameEntry',
          pin: { node: makeObject(text)?.id ?? '', pin: 'p0' },
          key: 'b',
        })
      ).toBe(expected);
    }
  });
});
