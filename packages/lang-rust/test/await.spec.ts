import type { GraphDocument, GraphOp, OpResult } from '@vizscript/core';
import { applyTextEdits } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyRustOp, parseRustDocument } from '../src';

/** Awaits the result of the call `title` like the action menu's Await. */
function awaitCall(text: string, title: string, expression: string): string {
  const doc: GraphDocument = parseRustDocument(text, 't.rs');
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
  const result: OpResult = applyRustOp(text, op, 't.rs');
  expect(result.ok).toBe(true);
  return result.ok ? applyTextEdits(text, result.edits) : text;
}

describe('Await', () => {
  it('awaits a call in place and makes its function async', () => {
    expect(
      awaitCall('fn f() {\n    load();\n}\n', 'load', '$value.await')
    ).toBe('async fn f() {\n    load().await;\n}\n');
  });
});
