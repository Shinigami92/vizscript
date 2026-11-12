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

const PLAYER = [
  'extends Node2D',
  '',
  'signal hit(amount: int)',
  '',
  'const SPEED := 4.0',
  'var health := 10',
  '',
  '',
  'func _ready() -> void:',
  '\thit.connect(_on_hit)',
  '\tconnect("hit", _on_hit)',
  '',
  '',
  'func _on_hit(amount: int) -> void:',
  '\tvar health := amount',
  '\tself.health -= health',
  '\tprint(SPEED)',
  '',
  '',
  'class Bullet extends Area2D:',
  '\tvar damage := 1',
  '',
  '',
  'var last: Bullet',
  '',
].join('\n');

describe('gdscript symbol ops', () => {
  it('adds functions, variables, signals and locals', () => {
    expect(
      apply(PLAYER, { type: 'addFunction', scope: '', name: 'jump' })
    ).toBe(`${PLAYER}\n\nfunc jump() -> void:\n\tpass\n`);
    expect(
      apply(PLAYER, { type: 'addVariable', scope: '', name: 'lives' })
    ).toContain('var last: Bullet\nvar lives\n');
    expect(apply(PLAYER, { type: 'addSignal', name: 'died' })).toContain(
      'signal hit(amount: int)\nsignal died\n'
    );
    expect(
      apply('extends Node\n\n\nfunc a():\n\tpass\n', {
        type: 'addSignal',
        name: 'died',
      })
    ).toBe('extends Node\n\nsignal died\n\n\nfunc a():\n\tpass\n');
    expect(
      apply(PLAYER, {
        type: 'addVariable',
        scope: '_ready',
        name: 'ok',
        local: true,
      })
    ).toContain('func _ready() -> void:\n\tvar ok = null\n\thit.connect');
  });

  it('renames members but not shadowing locals', () => {
    const renamed = apply(PLAYER, {
      type: 'renameSymbol',
      symbol: 'variable:health',
      name: 'hp',
    });
    expect(renamed).toContain('var hp := 10');
    expect(renamed).toContain('\tvar health := amount\n\tself.hp -= health');
  });

  it('renames signals with their string names, and classes in types', () => {
    const signal = apply(PLAYER, {
      type: 'renameSymbol',
      symbol: 'signal:hit',
      name: 'damaged',
    });
    expect(signal).toContain('signal damaged(amount: int)');
    expect(signal).toContain(
      '\tdamaged.connect(_on_hit)\n\tconnect("damaged", _on_hit)'
    );
    expect(
      apply(PLAYER, {
        type: 'renameSymbol',
        symbol: 'class:Bullet',
        name: 'Shot',
      })
    ).toContain('class Shot extends Area2D:');
    expect(
      apply(PLAYER, {
        type: 'renameSymbol',
        symbol: 'class:Bullet',
        name: 'Shot',
      })
    ).toContain('var last: Shot');
  });

  it('deletes declarations', () => {
    expect(
      apply(PLAYER, { type: 'deleteSymbol', symbol: 'constant:SPEED' })
    ).toContain('signal hit(amount: int)\n\nvar health := 10\n');
  });
});
