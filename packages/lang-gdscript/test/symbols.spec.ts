import { summarizeSymbols } from '@vizscript/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseGDScriptDocument } from '../src';

describe('gdscriptSymbols', () => {
  it('lists the declarations of the fixture', () => {
    const turret = readFileSync(
      join(import.meta.dirname, 'fixtures', 'turret.gd'),
      'utf8'
    );
    expect(
      summarizeSymbols(parseGDScriptDocument(turret, 'turret.gd'))
    ).toMatchSnapshot();
  });

  it('covers signals, enums, inner classes and locals', () => {
    const text = [
      'extends Node',
      'signal health_changed(value: int, source)',
      'enum State { IDLE, RUNNING }',
      'const SPEED := 4.5',
      'static var instances := 0',
      '@onready var timer: Timer = $Timer',
      'var velocity = Vector2(0, 0)',
      'func move(delta: float, scale := 1.0) -> void:',
      '\tvar step := delta * SPEED',
      '\tfor i: int in range(3):',
      '\t\tvar seen = true',
      'class Bullet extends Area2D:',
      '\tvar damage: int = 3',
      '\tfunc hit() -> bool:',
      '\t\treturn true',
    ].join('\n');
    expect(summarizeSymbols(parseGDScriptDocument(text, 'player.gd')))
      .toMatchInlineSnapshot(`
        "signal health_changed(value: int, source)
        enum State ~State
        constant SPEED ~number = … [const]
        variable instances ~number = … [static var]
        variable timer: Timer = … [@onready var]
        variable velocity ~Vector2 = … [var]
        function move(delta: float, scale = …): void → move
        local move::step ~number = … [var]
        local move::i: int
        local move::seen ~bool = … [var]
        class Bullet ~Bullet → Bullet
        variable Bullet::damage: int = … [var]
        function Bullet::hit(): bool → Bullet.hit"
      `);
  });
});
