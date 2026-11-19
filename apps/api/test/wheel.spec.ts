import { describe, expect, it } from 'vitest';
import { pickWheel, wheelTypes } from '../src/types/wheel';
import { zip } from './zip';

describe('wheelTypes', () => {
  it('keeps stubs and the Python files of typed packages', () => {
    const wheel = zip({
      'httpx/__init__.py': 'from ._client import Client as Client\n',
      'httpx/_client.py':
        'class Client:\n    def get(self, url: str) -> "Response": ...\n',
      'httpx/py.typed': '',
      'httpx/_native.pyi': 'def fast() -> int: ...\n',
      'httpx/_native.py': 'def fast(): return 1\n',
      'untyped/__init__.py': 'x = 1\n',
      'httpx-0.27.0.dist-info/METADATA': 'Name: httpx\n',
    });
    const types = wheelTypes(wheel, 'httpx', '0.27.0');
    expect(types.version).toBe('0.27.0');
    expect(Object.keys(types.files).toSorted()).toEqual([
      'httpx/__init__.py',
      'httpx/_client.py',
      'httpx/_native.pyi',
    ]);
    expect(types.files['httpx/__init__.py']).toBe(
      'from ._client import Client as Client\n'
    );
  });

  it('has no files for a package without types, or no zip', () => {
    expect(
      wheelTypes(zip({ 'plain/__init__.py': 'x = 1\n' }), 'plain', '1.0').files
    ).toEqual({});
    expect(wheelTypes(Buffer.from('not a zip'), 'x', '1.0').files).toEqual({});
  });
});

describe('pickWheel', () => {
  it('prefers a pure-Python wheel, else the smallest', () => {
    expect(
      pickWheel([
        { filename: 'x-1.0.tar.gz', url: 'sdist' },
        { filename: 'x-1.0-cp312-cp312-manylinux.whl', url: 'linux', size: 9 },
        { filename: 'x-1.0-py3-none-any.whl', url: 'pure', size: 99 },
      ])
    ).toBe('pure');
    expect(
      pickWheel([
        { filename: 'x-1.0-cp312-win_amd64.whl', url: 'win', size: 20 },
        { filename: 'x-1.0-cp312-macosx.whl', url: 'mac', size: 10 },
      ])
    ).toBe('mac');
    expect(
      pickWheel([{ filename: 'x-1.0.tar.gz', url: 'sdist' }])
    ).toBeUndefined();
  });
});
