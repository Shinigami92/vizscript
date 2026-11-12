import type { GraphOp } from '@vizscript/core';
import { applyTextEdits } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyGDScriptOp } from '../src';

function apply(text: string, op: GraphOp): string {
  const result = applyGDScriptOp(text, op, 'test.gd');
  if (!result.ok) {
    throw new Error(result.error);
  }

  return applyTextEdits(text, result.edits);
}

describe('gdscript types, values and annotations', () => {
  it('turns := into a declared type', () => {
    expect(
      apply('var speed := 4.0\n', {
        type: 'setSymbolType',
        symbol: 'variable:speed',
        typeText: 'float',
      })
    ).toBe('var speed: float = 4.0\n');
    expect(
      apply('var hp\n', {
        type: 'setSymbolType',
        symbol: 'variable:hp',
        typeText: 'int',
        defaultValue: '0',
      })
    ).toBe('var hp: int = 0\n');
  });

  it('toggles @export, @onready, static and const', () => {
    expect(
      apply('var hp: int = 3\n', {
        type: 'setModifier',
        symbol: 'variable:hp',
        modifier: '@export',
        enabled: true,
      })
    ).toBe('@export var hp: int = 3\n');
    expect(
      apply('@export\nvar hp: int = 3\n', {
        type: 'setModifier',
        symbol: 'variable:hp',
        modifier: '@export',
        enabled: false,
      })
    ).toBe('var hp: int = 3\n');
    expect(
      apply('var hp: int = 3\n', {
        type: 'setModifier',
        symbol: 'variable:hp',
        modifier: 'const',
        enabled: true,
      })
    ).toBe('const hp: int = 3\n');
    expect(
      apply('@onready var hp = 3\n', {
        type: 'setModifier',
        symbol: 'variable:hp',
        modifier: 'static',
        enabled: true,
      })
    ).toBe('@onready static var hp = 3\n');
  });
});
