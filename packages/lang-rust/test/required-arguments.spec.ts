import type { GraphOp } from '@vizscript/core';
import { applyTextEdits } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyRustOp, parseRustDocument } from '../src';

describe('new calls', () => {
  it('get a value for each required argument', () => {
    const text =
      'struct Item;\n\nfn heal(amount: i32, name: &str, item: Item) {}\n\nfn main() {\n    let x = 1;\n}\n';
    const doc = parseRustDocument(text, 'm.rs');
    const set = doc.functions
      .flatMap((f) => f.nodes)
      .find((n) => n.kind === 'setVar');
    const op: GraphOp = {
      type: 'addNode',
      template: { type: 'call', callee: 'heal' },
      after: { node: set?.id ?? '', pin: 'then' },
    };
    const result = applyRustOp(text, op, 'm.rs');
    if (!result.ok) {
      throw new Error(result.error);
    }

    // The type's default where it is a plain value, else the placeholder.
    expect(applyTextEdits(text, result.edits)).toContain(
      '    let x = 1;\n    heal(0, "", todo!());\n'
    );
  });
});
