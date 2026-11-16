import type { GraphOp, NodeTemplate } from '@vizscript/core';
import { applyTextEdits } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyGDScriptOp, parseGDScriptDocument } from '../src';

/** Adds `template` on the False pin of the `index`-th Branch. */
function onFalse(text: string, index: number, template: NodeTemplate): string {
  const doc = parseGDScriptDocument(text, 'm.gd');
  const branch = doc.functions
    .flatMap((f) => f.nodes)
    .filter((n) => n.kind === 'branch')[index];
  const op: GraphOp = {
    type: 'addNode',
    template,
    after: { node: branch?.id ?? '', pin: 'false' },
  };
  const result = applyGDScriptOp(text, op, 'm.gd');
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
        'extends Node\n\n\nfunc f(x: int) -> void:\n\tif x:\n\t\tprint(x)\n',
        0,
        CALL
      )
    ).toBe(
      'extends Node\n\n\nfunc f(x: int) -> void:\n\tif x:\n\t\tprint(x)\n\telse:\n\t\tg()\n'
    );
  });

  it('writes it behind the last branch of a chain', () => {
    const text =
      'extends Node\n\n\nfunc f(x: int) -> int:\n\tif x > 1:\n\t\tprint(x)\n\telif x < 0:\n\t\tprint(0)\n\treturn x\n';
    expect(onFalse(text, 1, CALL)).toContain(
      '\telif x < 0:\n\t\tprint(0)\n\telse:\n\t\tg()\n\treturn x\n'
    );
    expect(onFalse(text, 1, { type: 'branch' })).toContain(
      '\telif x < 0:\n\t\tprint(0)\n\telif true:\n\t\tpass\n\treturn x\n'
    );
    // The first branch's False pin leads into the next one already.
    expect(() => onFalse(text, 0, CALL)).toThrow(
      'Code cannot be inserted after this pin.'
    );
  });
});
