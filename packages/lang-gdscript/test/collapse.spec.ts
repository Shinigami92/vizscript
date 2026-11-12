import { applyTextEdits } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyGDScriptOp, parseGDScriptDocument } from '../src';

describe('collapse to function', () => {
  it('turns statements into a function of the script', () => {
    const text = [
      'extends Node',
      '',
      '',
      'func _ready() -> void:',
      '\tvar speed := 10',
      '\tvar doubled := speed * 2',
      '\tprint(doubled)',
      '',
    ].join('\n');
    const doc = parseGDScriptDocument(text, 't.gd');
    const nodes = doc.functions
      .flatMap((f) => f.nodes)
      .filter(
        (n) =>
          n.purity === 'impure' &&
          ['var doubled', 'print'].some((s) =>
            text.slice(n.range.start).startsWith(s)
          )
      )
      .map((n) => n.id);
    const result = applyGDScriptOp(
      text,
      { type: 'collapseToFunction', nodes, name: 'show_double' },
      't.gd'
    );
    expect(result.ok && applyTextEdits(text, result.edits)).toBe(
      [
        'extends Node',
        '',
        '',
        'func _ready() -> void:',
        '\tvar speed := 10',
        '\tshow_double(speed)',
        '',
        '',
        'func show_double(speed):',
        '\tvar doubled := speed * 2',
        '\tprint(doubled)',
        '',
      ].join('\n')
    );
  });
});
