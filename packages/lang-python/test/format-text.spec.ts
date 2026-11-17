import { applyTextEdits } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyPythonOp, parsePythonDocument } from '../src';

describe('Format Text', () => {
  it('writes a new format into an f-string', () => {
    const text = 'n = 1\ns = f"Total: {n!r} EUR"\n';
    const node = parsePythonDocument(text, 't.py')
      .functions.flatMap((f) => f.nodes)
      .find((x) => x.kind === 'template');
    const result = applyPythonOp(
      text,
      {
        type: 'setFormat',
        node: node?.id ?? '',
        format: 'Sum: {0!r} and {1}',
      },
      't.py'
    );
    expect(result.ok && applyTextEdits(text, result.edits)).toBe(
      'n = 1\ns = f"Sum: {n!r} and {\'\'}"\n'
    );
  });

  it('has a Format pin (UE) with the text between the quotes', () => {
    const text = 'n = 1\ns = f"Total: {n!r} EUR"\n';
    const node = parsePythonDocument(text, 't.py')
      .functions.flatMap((f) => f.nodes)
      .find((x) => x.kind === 'template');
    const format = node?.pins.find((p) => p.id === 'format');
    expect(format?.literal?.value).toBe('Total: {0!r} EUR');

    const result = applyPythonOp(
      text,
      {
        type: 'setLiteral',
        node: node?.id ?? '',
        pin: 'format',
        value: 'Sum: {0!r}',
      },
      't.py'
    );
    expect(result.ok && applyTextEdits(text, result.edits)).toBe(
      'n = 1\ns = f"Sum: {n!r}"\n'
    );
  });

  it('takes conversions and specs from the format', () => {
    for (const [text, format, expected] of [
      // Shown in the Format, so a typed spec changes it.
      ['s = f"{t:.1f}{u}"\n', '{0:.2f} {1!r}', 's = f"{t:.2f} {u!r}"\n'],
      ['s = f"{t:.1f}"\n', '{0}', 's = f"{t}"\n'],
      // The issue's case: a spec on a slot, new slots get an empty text.
      [
        'r = f"{a}{b}"\n',
        '{0}: {1:.1f}{2}, {3}',
        "r = f\"{a}: {b:.1f}{''}, {''}\"\n",
      ],
      // A new slot in single quotes gets double ones.
      ["s = f'{t}'\n", '{0} {1}', 's = f\'{t} {""}\'\n'],
      // A spec with values of its own isn't shown, and stays.
      ['s = f"{x:{w}}"\n', '[{0}]', 's = f"[{x:{w}}]"\n'],
    ] as const) {
      const node = parsePythonDocument(text, 't.py')
        .functions.flatMap((f) => f.nodes)
        .find((x) => x.kind === 'template');
      const result = applyPythonOp(
        text,
        { type: 'setFormat', node: node?.id ?? '', format },
        't.py'
      );
      expect(result.ok && applyTextEdits(text, result.edits)).toBe(expected);
    }
  });

  it('shows conversions and specs in the Format pin', () => {
    const text = 's = f"{t:.1f} {u!r} {x:{w}} {y = }"\n';
    const node = parsePythonDocument(text, 't.py')
      .functions.flatMap((f) => f.nodes)
      .find((x) => x.kind === 'template');
    expect(node?.pins.find((p) => p.id === 'format')?.literal?.value).toBe(
      '{0:.1f} {1!r} {2} {3 = }'
    );
  });
});
