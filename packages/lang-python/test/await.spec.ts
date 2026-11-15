import type { GraphDocument, GraphOp, OpResult } from '@vizscript/core';
import { applyTextEdits } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyPythonOp, parsePythonDocument } from '../src';

/** Awaits the result of the call `title` like the action menu's Await. */
function awaitCall(text: string, title: string, expression: string): string {
  const doc: GraphDocument = parsePythonDocument(text, 't.py');
  const call = doc.functions
    .flatMap((f) => f.nodes)
    .find((n) => n.kind === 'call' && n.title === title);
  const out = call?.pins.find(
    (p) => p.direction === 'out' && p.kind === 'data'
  );
  const op: GraphOp = {
    type: 'useValue',
    pin: { node: call?.id ?? '', pin: out?.id ?? '' },
    expression,
    awaits: true,
  };
  const result: OpResult = applyPythonOp(text, op, 't.py');
  expect(result.ok).toBe(true);
  return result.ok ? applyTextEdits(text, result.edits) : text;
}

describe('Await', () => {
  it('awaits a call in place and makes its function async', () => {
    expect(awaitCall('def f():\n    load()\n', 'load', 'await $value')).toBe(
      'async def f():\n    await load()\n'
    );
  });
});
