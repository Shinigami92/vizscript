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

describe('function settings', () => {
  it('makes functions static', () => {
    const text = 'extends Node\n\n\nfunc make() -> void:\n\tpass\n';
    const result = applyGDScriptOp(
      text,
      {
        type: 'setModifier',
        symbol: 'function:make',
        modifier: 'static',
        enabled: true,
      },
      't.gd'
    );
    expect(result.ok && applyTextEdits(text, result.edits)).toBe(
      'extends Node\n\n\nstatic func make() -> void:\n\tpass\n'
    );
  });
});

function set(text: string, setting: string, value: string): string {
  const result = applyGDScriptOp(
    text,
    { type: 'setScriptSetting', setting, value },
    't.gd'
  );
  if (!result.ok) {
    throw new Error(result.error);
  }

  return applyTextEdits(text, result.edits);
}

describe('script settings', () => {
  it('reads @tool, class_name and extends', () => {
    const doc = parseGDScriptDocument(
      '@tool\nclass_name Player\nextends Node2D\n',
      't.gd'
    );
    expect(doc.settings?.map((s) => `${s.id}=${s.value}`)).toEqual([
      'tool=true',
      'class_name=Player',
      'extends=Node2D',
    ]);
  });

  it('writes them in Godot’s order and removes them', () => {
    const text = 'extends Node\n\n\nfunc f() -> void:\n\tpass\n';
    const named = set(text, 'class_name', 'Player');
    expect(named).toBe(
      'class_name Player\nextends Node\n\n\nfunc f() -> void:\n\tpass\n'
    );
    const tool = set(named, 'tool', 'true');
    expect(tool.startsWith('@tool\nclass_name Player\nextends Node\n')).toBe(
      true
    );
    expect(set(tool, 'extends', 'Node2D')).toContain('extends Node2D\n');
    expect(set(tool, 'class_name', '')).toBe(
      '@tool\nextends Node\n\n\nfunc f() -> void:\n\tpass\n'
    );
    expect(() => set(text, 'class_name', 'not valid')).toThrow(
      'is not a valid class name'
    );
  });
});

function setExport(text: string, modifier: string, enabled = true): string {
  const result = applyGDScriptOp(
    text,
    { type: 'setModifier', symbol: 'variable:speed', modifier, enabled },
    't.gd'
  );
  if (!result.ok) {
    throw new Error(result.error);
  }

  return applyTextEdits(text, result.edits);
}

describe('export hints', () => {
  it('adds, changes and removes export annotations', () => {
    const text = 'extends Node\n\nvar speed := 10\n';
    const exported = setExport(text, '@export');
    expect(exported).toBe('extends Node\n\n@export var speed := 10\n');
    const ranged = setExport(exported, '@export_range(0, 20, 2)');
    expect(ranged).toBe(
      'extends Node\n\n@export_range(0, 20, 2) var speed := 10\n'
    );
    expect(setExport(ranged, '@export_range', false)).toBe(text);
  });

  it('leaves the annotation of the variable above alone', () => {
    const text =
      'extends Node\n\n@export_range(0, 10) var size := 1\nvar speed := 10\n';
    expect(setExport(text, '@export')).toBe(
      'extends Node\n\n@export_range(0, 10) var size := 1\n@export var speed := 10\n'
    );
  });

  it('changes an annotation on its own line above', () => {
    const text = 'extends Node\n\n@export\nvar speed := 10\n';
    expect(setExport(text, '@export_range(0, 5)')).toBe(
      'extends Node\n\n@export_range(0, 5)\nvar speed := 10\n'
    );
  });
});

describe('enum members', () => {
  it('lists the members of named enums', () => {
    const doc = parseGDScriptDocument(
      'extends Node\n\nenum State { IDLE, RUN = 2, JUMP } # states\n',
      't.gd'
    );
    expect(doc.symbols?.find((s) => s.kind === 'enum')?.members).toEqual([
      'IDLE',
      'RUN',
      'JUMP',
    ]);
  });
});
