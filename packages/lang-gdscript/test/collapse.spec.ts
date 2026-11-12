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

function entryOf(source: string): string {
  return (
    parseGDScriptDocument(source, 't.gd')
      .functions.find((f) => f.name === 'jump')
      ?.nodes.find((n) => n.kind === 'entry')?.id ?? ''
  );
}

describe('descriptions', () => {
  it('uses ## doc comments and keeps them when edited', () => {
    const text = 'extends Node\n\n\nfunc jump() -> void:\n\tpass\n';
    const first = applyGDScriptOp(
      text,
      { type: 'setComment', node: entryOf(text), text: 'Jumps.', doc: true },
      't.gd'
    );
    const added = first.ok ? applyTextEdits(text, first.edits) : '';
    expect(added).toBe(
      'extends Node\n\n\n## Jumps.\nfunc jump() -> void:\n\tpass\n'
    );
    const second = applyGDScriptOp(
      added,
      { type: 'setComment', node: entryOf(added), text: 'Jumps high.' },
      't.gd'
    );
    expect(second.ok && applyTextEdits(added, second.edits)).toBe(
      'extends Node\n\n\n## Jumps high.\nfunc jump() -> void:\n\tpass\n'
    );
  });
});
