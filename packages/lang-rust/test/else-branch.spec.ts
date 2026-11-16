import type { GraphOp, NodeTemplate } from '@vizscript/core';
import { applyTextEdits } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyRustOp, parseRustDocument } from '../src';

/** Adds `template` on the False pin of the `index`-th Branch. */
function onFalse(text: string, index: number, template: NodeTemplate): string {
  const doc = parseRustDocument(text, 'm.rs');
  const branch = doc.functions
    .flatMap((f) => f.nodes)
    .filter((n) => n.kind === 'branch')[index];
  const op: GraphOp = {
    type: 'addNode',
    template,
    after: { node: branch?.id ?? '', pin: 'false' },
  };
  const result = applyRustOp(text, op, 'm.rs');
  if (!result.ok) {
    throw new Error(result.error);
  }

  return applyTextEdits(text, result.edits);
}

const CALL: NodeTemplate = { type: 'call', callee: 'g' };

describe('a node on the False pin of an if without else', () => {
  it('writes an else around it', () => {
    expect(
      onFalse('fn f(x: bool) {\n    if x {\n        g();\n    }\n}\n', 0, CALL)
    ).toBe(
      'fn f(x: bool) {\n    if x {\n        g();\n    } else {\n        g();\n    }\n}\n'
    );
  });

  it('writes it behind the last branch of a chain', () => {
    const text =
      'fn f(x: i32) -> i32 {\n    if x > 1 {\n        println!("{}", x);\n    } else if x < 0 {\n        println!("0");\n    }\n    x\n}\n';
    expect(onFalse(text, 1, CALL)).toContain(
      '    } else if x < 0 {\n        println!("0");\n    } else {\n        g();\n    }\n    x\n'
    );
    expect(onFalse(text, 1, { type: 'branch' })).toContain(
      '    } else if x < 0 {\n        println!("0");\n    } else if true {\n    }\n    x\n'
    );
    // The first branch's False pin leads into the next one already.
    expect(() => onFalse(text, 0, CALL)).toThrow(
      'Code cannot be inserted after this pin.'
    );
  });
});
