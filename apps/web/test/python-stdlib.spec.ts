import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  pythonStdlibModules,
  TYPESHED_COMMIT,
} from '../src/graph/python-stubs';

// Its own file: typeshed's listing is read once per visit (module state).
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('pythonStdlibModules', () => {
  it('lists the standard library from typeshed, private ones too', async () => {
    const listing = JSON.stringify({
      files: [
        'stdlib/json/__init__.pyi',
        'stdlib/re.pyi',
        'stdlib/_typeshed/__init__.pyi',
        'stubs/requests/requests/__init__.pyi',
      ].map((name) => ({ name: `/${name}` })),
    });
    vi.stubGlobal('fetch', async (url: string) => ({
      ok: url.includes(`typeshed@${TYPESHED_COMMIT}?structure=flat`),
      status: 200,
      text: async () => listing,
    }));
    const names = await pythonStdlibModules();
    expect([...names].toSorted()).toEqual(['_typeshed', 'json', 're']);
  });
});
