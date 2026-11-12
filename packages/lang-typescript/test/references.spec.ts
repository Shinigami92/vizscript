import { describe, expect, it } from 'vitest';
import { moduleCandidates, typeScriptReferences } from '../src';

/** Module paths only (not the uses of imported names). */
function specifiers(text: string, fileName?: string): string[] {
  return typeScriptReferences(text, fileName)
    .filter((r) => text.slice(r.range.start, r.range.end) === r.specifier)
    .map((r) => r.specifier);
}

function uses(text: string): Array<[string, string, string | undefined]> {
  return typeScriptReferences(text)
    .filter((r) => text.slice(r.range.start, r.range.end) !== r.specifier)
    .map((r) => [
      text.slice(r.range.start, r.range.end),
      r.specifier,
      r.symbol,
    ]);
}

describe('typeScriptReferences', () => {
  it('finds relative module specifiers', () => {
    const text = [
      "import { a } from './a';",
      "import type { B } from '../b.js';",
      "export * from './c';",
      "export { d } from './d';",
      "import 'side-effect';",
      "import x = require('./e');",
      "const f = await import('./f');",
      "const g = require('./g');",
      "type H = import('./h').H;",
      "new Worker(new URL('./worker.ts', import.meta.url));",
      "const notAPath = './i';",
      'export const j = 1;',
    ].join('\n');
    expect(specifiers(text)).toEqual([
      './a',
      '../b.js',
      './c',
      './d',
      './e',
      './f',
      './g',
      './h',
      './worker.ts',
    ]);
  });

  it('works for JavaScript with JSX', () => {
    expect(
      specifiers("import App from './App';\nconst x = <App />;", 'main.jsx')
    ).toEqual(['./App']);
  });
});

describe('uses of imported names', () => {
  it('points at the definition in the imported module', () => {
    const text = [
      "import type { FakerCore } from '../../core';",
      "import { fakeStringHexadecimal as hex } from '../string/hexadecimal';",
      "import * as utils from './utils';",
      "import Default from './default';",
      "import { external } from 'external';",
      'export function sha(core: FakerCore): string {',
      '  const value = { hex: 1, other: hex };',
      '  utils.pad(value.hex);',
      '  external(Default);',
      '  return hex(core);',
      '}',
    ].join('\n');
    expect(uses(text)).toEqual([
      ['FakerCore', '../../core', 'FakerCore'],
      [
        'fakeStringHexadecimal',
        '../string/hexadecimal',
        'fakeStringHexadecimal',
      ],
      ['FakerCore', '../../core', 'FakerCore'],
      ['hex', '../string/hexadecimal', 'fakeStringHexadecimal'],
      ['utils', './utils', undefined],
      ['pad', './utils', 'pad'],
      ['Default', './default', undefined],
      ['hex', '../string/hexadecimal', 'fakeStringHexadecimal'],
    ]);
  });
});

describe('moduleCandidates', () => {
  it('tries extensions and index files', () => {
    const candidates = moduleCandidates('./internal/locale-proxy');
    expect(candidates.slice(0, 2)).toEqual([
      './internal/locale-proxy.ts',
      './internal/locale-proxy.tsx',
    ]);
    expect(candidates).toContain('./internal/locale-proxy/index.ts');
  });

  it('maps .js imports to TypeScript sources', () => {
    expect(moduleCandidates('../b.js').slice(0, 3)).toEqual([
      '../b.js',
      '../b.ts',
      '../b.tsx',
    ]);
  });

  it('treats a trailing slash as a directory', () => {
    expect(moduleCandidates('./utils/')[0]).toBe('./utils/index.ts');
  });
});
