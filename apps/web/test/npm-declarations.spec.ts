import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  candidates,
  declarationSpecifiers,
  npmDeclarations,
} from '../src/graph/npm-declarations';
import { CDN } from '../src/graph/npm-types';

describe('declarationSpecifiers', () => {
  it('ignores imports in comments and text that is no module', () => {
    const text = [
      '/**',
      ' * Creates a router:',
      " * import Home from './pages/Home.vue'",
      " * It's what the user's app imports from 'vue-router'.",
      ' */',
      "// export { x } from './commented-out';",
      "/* import './block' */ import { ref } from 'vue';",
      "declare const sep: '  | ';",
      "export type Opts = { file: string }; // from 'node:fs' or ', * file'",
      "export * from './real';",
    ].join('\n');
    expect(declarationSpecifiers(text).modules).toEqual(['vue', './real']);
  });

  it('finds imports, re-exports and references', () => {
    const text = [
      '/// <reference types="node" />',
      '/// <reference path="./globals.d.ts" />',
      "import { Readable } from 'stream';",
      'import type {',
      '  A,',
      '  B,',
      "} from './types';",
      "export * from './lib/index.js';",
      "export { x } from '@scope/pkg/sub';",
      "type T = import('./dynamic').T;",
      "import './side-effect';",
    ].join('\n');
    expect(declarationSpecifiers(text)).toEqual({
      modules: [
        'stream',
        './types',
        './lib/index.js',
        '@scope/pkg/sub',
        './side-effect',
        './dynamic',
      ],
      types: ['node'],
      paths: ['./globals.d.ts'],
    });
  });
});

describe('candidates', () => {
  it('maps specifiers to declaration files of the package', () => {
    expect(candidates('dist/index.d.ts', './glob.js')).toEqual([
      'dist/glob.d.ts',
    ]);
    expect(candidates('dist/index.d.mts', './esm.mjs')).toEqual([
      'dist/esm.d.mts',
    ]);
    expect(candidates('lib/a/b.d.ts', '../types')).toEqual([
      'lib/types.d.ts',
      'lib/types/index.d.ts',
    ]);
    expect(candidates('lib/x.d.ts', './y.d.ts')).toEqual(['lib/y.d.ts']);
  });

  it('reads a folder through its index', () => {
    expect(candidates('index.d.ts', '.')).toEqual(['index.d.ts']);
    expect(candidates('lib/x.d.ts', '..')).toEqual(['index.d.ts']);
    expect(candidates('lib/x.d.ts', './sub/')).toEqual(['lib/sub/index.d.ts']);
  });
});

function serve(files: Record<string, string>): string[] {
  const requests: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    requests.push(url);
    const body = files[url];
    return {
      ok: body !== undefined,
      status: body === undefined ? 404 : 200,
      text: async () => body,
    };
  });
  return requests;
}

const listing = (key: string, files: string[]): Record<string, string> => ({
  [`https://data.jsdelivr.com/v1/packages/npm/${key}?structure=flat`]:
    JSON.stringify({ files: files.map((f) => ({ name: `/${f}` })) }),
});

describe('npmDeclarations', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('goes to @types without guessing files a listing lacks', async () => {
    const requests = serve({
      [`${CDN}untyped@latest/package.json`]: JSON.stringify({
        version: '2.0.0',
      }),
      ...listing('untyped@2.0.0', ['package.json', 'index.js']),
      [`${CDN}@types/untyped@latest/package.json`]: JSON.stringify({
        version: '2.0.1',
        types: 'index.d.ts',
      }),
      ...listing('@types/untyped@2.0.1', ['package.json', 'index.d.ts']),
      [`${CDN}@types/untyped@2.0.1/index.d.ts`]: 'export declare const u: 1;',
    });
    const files = await npmDeclarations([['untyped', 'latest']]);
    expect(files.map((f) => f.path)).toContain(
      'node_modules/@types/untyped/index.d.ts'
    );
    expect(requests).not.toContain(`${CDN}untyped@2.0.0/index.d.ts`);
  });

  it('reads `/// <reference types>` from @types first', async () => {
    const requests = serve({
      [`${CDN}bundler@latest/package.json`]: JSON.stringify({
        version: '1.0.0',
        types: 'index.d.ts',
      }),
      ...listing('bundler@1.0.0', ['package.json', 'index.d.ts']),
      [`${CDN}bundler@1.0.0/index.d.ts`]:
        '/// <reference types="estreeish" />\n/// <reference types="node" />\nexport {};',
      [`${CDN}@types/estreeish@latest/package.json`]: JSON.stringify({
        version: '1.0.6',
        types: 'index.d.ts',
      }),
      ...listing('@types/estreeish@1.0.6', ['package.json', 'index.d.ts']),
      [`${CDN}@types/estreeish@1.0.6/index.d.ts`]: 'export type Node = {};',
    });
    const files = await npmDeclarations([['bundler', 'latest']]);
    expect(files.map((f) => f.path)).toContain(
      'node_modules/@types/estreeish/index.d.ts'
    );
    // Neither the bare name nor Node.js's types are asked for.
    expect(requests).not.toContain(`${CDN}estreeish@latest/package.json`);
    expect(requests.some((url) => url.includes('/node@'))).toBe(false);
  });

  it('reads what the package depends on, bare name or @types', async () => {
    const requests = serve({
      [`${CDN}rollupish@latest/package.json`]: JSON.stringify({
        version: '1.0.0',
        types: 'index.d.ts',
        dependencies: { '@types/treeish': '1.0.8', 'bunish-types': '1.4.4' },
      }),
      ...listing('rollupish@1.0.0', ['package.json', 'index.d.ts']),
      [`${CDN}rollupish@1.0.0/index.d.ts`]:
        '/// <reference types="bunish-types" />\nimport type * as t from "treeish";',
      [`${CDN}@types/treeish@1.0.8/package.json`]: JSON.stringify({
        version: '1.0.8',
        types: 'index.d.ts',
      }),
      ...listing('@types/treeish@1.0.8', ['package.json', 'index.d.ts']),
      [`${CDN}@types/treeish@1.0.8/index.d.ts`]: 'export type T = 1;',
      [`${CDN}bunish-types@1.4.4/package.json`]: JSON.stringify({
        version: '1.4.4',
        types: 'index.d.ts',
      }),
      ...listing('bunish-types@1.4.4', ['package.json', 'index.d.ts']),
      [`${CDN}bunish-types@1.4.4/index.d.ts`]: 'export type B = 1;',
    });
    const files = await npmDeclarations([['rollupish', 'latest']]);
    expect(files.map((f) => f.path)).toEqual(
      expect.arrayContaining([
        'node_modules/@types/treeish/index.d.ts',
        'node_modules/bunish-types/index.d.ts',
      ])
    );
    expect(requests).not.toContain(`${CDN}treeish@latest/package.json`);
    expect(requests).not.toContain(
      `${CDN}@types/bunish-types@1.4.4/package.json`
    );
  });
});
