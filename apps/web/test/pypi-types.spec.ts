import { parsePythonDocument, preparePythonStub } from '@vizscript/lang-python';
import { describe, expect, it } from 'vitest';
import { pythonPackageVersion } from '../src/graph/pypi-types';
import { packageSource, TypeshedStubs } from '../src/graph/python-stubs';

function stubsOf(files: Record<string, string>): TypeshedStubs {
  return new TypeshedStubs(
    async (text) => preparePythonStub(text, '3.12'),
    async (text, fileName) => parsePythonDocument(text, fileName),
    packageSource(files)
  );
}

describe("a package's own types", () => {
  it('follows re-exports between its .py files', async () => {
    const stubs = stubsOf({
      'httpx/__init__.py':
        'from ._client import Client as Client\nfrom ._api import *\n',
      'httpx/_client.py':
        'class Client:\n    def get(self, url: str) -> int:\n        return 1\n',
      'httpx/_api.py': 'def get(url: str) -> int:\n    return 1\n',
    });
    const names = (await stubs.exportsOf('httpx')).map((s) => s.name);
    expect(names.toSorted()).toEqual(['Client', 'get']);
  });

  it('reads a stub before the module next to it (PEP 561)', async () => {
    const stubs = stubsOf({
      'fast/__init__.pyi': 'def speed() -> int: ...\n',
      'fast/__init__.py': 'def speed(): return 1\ndef hidden(): pass\n',
    });
    const exports = await stubs.exportsOf('fast');
    expect(exports.map((s) => s.name)).toEqual(['speed']);
  });
});

describe('pythonPackageVersion', () => {
  it('takes the lock, a pin, else the latest', () => {
    expect(pythonPackageVersion({ range: '>=2', version: '2.32.3' })).toBe(
      '2.32.3'
    );
    expect(pythonPackageVersion({ range: '==0.27.0' })).toBe('0.27.0');
    expect(pythonPackageVersion({ range: '>=0.27,<1' })).toBe('latest');
  });
});
