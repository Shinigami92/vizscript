import { describe, expect, it } from 'vitest';
import type { ModuleReference } from '../src';
import { joinRepoPath, resolveModuleReference } from '../src';

function reference(candidates: string[], anchor?: string): ModuleReference {
  return { range: { start: 0, end: 1 }, specifier: '', candidates, anchor };
}

describe('joinRepoPath', () => {
  it('resolves . and ..', () => {
    expect(joinRepoPath('src', './internal/x.ts')).toBe('src/internal/x.ts');
    expect(joinRepoPath('src/a', '../b/./c.ts')).toBe('src/b/c.ts');
    expect(joinRepoPath('', 'x.ts')).toBe('x.ts');
  });

  it('rejects paths leaving the repository', () => {
    expect(joinRepoPath('src', '../../x.ts')).toBeNull();
    expect(joinRepoPath('', '.')).toBeNull();
  });
});

describe('resolveModuleReference', () => {
  const files = new Set([
    'src/core.ts',
    'src/internal/locale-proxy.ts',
    'src/utils/index.ts',
    'game/project.godot',
    'game/actors/player.gd',
    'tools/x.py',
  ]);
  const exists = (path: string): boolean => files.has(path);

  it('returns the first existing candidate', () => {
    expect(
      resolveModuleReference(
        'src/core.ts',
        reference(['./internal/locale-proxy', './internal/locale-proxy.ts']),
        exists
      )
    ).toBe('src/internal/locale-proxy.ts');
    expect(
      resolveModuleReference(
        'src/core.ts',
        reference(['./utils.ts', './utils/index.ts']),
        exists
      )
    ).toBe('src/utils/index.ts');
  });

  it('returns null for missing files and the file itself', () => {
    expect(
      resolveModuleReference('src/core.ts', reference(['./nope.ts']), exists)
    ).toBeNull();
    expect(
      resolveModuleReference('src/core.ts', reference(['./core.ts']), exists)
    ).toBeNull();
  });

  it('resolves root paths against the anchor directory', () => {
    expect(
      resolveModuleReference(
        'game/actors/enemy.gd',
        reference(['/actors/player.gd'], 'project.godot'),
        exists
      )
    ).toBe('game/actors/player.gd');
    // Without the anchor file, `/` is the repository root.
    expect(
      resolveModuleReference(
        'other/a.py',
        reference(['/tools/x.py'], 'project.godot'),
        exists
      )
    ).toBe('tools/x.py');
  });
});
