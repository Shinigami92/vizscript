import { describe, expect, it } from 'vitest';
import {
  defaultKind,
  ecosystemOf,
  installCommand,
  libraryImport,
  manifestEdit,
  manifestFor,
} from '../src/graph/add-package';

describe('adding a library', () => {
  const files = new Set([
    'package.json',
    'pnpm-lock.yaml',
    'apps/web/package.json',
    'tools/pyproject.toml',
    'tools/uv.lock',
    'crates/app/Cargo.toml',
  ]);

  it('finds the ecosystem and the nearest manifest', () => {
    expect(ecosystemOf('apps/web/src/a.ts')).toBe('npm');
    expect(ecosystemOf('tools/x.py')).toBe('pypi');
    expect(ecosystemOf('crates/app/src/main.rs')).toBe('crates');
    expect(ecosystemOf('player.gd')).toBeUndefined();
    expect(manifestFor(files, 'apps/web/src/a.ts')).toBe(
      'apps/web/package.json'
    );
    expect(manifestFor(files, 'tools/x.py')).toBe('tools/pyproject.toml');
    expect(manifestFor(files, 'crates/app/src/main.rs')).toBe(
      'crates/app/Cargo.toml'
    );
  });

  it('lists tests, configs and type packages as dev dependencies', () => {
    expect(defaultKind('src/a.ts', 'vue')).toBe('runtime');
    expect(defaultKind('test/a.spec.ts', 'vitest')).toBe('dev');
    expect(defaultKind('vite.config.ts', 'vite')).toBe('dev');
    expect(defaultKind('src/a.ts', '@types/node')).toBe('dev');
    expect(defaultKind('tests/test_api.py', 'pytest')).toBe('dev');
    expect(defaultKind('build.rs', 'cc')).toBe('build');
  });

  it('writes the version in the manifest’s style', () => {
    const edit = manifestEdit('package.json', 'zod', '4.0.0', 'runtime');
    expect(
      edit('{\n  "dependencies": {\n    "vue": "~3.5.45"\n  }\n}\n')
    ).toContain('"zod": "~4.0.0"');
  });

  it('imports a name, or the whole module', () => {
    expect(libraryImport('a.ts', 'vue', 'computed')).toEqual({
      path: '',
      from: 'a.ts',
      name: 'computed',
      imported: 'computed',
      module: 'vue',
    });
    expect(libraryImport('a.ts', '@vue/runtime-dom', undefined)).toMatchObject({
      name: 'runtime_dom',
      imported: '*',
    });
    expect(libraryImport('main.rs', 'serde_json', undefined)).toMatchObject({
      name: 'serde_json',
      imported: '*',
      module: 'serde_json',
    });
  });

  it('names the command that updates the lockfile', () => {
    expect(installCommand(files, 'apps/web/package.json')).toBe('pnpm install');
    expect(installCommand(files, 'tools/pyproject.toml')).toBe('uv sync');
    expect(installCommand(files, 'crates/app/Cargo.toml')).toBe('cargo build');
    expect(installCommand(new Set(), 'package.json')).toBe('npm install');
  });
});
