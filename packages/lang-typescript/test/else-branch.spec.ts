import type { GraphOp, NodeTemplate } from '@vizscript/core';
import { applyTextEdits } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyTypeScriptOp, parseTypeScript } from '../src';

/** Adds `template` on the False pin of the `index`-th Branch. */
function onFalse(text: string, index: number, template: NodeTemplate): string {
  const doc = parseTypeScript(text, 'm.ts');
  const branch = doc.functions
    .flatMap((f) => f.nodes)
    .filter((n) => n.kind === 'branch')[index];
  const op: GraphOp = {
    type: 'addNode',
    template,
    after: { node: branch?.id ?? '', pin: 'false' },
  };
  const result = applyTypeScriptOp(text, op, 'm.ts');
  if (!result.ok) {
    throw new Error(result.error);
  }

  return applyTextEdits(text, result.edits);
}

const CALL: NodeTemplate = { type: 'call', callee: 'g' };

describe('a node on the False pin of an if without else', () => {
  it('writes an else around it', () => {
    expect(
      onFalse(
        'function f(x: number) {\n  if (x) {\n    console.log(x);\n  }\n}\n',
        0,
        CALL
      )
    ).toBe(
      'function f(x: number) {\n  if (x) {\n    console.log(x);\n  } else {\n    g();\n  }\n}\n'
    );
  });

  it('writes it behind the last branch of a chain', () => {
    const text =
      'function f(x: number) {\n  if (x > 1) {\n    console.log(x);\n  } else if (x < 0) {\n    console.log(0);\n  }\n  return x;\n}\n';
    expect(onFalse(text, 1, CALL)).toContain(
      '  } else if (x < 0) {\n    console.log(0);\n  } else {\n    g();\n  }\n  return x;\n'
    );
    expect(onFalse(text, 1, { type: 'branch' })).toContain(
      '  } else if (x < 0) {\n    console.log(0);\n  } else if (true) {\n  }\n  return x;\n'
    );
    // The first branch's False pin leads into the next one already.
    expect(() => onFalse(text, 0, CALL)).toThrow(
      'Code cannot be inserted after this pin.'
    );
  });
});
