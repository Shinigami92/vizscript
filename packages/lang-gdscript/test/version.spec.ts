import { describe, expect, it } from 'vitest';
import { gdscriptVersion } from '../src';

describe('gdscriptVersion', () => {
  it('reads the feature tag of project.godot', () => {
    const text = [
      'config_version=5',
      '',
      '[application]',
      'config/name="Demo"',
      'config/features=PackedStringArray("4.3", "Forward Plus")',
    ].join('\n');
    expect(gdscriptVersion([{ path: 'game/project.godot', text }])).toEqual({
      text: 'Godot 4.3',
      detail: 'feature 4.3 in config/features',
      path: 'game/project.godot',
    });
  });

  it('falls back to the file format', () => {
    expect(
      gdscriptVersion([
        { path: 'project.godot', text: 'config_version=4\n[application]' },
      ])?.text
    ).toBe('Godot 3');
  });
});
