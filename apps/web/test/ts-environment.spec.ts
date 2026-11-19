import { describe, expect, it } from 'vitest';
import { NODE_BUILTINS } from '../src/graph/npm-declarations';
import {
  importsNodeModules,
  matchesPattern,
  parseJsonc,
  tsEnvironment,
} from '../src/graph/ts-environment';

const BASE = `{
  // shared options
  "compilerOptions": { "lib": ["ES2023"], "types": [], },
}`;

function environment(
  files: Record<string, string>,
  path: string,
  options: { text?: string; hasNodeTypes?: boolean } = {}
): ReturnType<typeof tsEnvironment> {
  const map = new Map(Object.entries(files));
  return tsEnvironment(
    new Set(map.keys()),
    async (p) => map.get(p) ?? '',
    path,
    {
      text: options.text ?? '',
      hasNodeTypes: options.hasNodeTypes ?? false,
      builtins: NODE_BUILTINS,
    }
  );
}

describe('tsconfig helpers', () => {
  it('reads JSON with comments and trailing commas', () => {
    expect(parseJsonc(BASE)).toEqual({
      compilerOptions: { lib: ['ES2023'], types: [] },
    });
    expect(parseJsonc('{ "url": "https://example.test/x" }')).toEqual({
      url: 'https://example.test/x',
    });
  });

  it('matches include patterns like TypeScript', () => {
    expect(matchesPattern('src/a/b.ts', 'src/**/*.ts')).toBe(true);
    expect(matchesPattern('src/b.ts', 'src/**/*.ts')).toBe(true);
    expect(matchesPattern('test/b.ts', 'src/**/*.ts')).toBe(false);
    expect(matchesPattern('src/deep/x.vue', 'src')).toBe(true);
    expect(matchesPattern('vite.config.ts', '*.config.ts')).toBe(true);
    expect(matchesPattern('src/vite.config.ts', '*.config.ts')).toBe(false);
  });

  it('finds Node.js modules among the imports', () => {
    expect(importsNodeModules("import fs from 'node:fs';", NODE_BUILTINS)).toBe(
      true
    );
    expect(
      importsNodeModules(
        "import { readFile } from 'fs/promises';",
        NODE_BUILTINS
      )
    ).toBe(true);
    expect(importsNodeModules("import vue from 'vue';", NODE_BUILTINS)).toBe(
      false
    );
  });
});

describe('tsEnvironment', () => {
  it('reads lib and types through extends (this repository)', async () => {
    const files = {
      'tsconfig.base.json': BASE,
      'apps/web/tsconfig.json': `{
        "extends": "../../tsconfig.base.json",
        "compilerOptions": { "lib": ["ES2023", "DOM", "DOM.Iterable"], "types": ["vite/client"] }
      }`,
      'apps/api/tsconfig.json': `{
        "extends": "../../tsconfig.base.json",
        "compilerOptions": { "types": ["node"] }
      }`,
    };
    expect(await environment(files, 'apps/web/src/main.ts')).toEqual({
      dom: true,
      node: false,
      config: 'apps/web/tsconfig.json',
    });
    expect(await environment(files, 'apps/api/src/main.ts')).toEqual({
      dom: false,
      node: true,
      config: 'apps/api/tsconfig.json',
    });
  });

  it('picks the referenced config whose include takes the file', async () => {
    // Vite's template: a solution config with app and node parts.
    const files = {
      'tsconfig.json': `{ "files": [], "references": [
        { "path": "./tsconfig.app.json" }, { "path": "./tsconfig.node.json" } ] }`,
      'tsconfig.app.json': `{ "compilerOptions": { "lib": ["ES2020", "DOM"] }, "include": ["src"] }`,
      'tsconfig.node.json': `{ "compilerOptions": { "lib": ["ES2023"], "types": ["node"] }, "include": ["vite.config.ts"] }`,
    };
    expect(await environment(files, 'src/App.ts')).toMatchObject({
      dom: true,
      node: false,
      config: 'tsconfig.app.json',
    });
    expect(await environment(files, 'vite.config.ts')).toMatchObject({
      dom: false,
      node: true,
      config: 'tsconfig.node.json',
    });
  });

  it('uses TypeScript defaults: DOM, and @types/node when installed', async () => {
    const files = { 'tsconfig.json': '{ "compilerOptions": {} }' };
    expect(
      await environment(files, 'src/a.ts', { hasNodeTypes: true })
    ).toMatchObject({ dom: true, node: true });
    expect(await environment(files, 'src/a.ts')).toMatchObject({
      dom: true,
      node: false,
    });
  });

  it('guesses from the imports without a config', async () => {
    expect(
      await environment({}, 'script.ts', { text: "import os from 'node:os';" })
    ).toEqual({ dom: true, node: true });
    expect(
      await environment({}, 'script.ts', { text: 'document.title = "x";' })
    ).toEqual({ dom: true, node: false });
  });
});
