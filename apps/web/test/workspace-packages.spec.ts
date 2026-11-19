import { describe, expect, it } from 'vitest';
import {
  resolveWorkspaceImport,
  splitSpecifier,
  workspacePackages,
} from '../src/graph/workspace-packages';

const FILES: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'root', private: true }),
  'packages/api/package.json': JSON.stringify({
    name: '@acme/api',
    exports: { '.': './src/index.ts', './util/*': './src/util/*.ts' },
  }),
  'packages/api/src/index.ts': '',
  'packages/api/src/util/dates.ts': '',
  'packages/legacy/package.json': JSON.stringify({
    name: 'legacy',
    main: './dist/index.js',
  }),
  'packages/legacy/src/index.ts': '',
  'packages/plain/package.json': JSON.stringify({ name: 'plain' }),
  'packages/plain/index.js': '',
  'packages/conditions/package.json': JSON.stringify({
    name: 'conditions',
    exports: { types: './types/main.d.ts', default: './main.js' },
  }),
  'packages/conditions/types/main.d.ts': '',
  'node_modules/vue/package.json': JSON.stringify({ name: 'vue' }),
  'packages/broken/package.json': '{ not json',
};

function read(path: string): Promise<string> {
  const text = FILES[path];
  return text === undefined
    ? Promise.reject(new Error(`no ${path}`))
    : Promise.resolve(text);
}

const files = new Set(Object.keys(FILES));
const exists = (path: string): boolean => files.has(path);

describe('packages of the repository', () => {
  it('reads their names, not installed packages or broken manifests', async () => {
    const packages = await workspacePackages(files, read);
    expect([...packages.keys()].toSorted()).toEqual([
      '@acme/api',
      'conditions',
      'legacy',
      'plain',
      'root',
    ]);
    expect(packages.get('@acme/api')?.dir).toBe('packages/api');
  });

  it('finds the file an import of one means', async () => {
    const packages = await workspacePackages(files, read);
    const resolve = (specifier: string): string | undefined =>
      resolveWorkspaceImport(specifier, packages, exists);
    expect(resolve('@acme/api')).toBe('packages/api/src/index.ts');
    expect(resolve('@acme/api/util/dates')).toBe(
      'packages/api/src/util/dates.ts'
    );
    // `main` of a build: its source.
    expect(resolve('legacy')).toBe('packages/legacy/src/index.ts');
    expect(resolve('plain')).toBe('packages/plain/index.js');
    expect(resolve('conditions')).toBe('packages/conditions/types/main.d.ts');
    expect(resolve('vue')).toBeUndefined();
    expect(resolve('@acme/api/missing')).toBeUndefined();
  });

  it('splits a specifier into the package and its subpath', () => {
    expect(splitSpecifier('@acme/api')).toEqual({
      name: '@acme/api',
      subpath: '.',
    });
    expect(splitSpecifier('lodash/fp/map')).toEqual({
      name: 'lodash',
      subpath: './fp/map',
    });
  });
});
