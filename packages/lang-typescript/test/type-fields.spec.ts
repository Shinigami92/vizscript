import type { GraphOp } from '@vizscript/core';
import { applyTextEdits } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyTypeScriptOp, parseTypeScript } from '../src';

function apply(text: string, op: GraphOp): string {
  const result = applyTypeScriptOp(text, op, 't.ts');
  if (!result.ok) {
    throw new Error(result.error);
  }

  return applyTextEdits(text, result.edits);
}

const ITEM = 'interface Item {\n  name: string;\n  price: number;\n}\n';

describe('fields of an interface', () => {
  it('are members of the interface', () => {
    const fields = (parseTypeScript(ITEM, 't.ts').symbols ?? []).filter(
      (s) => s.scope === 'Item'
    );
    expect(fields.map((s) => `${s.id} ${s.type?.text}`)).toEqual([
      'variable:Item.name string',
      'variable:Item.price number',
    ]);
  });

  it('are added, also to an empty interface', () => {
    expect(
      apply(ITEM, { type: 'addVariable', scope: 'Item', name: 'quantity' })
    ).toBe(
      'interface Item {\n  name: string;\n  price: number;\n  quantity: string;\n}\n'
    );
    expect(
      apply('interface Item {\n}\n', {
        type: 'addVariable',
        scope: 'Item',
        name: 'name',
      })
    ).toBe('interface Item {\n  name: string;\n}\n');
    expect(
      apply('type Point = { x: number };\n', {
        type: 'addVariable',
        scope: 'Point',
        name: 'y',
      })
    ).toContain('y: string;');
  });

  it('are retyped, renamed, made readonly and removed', () => {
    expect(
      apply(ITEM, {
        type: 'setSymbolType',
        symbol: 'variable:Item.price',
        typeText: 'bigint',
        defaultValue: '0n',
      })
    ).toContain('  price: bigint;\n');
    expect(
      apply(ITEM, {
        type: 'renameSymbol',
        symbol: 'variable:Item.price',
        name: 'cost',
      })
    ).toContain('  cost: number;\n');
    expect(
      apply(ITEM, {
        type: 'setModifier',
        symbol: 'variable:Item.name',
        modifier: 'readonly',
        enabled: true,
      })
    ).toContain('  readonly name: string;\n');
    expect(
      apply(ITEM, { type: 'deleteSymbol', symbol: 'variable:Item.name' })
    ).toBe('interface Item {\n  price: number;\n}\n');
  });
});
