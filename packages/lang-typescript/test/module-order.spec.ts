import type { GraphOp } from '@vizscript/core';
import { applyTextEdits } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyTypeScriptOp, parseTypeScript } from '../src';

describe('statements of the module', () => {
  it('go below the classes and const functions they may use', () => {
    const text =
      'const API = 1;\n\nclass Cart {}\n\nconst total = (c: Cart) => 0;\n\nconsole.log(API);\n';
    const set = parseTypeScript(text, 'm.ts')
      .functions.flatMap((f) => f.nodes)
      .find((n) => n.kind === 'setVar' && n.title === 'Set API');
    const op: GraphOp = {
      type: 'addNode',
      template: { type: 'call', callee: 'total' },
      after: { node: set?.id ?? '', pin: 'then' },
    };
    const result = applyTypeScriptOp(text, op, 'm.ts');
    if (!result.ok) {
      throw new Error(result.error);
    }

    expect(applyTextEdits(text, result.edits)).toBe(
      'const API = 1;\n\nclass Cart {}\n\nconst total = (c: Cart) => 0;\n\ntotal();\n\nconsole.log(API);\n'
    );
  });
});
