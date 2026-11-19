import type { GraphDocument, Reexport, ScriptSymbol } from '@vizscript/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CDN, fetchText, NpmTypes } from '../src/graph/npm-types';

/** Serves `files` (by URL) and counts the requests. */
function serve(files: Record<string, string>): Map<string, number> {
  const requests = new Map<string, number>();
  vi.stubGlobal('fetch', async (url: string) => {
    requests.set(url, (requests.get(url) ?? 0) + 1);
    const body = files[url];
    return {
      ok: body !== undefined,
      status: body === undefined ? 404 : 200,
      text: async () => body,
    };
  });
  return requests;
}

function exported(name: string): ScriptSymbol {
  return {
    name,
    kind: 'function',
    scope: '',
    modifiers: ['export'],
    params: [],
  } as unknown as ScriptSymbol;
}

/**
 * Declaration files written as `exports a, b; from ./x, pkg`: the parse
 * stands in for the backend's.
 */
function npmTypes(): NpmTypes {
  return new NpmTypes(async (text) => {
    const [exportList = '', modules = ''] = text.split(';');
    const reexports: Reexport[] = modules
      .replace('from', '')
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean)
      .map((module) => ({ module, imported: '*', name: '*' }));
    return {
      functions: [],
      symbols: exportList
        .replace('exports', '')
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean)
        .map(exported),
      reexports,
    } as unknown as GraphDocument;
  });
}

function names(symbols: ReadonlyArray<ScriptSymbol>): string[] {
  return symbols.map((s) => s.name).toSorted();
}

function manifest(name: string, types: string): Record<string, string> {
  return {
    [`${CDN}${name}@latest/package.json`]: JSON.stringify({
      version: '1.0.0',
      types,
    }),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('NpmTypes', () => {
  it('follows cyclic relative re-exports', async () => {
    serve({
      ...manifest('cyc', 'a.d.ts'),
      [`${CDN}cyc@1.0.0/a.d.ts`]: 'exports a; from ./b',
      [`${CDN}cyc@1.0.0/b.d.ts`]: 'exports b; from ./a',
    });
    expect(names(await npmTypes().exportsOf('cyc'))).toEqual(['a', 'b']);
  });

  it('follows packages that re-export each other', async () => {
    serve({
      ...manifest('left', 'index.d.ts'),
      ...manifest('right', 'index.d.ts'),
      [`${CDN}left@1.0.0/index.d.ts`]: 'exports l; from right',
      [`${CDN}right@1.0.0/index.d.ts`]: 'exports r; from left',
    });
    const npm = npmTypes();
    const [left, right] = await Promise.all([
      npm.exportsOf('left'),
      npm.exportsOf('right'),
    ]);
    expect(names(left)).toEqual(['l', 'r']);
    expect(names(right)).toEqual(['l', 'r']);
  });

  it('reads files re-exporting each other side by side without waiting forever', async () => {
    // `index` → `b`, `c`; `b` → `c` and `c` → `b`: read in parallel, a
    // naive walk would wait for `b` and `c` on each other.
    serve({
      ...manifest('knot', 'index.d.ts'),
      [`${CDN}knot@1.0.0/index.d.ts`]: 'exports top; from ./b, ./c',
      [`${CDN}knot@1.0.0/b.d.ts`]: 'exports b; from ./c',
      [`${CDN}knot@1.0.0/c.d.ts`]: 'exports c; from ./b',
    });
    expect(names(await npmTypes().exportsOf('knot'))).toEqual([
      'b',
      'c',
      'top',
    ]);
  });

  it('reads a file re-exported twice once', async () => {
    const requests = serve({
      ...manifest('diamond', 'index.d.ts'),
      [`${CDN}diamond@1.0.0/index.d.ts`]: 'exports top; from ./b, ./c',
      [`${CDN}diamond@1.0.0/b.d.ts`]: 'exports b; from ./d',
      [`${CDN}diamond@1.0.0/c.d.ts`]: 'exports c; from ./d',
      [`${CDN}diamond@1.0.0/d.d.ts`]: 'exports d',
    });
    expect(names(await npmTypes().exportsOf('diamond'))).toEqual([
      'b',
      'c',
      'd',
      'top',
    ]);
    expect(requests.get(`${CDN}diamond@1.0.0/d.d.ts`)).toBe(1);
  });
});

/** jsDelivr's file listing of `name@1.0.0`. */
const listing = (name: string, files: string[]): Record<string, string> => ({
  [`https://data.jsdelivr.com/v1/packages/npm/${name}@1.0.0?structure=flat`]:
    JSON.stringify({ files: files.map((f) => ({ name: `/${f}` })) }),
});

describe('NpmTypes with a file listing', () => {
  it('reads only files the listing names', async () => {
    const requests = serve({
      ...manifest('listed', 'index.d.ts'),
      ...listing('listed', ['package.json', 'index.d.ts', 'lib/index.d.ts']),
      [`${CDN}listed@1.0.0/index.d.ts`]: 'exports a; from ./lib',
      [`${CDN}listed@1.0.0/lib/index.d.ts`]: 'exports b',
    });
    expect(names(await npmTypes().exportsOf('listed'))).toEqual(['a', 'b']);
    // `./lib` could be `lib.d.ts`: not listed, so not asked for.
    expect(requests.has(`${CDN}listed@1.0.0/lib.d.ts`)).toBe(false);
  });

  it('reads index.d.ts of a package without a types entry', async () => {
    serve({
      [`${CDN}plain@latest/package.json`]: JSON.stringify({ version: '1.0.0' }),
      ...listing('plain', ['package.json', 'index.d.ts']),
      [`${CDN}plain@1.0.0/index.d.ts`]: 'exports p',
    });
    expect(names(await npmTypes().exportsOf('plain'))).toEqual(['p']);
  });
});

describe('fetchText', () => {
  it('tries again after a network error, not after a 404', async () => {
    let fail = true;
    const requests: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      requests.push(url);
      if (url.endsWith('missing')) {
        return { ok: false, status: 404, text: async () => '' };
      }

      if (fail) {
        throw new TypeError('network');
      }

      return { ok: true, status: 200, text: async () => 'text' };
    });

    expect(await fetchText('https://example.test/flaky')).toBeUndefined();
    fail = false;
    expect(await fetchText('https://example.test/flaky')).toBe('text');

    expect(await fetchText('https://example.test/missing')).toBeUndefined();
    expect(await fetchText('https://example.test/missing')).toBeUndefined();
    expect(requests.filter((u) => u.endsWith('missing'))).toHaveLength(1);
  });
});
