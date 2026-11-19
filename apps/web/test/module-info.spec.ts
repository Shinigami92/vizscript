import type { ProjectDependency } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { moduleInfo } from '../src/graph/module-info';

function dep(
  name: string,
  more: Partial<ProjectDependency> = {}
): ProjectDependency {
  return {
    name,
    range: '^1.0.0',
    kind: 'runtime',
    manifest: 'package.json',
    ...more,
  };
}

describe('moduleInfo for TypeScript', () => {
  const context = {
    runtime: 'Node.js',
    dependencies: [
      dep('vue', { version: '3.5.45', range: '~3.5.45' }),
      dep('vitest', { kind: 'dev', version: '5.0.5' }),
      dep('pg', { kind: 'peer', range: '>=8' }),
      dep('@app/core', { range: 'workspace:*', local: true }),
    ],
  };
  const info = (module: string): ReturnType<typeof moduleInfo> =>
    moduleInfo(module, 'typescript', context);

  it('shows the locked version, else the range, and the kind', () => {
    expect(info('vue')).toMatchObject({ label: '3.5.45' });
    expect(info('vue')?.badge).toBeUndefined();
    expect(info('vue')?.title).toBe(
      'vue 3.5.45 (~3.5.45): a dependency in package.json'
    );
    expect(info('vitest')).toMatchObject({ label: '5.0.5', badge: 'dev' });
    expect(info('pg')).toMatchObject({ label: '>=8', badge: 'peer' });
    expect(info('@app/core/sub')).toMatchObject({ badge: 'workspace' });
  });

  it('marks Node.js modules as built-in and leaves files alone', () => {
    expect(info('node:fs')?.label).toBe('built-in');
    expect(info('fs/promises')?.label).toBe('built-in');
    expect(info('./util')).toBeUndefined();
  });

  it('warns about a package no manifest lists', () => {
    expect(info('lodash')?.warning).toContain('lodash is not listed');
  });
});

describe('moduleInfo for Python', () => {
  const dependencies = [dep('Pillow', { version: '11.0.0' }), dep('requests')];
  const stdlib = new Set(['os', 'json', '_typeshed']);

  it('knows the standard library and import names of distributions', () => {
    const context = {
      runtime: 'Python 3.12',
      dependencies,
      pythonStdlib: stdlib,
    };
    expect(moduleInfo('os.path', 'python', context)?.label).toBe('built-in');
    expect(moduleInfo('_typeshed', 'python', context)?.label).toBe('built-in');
    expect(moduleInfo('PIL.Image', 'python', context)?.label).toBe('11.0.0');
    expect(moduleInfo('requests', 'python', context)?.label).toBe('^1.0.0');
    expect(moduleInfo('.models', 'python', context)).toBeUndefined();
    expect(moduleInfo('numpy', 'python', context)?.warning).toContain(
      'numpy is not listed'
    );
  });

  it("doesn't warn without the standard library's list", () => {
    const context = { runtime: 'Python', dependencies };
    expect(moduleInfo('numpy', 'python', context)).toBeUndefined();
    expect(moduleInfo('requests', 'python', context)?.label).toBe('^1.0.0');
  });
});

describe('moduleInfo for Rust', () => {
  const context = {
    runtime: "Rust's standard library",
    dependencies: [
      dep('serde_json', { alias: 'json', version: '1.0.128' }),
      dep('regex-syntax', { version: '0.8.5' }),
      dep('cc', { kind: 'build' }),
    ],
  };

  it('knows std, the crate itself, renamed and dashed crates', () => {
    expect(moduleInfo('std::io', 'rust', context)?.label).toBe('built-in');
    expect(moduleInfo('crate::flags', 'rust', context)).toBeUndefined();
    expect(moduleInfo('json::Value', 'rust', context)?.label).toBe('1.0.128');
    expect(moduleInfo('regex_syntax::ast', 'rust', context)?.label).toBe(
      '0.8.5'
    );
    expect(moduleInfo('cc', 'rust', context)?.badge).toBe('build');
    expect(moduleInfo('tokio::sync', 'rust', context)?.warning).toContain(
      'Cargo.toml'
    );
  });
});
