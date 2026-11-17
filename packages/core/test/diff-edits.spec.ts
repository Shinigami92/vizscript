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

  it('puts inserted and removed statements on whole lines', () => {
    // The shared `    if ` must not make the old `if` look like the new one.
    const before = '    x = 1\n    if a > 25:\n        pass\n';
    const added =
      '    x = 1\n    if True:\n        pass\n    if a > 25:\n        pass\n';
    expect(diffEdits(before, added)).toEqual([
      { start: 10, end: 10, text: '    if True:\n        pass\n' },
    ]);
    expect(diffEdits(added, before)).toEqual([
      { start: 10, end: 36, text: '' },
    ]);
    // Text within a line stays where it is.
    expect(diffEdits('ab\n', 'abb\n')).toEqual([
      { start: 2, end: 2, text: 'b' },
    ]);
  });
});
