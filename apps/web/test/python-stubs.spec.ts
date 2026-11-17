import { parsePythonDocument, preparePythonStub } from '@vizscript/lang-python';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  relativeModule,
  stubVersion,
  TYPESHED,
  TYPESHED_COMMIT,
  typeshedPaths,
  TypeshedStubs,
} from '../src/graph/python-stubs';

/** Serves typeshed `files` (by path) and its listing. */
function serve(files: Record<string, string>): void {
  const listing = JSON.stringify({
    files: Object.keys(files).map((name) => ({ name: `/${name}` })),
  });
  vi.stubGlobal('fetch', async (url: string) => {
    const body = url.includes(`typeshed@${TYPESHED_COMMIT}?structure=flat`)
      ? listing
      : files[url.slice(TYPESHED.length)];
    return {
      ok: body !== undefined,
      status: body === undefined ? 404 : 200,
      text: async () => body,
    };
  });
}

function stubs(): TypeshedStubs {
  return new TypeshedStubs(
    async (text) => preparePythonStub(text, '3.12'),
    async (text, fileName) => parsePythonDocument(text, fileName)
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('typeshed stubs', () => {
  it('finds a module in the standard library, then in other stubs', () => {
    const files = new Set([
      'stdlib/json/__init__.pyi',
      'stdlib/os/path.pyi',
      'stubs/PyYAML/yaml/__init__.pyi',
      'stubs/other/vendored/yaml/__init__.pyi',
    ]);
    expect(typeshedPaths('json', files)).toEqual(['stdlib/json/__init__.pyi']);
    expect(typeshedPaths('os.path', files)).toEqual(['stdlib/os/path.pyi']);
    expect(typeshedPaths('yaml', files)).toEqual([
      'stubs/PyYAML/yaml/__init__.pyi',
    ]);
    // Without a listing, the standard library's places.
    expect(typeshedPaths('re', undefined)).toEqual([
      'stdlib/re.pyi',
      'stdlib/re/__init__.pyi',
    ]);
  });

  it('resolves relative imports of a stub', () => {
    expect(relativeModule('stdlib/json/__init__.pyi', '.decoder')).toBe(
      'stdlib/json/decoder'
    );
    expect(relativeModule('stubs/a/pkg/sub/x.pyi', '..util')).toBe(
      'stubs/a/pkg/util'
    );
  });

  it('reads the version stubs are for from the project version', () => {
    expect(stubVersion('≥3.11')).toBe('3.11');
    expect(stubVersion('3.12.4')).toBe('3.12');
    expect(stubVersion(undefined)).toBeUndefined();
  });

  it('reads exports with what a stub re-exports', async () => {
    serve({
      'stubs/pkg/pkg/__init__.pyi':
        'from . import api as api\nfrom .api import get as get\nfrom .errors import *\nfrom .api import _hidden\ndef top() -> int: ...\n',
      'stubs/pkg/pkg/api.pyi':
        'def get(url: str) -> bytes: ...\ndef post(url: str) -> bytes: ...\n',
      'stubs/pkg/pkg/errors.pyi': 'class PkgError(Exception): ...\n',
    });
    const names = (await stubs().exportsOf('pkg')).map(
      (s) => `${s.kind} ${s.name}`
    );
    expect(names).toEqual(['function top', 'function get', 'class PkgError']);
  });
});
