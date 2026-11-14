import { describe, expect, it } from 'vitest';
import {
  candidates,
  declarationSpecifiers,
} from '../src/graph/npm-declarations';

describe('declarationSpecifiers', () => {
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
