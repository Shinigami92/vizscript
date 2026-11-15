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
      { type: 'setFormat', node: node?.id ?? '', format: 'Sum: {0} and {1}' },
      't.py'
    );
    expect(result.ok && applyTextEdits(text, result.edits)).toBe(
      'n = 1\ns = f"Sum: {n!r} and {None}"\n'
    );
  });

  it('has a Format pin (UE) with the text between the quotes', () => {
    const text = 'n = 1\ns = f"Total: {n!r} EUR"\n';
    const node = parsePythonDocument(text, 't.py')
      .functions.flatMap((f) => f.nodes)
      .find((x) => x.kind === 'template');
    const format = node?.pins.find((p) => p.id === 'format');
    expect(format?.literal?.value).toBe('Total: {0} EUR');

    const result = applyPythonOp(
      text,
      {
        type: 'setLiteral',
        node: node?.id ?? '',
        pin: 'format',
        value: 'Sum: {0}',
      },
      't.py'
    );
    expect(result.ok && applyTextEdits(text, result.edits)).toBe(
      'n = 1\ns = f"Sum: {n!r}"\n'
    );
  });
});
