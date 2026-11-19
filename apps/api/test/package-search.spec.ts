import { describe, expect, it } from 'vitest';
import { searchResults, searchUrl } from '../src/types/package-search';

const UPSTREAM = {
  npmRegistry: 'https://registry.npmjs.org/',
  crates: 'https://crates.io/',
  pypi: 'https://pypi.org/',
};

describe('package search', () => {
  it('asks each registry its way; PyPI by exact name', () => {
    expect(searchUrl('npm', 'vue router', UPSTREAM)).toBe(
      'https://registry.npmjs.org/-/v1/search?text=vue%20router&size=20'
    );
    expect(searchUrl('crates', 'serde', UPSTREAM)).toBe(
      'https://crates.io/api/v1/crates?q=serde&per_page=20'
    );
    expect(searchUrl('pypi', 'Typing_Extensions', UPSTREAM)).toBe(
      'https://pypi.org/pypi/typing-extensions/json'
    );
    expect(searchUrl('pypi', 'two words', UPSTREAM)).toBeUndefined();
    expect(searchUrl('npm', '  ', UPSTREAM)).toBeUndefined();
  });

  it('reads names, latest stable versions and descriptions', () => {
    expect(
      searchResults('npm', {
        objects: [
          { package: { name: 'vue', version: '3.5.45', description: 'UI' } },
        ],
      })
    ).toEqual([{ name: 'vue', version: '3.5.45', description: 'UI' }]);
    expect(
      searchResults('crates', {
        crates: [
          {
            name: 'serde',
            max_stable_version: '1.0.228',
            newest_version: '2.0.0-rc.1',
          },
        ],
      })
    ).toEqual([{ name: 'serde', version: '1.0.228' }]);
    expect(
      searchResults('pypi', {
        info: { name: 'httpx', version: '0.28.1', summary: 'HTTP' },
      })
    ).toEqual([{ name: 'httpx', version: '0.28.1', description: 'HTTP' }]);
    expect(searchResults('npm', 'garbage')).toEqual([]);
  });
});
