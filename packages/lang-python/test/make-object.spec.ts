import type { GraphNode, GraphOp } from '@vizscript/core';
import { applyTextEdits } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyPythonOp, parsePythonDocument } from '../src';

function apply(text: string, op: GraphOp): string {
  const result = applyPythonOp(text, op, 't.py');
  if (!result.ok) {
    throw new Error(result.error);
  }

  return applyTextEdits(text, result.edits);
}

function makeObject(text: string): GraphNode | undefined {
  return parsePythonDocument(text, 't.py')
    .functions.flatMap((f) => f.nodes)
    .find((n) => n.kind === 'makeObject');
}

describe('Make Dictionary (UE Add pin)', () => {
  it('adds an empty entry with the given key', () => {
    for (const [text, expected] of [
      ['d = {"a": 1}\n', 'd = {"a": 1, "b": None}\n'],
      ['d = {}\n', 'd = {"b": None}\n'],
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
    const text = 'd = {"a": 1, "b": 2}\n';
    expect(
      apply(text, {
        type: 'removeArgument',
        pin: { node: makeObject(text)?.id ?? '', pin: 'p1' },
      })
    ).toBe('d = {"a": 1}\n');
  });

  it('renames a key and keeps its quotes', () => {
    for (const [text, pin, key, expected] of [
      ['d = {"a": 1, "b": 2}\n', 'p1', 'c', 'd = {"a": 1, "c": 2}\n'],
      ["d = {'a': 1}\n", 'p0', "it's", "d = {'it\\'s': 1}\n"],
    ] as const) {
      expect(
        apply(text, {
          type: 'renameEntry',
          pin: { node: makeObject(text)?.id ?? '', pin },
          key,
        })
      ).toBe(expected);
    }
  });

  it('refuses a key that is taken or not text', () => {
    for (const [text, pin, key] of [
      ['d = {"a": 1, "b": 2}\n', 'p1', 'a'],
      ['d = {1: 1, "b": 2}\n', 'p0', 'c'],
    ] as const) {
      const op: GraphOp = {
        type: 'renameEntry',
        pin: { node: makeObject(text)?.id ?? '', pin },
        key,
      };
      expect(applyPythonOp(text, op, 't.py').ok).toBe(false);
    }
  });
});
