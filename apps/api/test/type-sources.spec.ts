import { describe, expect, it } from 'vitest';
import { byteSize, DEFAULT_TYPE_CACHE_BYTES } from '../src/config/config';
import {
  typeCrateSource,
  typeFileSource,
  typeListingSource,
  typePypiSource,
} from '../src/types/type-sources';

const UPSTREAM = {
  cdn: 'https://cdn.jsdelivr.net/',
  listing: 'https://data.jsdelivr.com/v1/packages/',
  docs: 'https://docs.rs/',
  pypi: 'https://pypi.org/',
  pypiFiles: 'https://files.pythonhosted.org/',
};
const COMMIT = 'f0512c2d5d5d319570d2517d74419633c0174ec2';

describe('type sources', () => {
  it('maps npm declaration files to jsDelivr; exact versions never change', () => {
    expect(
      typeFileSource(
        'npm/@vue/runtime-dom@3.5.45/dist/runtime-dom.d.ts',
        UPSTREAM
      )
    ).toEqual({
      key: 'file:npm/@vue/runtime-dom@3.5.45/dist/runtime-dom.d.ts',
      url: 'https://cdn.jsdelivr.net/npm/@vue/runtime-dom@3.5.45/dist/runtime-dom.d.ts',
      immutable: true,
      kind: 'file',
    });
    // A range, as the web app encodes it: fetched again after a day.
    expect(
      typeFileSource('npm/vue@%5E3.5.0/package.json', UPSTREAM)
    ).toMatchObject({
      key: 'file:npm/vue@^3.5.0/package.json',
      url: 'https://cdn.jsdelivr.net/npm/vue@%5E3.5.0/package.json',
      immutable: false,
    });
    expect(
      typeFileSource('npm/vue@latest/package.json', UPSTREAM)?.immutable
    ).toBe(false);
  });

  it('allows typeshed at a commit', () => {
    expect(
      typeFileSource(
        `gh/python/typeshed@${COMMIT}/stdlib/json/__init__.pyi`,
        UPSTREAM
      )?.immutable
    ).toBe(true);
    expect(
      typeFileSource('gh/python/typeshed@main/stdlib/os.pyi', UPSTREAM)
    ).toBe(undefined);
    expect(typeFileSource(`gh/evil/repo@${COMMIT}/x.pyi`, UPSTREAM)).toBe(
      undefined
    );
  });

  it('rejects scripts, other hosts and paths that climb out', () => {
    for (const path of [
      'npm/vue@3.5.45/dist/vue.js',
      'npm/vue@3.5.45/../../etc/passwd.d.ts',
      'npm/vue@3.5.45//x.d.ts',
      'https://example.test/x.d.ts',
      'npm/Vue@3.5.45/x.d.ts',
      'npm/vue@3.5.45',
      `npm/vue@${'1'.repeat(70)}/x.d.ts`,
      'npm/vue@$(rm)/x.d.ts',
    ]) {
      expect(typeFileSource(path, UPSTREAM)).toBeUndefined();
    }
  });

  it('lists exact versions and typeshed commits only', () => {
    expect(typeListingSource('npm/vue@3.5.45', UPSTREAM)).toEqual({
      key: 'listing:npm/vue@3.5.45',
      url: 'https://data.jsdelivr.com/v1/packages/npm/vue@3.5.45?structure=flat',
      immutable: true,
      kind: 'listing',
    });
    expect(
      typeListingSource(`gh/python/typeshed@${COMMIT}`, UPSTREAM)?.url
    ).toBe(
      `https://data.jsdelivr.com/v1/packages/gh/python/typeshed@${COMMIT}?structure=flat`
    );
    expect(typeListingSource('npm/vue@latest', UPSTREAM)).toBeUndefined();
    expect(typeListingSource('npm/vue@3.5.45/x', UPSTREAM)).toBeUndefined();
  });
});

describe('crate sources', () => {
  it('asks docs.rs, the compatible version when the exact one has none', () => {
    expect(typeCrateSource('serde_json', '1.0.150', UPSTREAM)).toEqual({
      key: 'crate:serde_json@1.0.150',
      url: 'https://docs.rs/crate/serde_json/1.0.150/json',
      immutable: true,
      kind: 'crate',
      fallback: 'https://docs.rs/crate/serde_json/%5E1.0.150/json',
      crate: { name: 'serde_json', version: '1.0.150' },
    });
    expect(typeCrateSource('nom', '8', UPSTREAM)).toMatchObject({
      url: 'https://docs.rs/crate/nom/8/json',
      immutable: false,
    });
    expect(typeCrateSource('../evil', '1.0.0', UPSTREAM)).toBeUndefined();
    expect(typeCrateSource('nom', '1.0/../x', UPSTREAM)).toBeUndefined();
  });
});

describe('PyPI sources', () => {
  it('asks for an exact release, else the latest; names are normalized', () => {
    expect(typePypiSource('Flask_SQLAlchemy', '3.1.1', UPSTREAM)).toEqual({
      key: 'pypi:flask-sqlalchemy@3.1.1',
      url: 'https://pypi.org/pypi/flask-sqlalchemy/3.1.1/json',
      immutable: true,
      kind: 'pypi',
      crate: { name: 'flask-sqlalchemy', version: '3.1.1' },
    });
    expect(typePypiSource('httpx', '>=0.27', UPSTREAM)).toMatchObject({
      key: 'pypi:httpx@latest',
      url: 'https://pypi.org/pypi/httpx/json',
      immutable: false,
    });
    expect(typePypiSource('../x', '1.0', UPSTREAM)).toBeUndefined();
  });
});

describe('byteSize', () => {
  it('reads plain bytes and K / M / G sizes, 1 GB by default', () => {
    expect(byteSize(undefined)).toBe(DEFAULT_TYPE_CACHE_BYTES);
    expect(byteSize('1048576')).toBe(1_048_576);
    expect(byteSize('512MB')).toBe(512 * 1024 * 1024);
    expect(byteSize('2g')).toBe(2 * 1024 ** 3);
    expect(() => byteSize('lots')).toThrow('TYPE_CACHE_MAX_BYTES');
  });
});
