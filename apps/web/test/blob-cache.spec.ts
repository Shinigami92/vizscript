import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { looksLikeFile } from '../src/graph/project-files';
import { cachedBlob, clearBlobs, storeBlob } from '../src/storage/blob-cache';

/** The Cache API, in memory. */
function fakeCaches(): CacheStorage {
  const stores = new Map<string, Map<string, string>>();
  const cache = (name: string): Cache => {
    const store = stores.get(name) ?? new Map<string, string>();
    stores.set(name, store);
    return {
      match: async (request: Request) => {
        const text = store.get(request.url);
        return text === undefined ? undefined : new Response(text);
      },
      put: async (request: Request, response: Response) => {
        store.set(request.url, await response.text());
      },
    } as unknown as Cache;
  };
  return {
    open: async (name: string) => cache(name),
    delete: async (name: string) => stores.delete(name),
  } as unknown as CacheStorage;
}

const KEY = { provider: 'github', owner: 'o', repo: 'r', sha: 'abc' };

describe('file contents by blob sha', () => {
  beforeEach(() => {
    vi.stubGlobal('caches', fakeCaches());
    vi.stubGlobal('location', { origin: 'http://localhost' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps and forgets contents', async () => {
    expect(await cachedBlob(KEY)).toBeUndefined();
    await storeBlob(KEY, 'export const a = 1;\n');
    expect(await cachedBlob(KEY)).toBe('export const a = 1;\n');
    expect(await cachedBlob({ ...KEY, sha: 'other' })).toBeUndefined();
    await clearBlobs();
    expect(await cachedBlob(KEY)).toBeUndefined();
  });

  it('works without the Cache API', async () => {
    vi.stubGlobal('caches', undefined);
    await storeBlob(KEY, 'x');
    expect(await cachedBlob(KEY)).toBeUndefined();
  });
});

describe('looksLikeFile', () => {
  it('takes names with an extension for files', () => {
    expect(looksLikeFile('apps/api/src/main.ts')).toBe(true);
    expect(looksLikeFile('README.md')).toBe(true);
    expect(looksLikeFile('apps/api/src')).toBe(false);
    expect(looksLikeFile('.github')).toBe(false);
    expect(looksLikeFile('LICENSE')).toBe(false);
    expect(looksLikeFile('a.b/c')).toBe(false);
  });
});
