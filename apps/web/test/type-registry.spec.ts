import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchText } from '../src/graph/npm-types';
import { registryUrl } from '../src/graph/type-registry';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('registryUrl', () => {
  it('maps jsDelivr files and listings to the server', () => {
    expect(
      registryUrl('https://cdn.jsdelivr.net/npm/vue@%5E3.5.0/package.json')
    ).toBe('/api/types?path=npm%2Fvue%40%255E3.5.0%2Fpackage.json');
    expect(
      registryUrl(
        'https://data.jsdelivr.com/v1/packages/npm/vue@3.5.45?structure=flat'
      )
    ).toBe('/api/types/listing?path=npm%2Fvue%403.5.45');
    expect(registryUrl('https://example.test/x.d.ts')).toBeUndefined();
  });
});

describe('fetchText with the registry', () => {
  it('reads through the server, and from jsDelivr when it fails', async () => {
    const requests: string[] = [];
    const files: Record<string, { status: number; body: string }> = {
      '/api/config': {
        status: 200,
        body: JSON.stringify({ github: {}, typeRegistry: true }),
      },
      '/api/types?path=npm%2Fcached%401.0.0%2Findex.d.ts': {
        status: 200,
        body: 'from the server',
      },
      '/api/types?path=npm%2Fbroken%401.0.0%2Findex.d.ts': {
        status: 502,
        body: '',
      },
      'https://cdn.jsdelivr.net/npm/broken@1.0.0/index.d.ts': {
        status: 200,
        body: 'from jsDelivr',
      },
    };
    vi.stubGlobal('fetch', async (url: string) => {
      requests.push(url);
      const file = files[url] ?? { status: 404, body: '' };
      return {
        ok: file.status === 200,
        status: file.status,
        statusText: '',
        text: async () => file.body,
        json: async () => JSON.parse(file.body) as unknown,
      };
    });

    expect(
      await fetchText('https://cdn.jsdelivr.net/npm/cached@1.0.0/index.d.ts')
    ).toBe('from the server');
    expect(requests).not.toContain(
      'https://cdn.jsdelivr.net/npm/cached@1.0.0/index.d.ts'
    );
    expect(
      await fetchText('https://cdn.jsdelivr.net/npm/broken@1.0.0/index.d.ts')
    ).toBe('from jsDelivr');
  });
});
