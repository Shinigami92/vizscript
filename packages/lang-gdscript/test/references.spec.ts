import { describe, expect, it } from 'vitest';
import { gdscriptReferences } from '../src';

describe('gdscriptReferences', () => {
  it('finds res:// paths and relative loads', () => {
    const text = [
      'extends "res://actors/base.gd"',
      'const Bullet = preload("res://actors/bullet.tscn")',
      'const Helper = preload("helper.gd")',
      "var icon = load('./icon.png')",
      'var name := "not a path"',
      'var tag := &"res://string_name"',
      'func _ready() -> void:',
      '\tget_tree().change_scene_to_file("res://ui/menu.tscn")',
    ].join('\n');
    const references = gdscriptReferences(text).filter((r) =>
      r.specifier.includes('.')
    );
    for (const r of references) {
      expect(text.slice(r.range.start, r.range.end)).toBe(r.specifier);
    }

    expect(
      references.map((r) => [r.specifier, r.candidates, r.anchor])
    ).toEqual([
      ['res://actors/base.gd', ['/actors/base.gd'], 'project.godot'],
      ['res://actors/bullet.tscn', ['/actors/bullet.tscn'], 'project.godot'],
      ['helper.gd', ['./helper.gd'], undefined],
      ['./icon.png', ['./icon.png'], undefined],
      ['res://ui/menu.tscn', ['/ui/menu.tscn'], 'project.godot'],
    ]);
  });

  it('points uses of preloaded scripts at them', () => {
    const text = [
      'const Bullet = preload("res://actors/bullet.gd")',
      'func fire() -> void:',
      '\tvar b := Bullet.new()',
      '\tBullet.spawn(b)',
    ].join('\n');
    const uses = gdscriptReferences(text)
      .filter((r) => !r.specifier.includes('/'))
      .map((r) => [r.specifier, r.symbol, r.candidates[0]]);
    expect(uses).toEqual([
      ['Bullet', undefined, '/actors/bullet.gd'],
      ['new', '_init', '/actors/bullet.gd'],
      ['Bullet', undefined, '/actors/bullet.gd'],
      ['spawn', 'spawn', '/actors/bullet.gd'],
    ]);
  });
});
