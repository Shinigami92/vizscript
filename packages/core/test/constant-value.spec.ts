import { describe, expect, it } from 'vitest';
import { isConstantValue } from '../src';

describe('isConstantValue', () => {
  it('accepts literals and collections of them', () => {
    for (const code of [
      '',
      '0.19',
      '-1',
      '60 * 60',
      '"Jane User"',
      "'a'",
      '`plain`',
      'true',
      'None',
      'undefined',
      '1_000u32',
      '[1, 2, 3]',
      "[{ name: 'Keyboard', price: 89.9, quantity: 1 }]",
      '{"metric": "°C", "imperial": "°F"}',
      '(1, "a")',
      'vec![1.5, 2.0]',
      '&"move_left"',
      'r"raw"',
    ]) {
      expect([code, isConstantValue(code)]).toEqual([code, true]);
    }
  });

  it('rejects calls, names and interpolation', () => {
    for (const code of [
      'greeter(user)',
      'TAX_RATE * 2',
      'user',
      '`Hello ${name}`',
      'f"{city}"',
      'new Map()',
      '() => 1',
      'items.length',
      'Item::new("a")',
      '$Sprite2D',
      'set()',
    ]) {
      expect([code, isConstantValue(code)]).toEqual([code, false]);
    }
  });
});
