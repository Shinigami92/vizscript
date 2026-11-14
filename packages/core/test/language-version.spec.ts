import { describe, expect, it } from 'vitest';
import { configValue, projectFilesAbove, shortVersion } from '../src';

describe('projectFilesAbove', () => {
  it('lists existing files nearest first', () => {
    const files = new Set([
      'package.json',
      'apps/web/package.json',
      'pnpm-workspace.yaml',
    ]);
    expect(
      projectFilesAbove(
        'apps/web/src/main.ts',
        ['package.json', 'pnpm-workspace.yaml'],
        (p) => files.has(p)
      )
    ).toEqual(['apps/web/package.json', 'package.json', 'pnpm-workspace.yaml']);
  });
});

describe('configValue', () => {
  const toml = [
    'name = "top"',
    '[project]',
    'name = "demo"  # the name',
    "requires-python = '>=3.11'",
    '[tool.mypy]',
    'python_version = 3.12 # bare',
  ].join('\n');

  it('reads keys of a section', () => {
    expect(configValue(toml, 'project', 'requires-python')).toBe('>=3.11');
    expect(configValue(toml, 'project', 'name')).toBe('demo');
    expect(configValue(toml, '', 'name')).toBe('top');
    expect(configValue(toml, 'tool.mypy', 'python_version')).toBe('3.12');
    expect(configValue(toml, 'tool.pyright', 'pythonVersion')).toBeUndefined();
  });
});

describe('shortVersion', () => {
  it('keeps the lower bound', () => {
    expect(shortVersion('^5.9.2')).toBe('5.9.2');
    expect(shortVersion('~5.9.0')).toBe('5.9.0');
    expect(shortVersion('>=3.9, <4')).toBe('≥3.9');
    expect(shortVersion('==3.11.*')).toBe('3.11.*');
    expect(shortVersion('~=3.10')).toBe('~=3.10');
    expect(shortVersion('6.0.3')).toBe('6.0.3');
  });
});
