import { applyTextEdits, diffEdits } from '@vizscript/core';
import { describe, expect, it } from 'vitest';

describe('diffEdits', () => {
  it('turns one text into the other', () => {
    for (const [before, after] of [
      ['a\nb\nc\n', 'a\nc\n'],
      ['x = 1;\n', 'y = 2;\nx = 1;\n'],
      ['total;\nd = total - undefined;\n', 'd = total - total;\n'],
      ['', 'abc'],
      ['abc', ''],
    ] as const) {
      expect(applyTextEdits(before, diffEdits(before, after))).toBe(after);
    }
  });

  it('shows moved code as a removal and an insertion of it', () => {
    const before = '  total;\n  const d = total - undefined;\n';
    const after = '  const d = total - total;\n';
    expect(diffEdits(before, after)).toEqual([
      { start: 2, end: 11, text: '' },
      { start: 29, end: 38, text: 'total' },
    ]);
  });
});
