import type { GraphOp, Pin, TypeSystemInfo } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { elementEntries } from '../src/components/graph-canvas/make-entries';

const TYPES: TypeSystemInfo = {
  primitives: [
    { name: 'char', dataType: 'string', defaultValue: "' '" },
    { name: '&str', dataType: 'string', defaultValue: '""' },
    { name: 'i32', dataType: 'number', defaultValue: '0' },
  ],
  placeholder: 'todo!()',
  keyReference: '&',
  modifiers: {},
};

/** The labels and written expressions offered for an output of `type`. */
function offered(type: string, typeText?: string): string[] {
  const pin: Pin = {
    id: 'out',
    name: '',
    direction: 'out',
    kind: 'data',
    type,
    ...(typeText ? { typeText } : {}),
  };
  const ops: GraphOp[] = [];
  return elementEntries(
    TYPES,
    pin,
    { node: 'n', pin: 'out' },
    { x: 0, y: 0 },
    (op) => ops.push(op)
  ).map((entry) => {
    entry.action('');
    const op = ops.at(-1);
    return `${entry.label} ${op?.type === 'useValue' ? op.expression : ''}`;
  });
}

describe('GET and FIND in the action menu', () => {
  it('reads an element of a typed array', () => {
    expect(offered('string[]')).toEqual(['Get $value[0]']);
    expect(offered('array')).toEqual([]);
  });

  it('finds a key with its empty value, a reference where needed', () => {
    expect(offered('Map<string, number>')).toEqual(['Find $value[""]']);
    expect(offered('Map<number, string>')).toEqual(['Find $value[&0]']);
    expect(offered('Map<Item, string>')).toEqual(['Find $value[&todo!()]']);
  });

  it("leaves out TypeScript's Map, which has no index", () => {
    expect(offered('Map<string, number>', 'Map<string, number>')).toEqual([]);
    expect(offered('Map<string, number>', 'Record<string, number>')).toEqual([
      'Find $value[""]',
    ]);
  });
});
