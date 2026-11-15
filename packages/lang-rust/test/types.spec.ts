import { applyTextEdits } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyRustOp } from '../src';

describe('rust types', () => {
  it('replaces the placeholder value when the type changes', () => {
    const text = 'static mut X: i32 = todo!();\n';
    const result = applyRustOp(text, {
      type: 'setSymbolType',
      symbol: 'variable:X',
      typeText: 'f64',
      defaultValue: '0.0',
    });
    if (!result.ok) {
      throw new Error(result.error);
    }

    expect(applyTextEdits(text, result.edits)).toBe(
      'static mut X: f64 = 0.0;\n'
    );
  });
});
