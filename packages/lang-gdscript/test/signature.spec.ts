import type { GraphOp } from '@vizscript/core';
import { applyTextEdits } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyGDScriptOp, parseGDScriptDocument } from '../src';

function apply(text: string, op: GraphOp): string {
  const result = applyGDScriptOp(text, op, 'test.gd');
  if (!result.ok) {
    throw new Error(result.error);
  }

  return applyTextEdits(text, result.edits);
}

const TEXT = [
  'func hit(amount: int) -> void:',
  '\tprint(amount)',
  '',
  '',
  'func _ready() -> void:',
  '\thit(3)',
  '\tself.hit(4)',
  '',
].join('\n');

describe('gdscript signatures', () => {
  it('adds, moves and renames inputs with their calls', () => {
    const added = apply(TEXT, {
      type: 'addParameter',
      symbol: 'function:hit',
      name: 'source',
      typeText: 'Node',
      argument: 'null',
    });
    expect(added).toContain('func hit(amount: int, source: Node) -> void:');
    expect(added).toContain('\thit(3, null)\n\tself.hit(4, null)');
    expect(
      apply(TEXT, {
        type: 'renameParameter',
        symbol: 'function:hit',
        index: 0,
        name: 'damage',
      })
    ).toContain('func hit(damage: int) -> void:\n\tprint(damage)');
    expect(
      apply(TEXT, {
        type: 'setReturnType',
        symbol: 'function:hit',
        typeText: 'bool',
      })
    ).toContain('func hit(amount: int) -> bool:');
  });
});

describe('gdscript lone values and signal calls', () => {
  it('adds them after a statement', () => {
    const text = 'signal hit(amount: int)\n\nfunc f() -> void:\n\tprint(1)\n';
    const doc = parseGDScriptDocument(text, 't.gd');
    const print = doc.functions
      .flatMap((fn) => fn.nodes)
      .find((n) => n.title === 'print');
    expect(
      apply(text, {
        type: 'addNode',
        template: { type: 'call', callee: 'hit.emit', args: ['null'] },
        after: { node: print?.id ?? '', pin: 'then' },
      })
    ).toBe(
      'signal hit(amount: int)\n\nfunc f() -> void:\n\tprint(1)\n\thit.emit(null)\n'
    );
  });
});
