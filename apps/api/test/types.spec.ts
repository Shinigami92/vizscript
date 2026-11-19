import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { TypeCacheStats } from '@vizscript/api-contract';
import { sql } from 'kysely';
import { createServer } from 'node:http';
import type { AddressInfo, Server } from 'node:net';
import { zstdCompressSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import type { AppConfig } from '../src/config/config';
import { createDatabase } from '../src/database/database.module';
import { TypeCacheService } from '../src/types/type-cache.service';
import { RUSTDOC } from './rustdoc-fixture';
import { zip } from './zip';

const databaseUrl = process.env.DATABASE_URL;
const runId = Math.random().toString(36).slice(2, 8);
const pkg = `vz-types-${runId}`;

/** jsDelivr in small: the files it has, and how often each was asked for. */
const upstreamFiles: Record<string, string> = {
  [`/npm/${pkg}@1.0.0/index.d.ts`]: 'export declare const one: 1;',
  [`/npm/${pkg}@1.0.0/a.d.ts`]: 'export declare const a: 1;',
  [`/npm/${pkg}@1.0.0/b.d.ts`]: 'export declare const b: 1;',
  [`/npm/${pkg}@latest/package.json`]: '{"version":"1.0.0"}',
  [`/v1/packages/npm/${pkg}@1.0.0?structure=flat`]:
    '{"files":[{"name":"/index.d.ts"}]}',
};
const upstreamRequests = new Map<string, number>();

/** PyPI: a release, its wheel, and a release naming a foreign host. */
const pypiFiles: Record<string, Buffer> = {
  [`/pypi-api/pypi/${pkg}/0.27.0/json`]: Buffer.from(
    JSON.stringify({
      info: { version: '0.27.0' },
      urls: [
        { filename: `${pkg}-0.27.0.tar.gz`, url: 'x', size: 1 },
        {
          filename: `${pkg}-0.27.0-py3-none-any.whl`,
          url: '{base}/pypi-files/a.whl',
          size: 2,
        },
      ],
    })
  ),
  [`/pypi-api/pypi/${pkg}/0.1.0/json`]: Buffer.from(
    JSON.stringify({
      urls: [
        {
          filename: `${pkg}-0.1.0-py3-none-any.whl`,
          url: 'https://example.test/a.whl',
        },
      ],
    })
  ),
  '/pypi-files/a.whl': zip({
    'pkg/__init__.py': 'def get(url: str) -> int: ...\n',
    'pkg/py.typed': '',
  }),
};

/** The registries' search answers. */
const searchFiles: Record<string, string> = {
  [`/npm-registry/-/v1/search?text=${pkg}&size=20`]: JSON.stringify({
    objects: [{ package: { name: pkg, version: '2.0.0' } }],
  }),
  [`/crates-io/api/v1/crates?q=${pkg}&per_page=20`]: JSON.stringify({
    crates: [{ name: pkg, max_stable_version: '0.3.0' }],
  }),
};

/** docs.rs serves rustdoc JSON compressed with zstd. */
const crateFiles: Record<string, Buffer> = {
  [`/docs/crate/${pkg}/1.2.3/json`]: zstdCompressSync(
    Buffer.from(JSON.stringify(RUSTDOC))
  ),
  // An old version without rustdoc JSON: the compatible one instead.
  [`/docs/crate/${pkg}/%5E1.0.0/json`]: zstdCompressSync(
    Buffer.from(JSON.stringify(RUSTDOC))
  ),
};

function get(app: NestFastifyApplication, url: string) {
  return app.inject({ method: 'GET', url });
}

describe.skipIf(!databaseUrl)('type registry (e2e)', () => {
  let app: NestFastifyApplication;
  let upstream: Server;
  let config: AppConfig;

  beforeAll(async () => {
    upstream = createServer((request, response) => {
      const url = request.url ?? '';
      upstreamRequests.set(url, (upstreamRequests.get(url) ?? 0) + 1);
      const pypi = pypiFiles[url]
        ?.toString('latin1')
        .replace(
          '{base}',
          `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
        );
      const body =
        upstreamFiles[url] ??
        searchFiles[url] ??
        crateFiles[url] ??
        (url.endsWith('.whl')
          ? pypiFiles[url]
          : pypi && Buffer.from(pypi, 'latin1'));
      response.statusCode = body === undefined ? 404 : 200;
      response.end(body ?? 'Not found');
    });
    await new Promise<void>((resolve) => {
      upstream.listen(0, '127.0.0.1', resolve);
    });
    const base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    config = {
      port: 0,
      host: '127.0.0.1',
      databaseUrl: databaseUrl ?? '',
      appSecret: 'test-secret-test-secret-test-secret!',
      secureCookies: false,
      sessionTtlDays: 1,
      runMigrations: true,
      githubApiUrl: 'https://api.github.com',
      githubRawUrl: 'https://raw.githubusercontent.com',
      githubWebUrl: 'https://github.com',
      typeCacheMaxBytes: 1024 * 1024 * 1024,
      typeUpstream: {
        cdn: `${base}/`,
        listing: `${base}/v1/packages/`,
        docs: `${base}/docs/`,
        pypi: `${base}/pypi-api/`,
        pypiFiles: `${base}/pypi-files/`,
        npmRegistry: `${base}/npm-registry/`,
        crates: `${base}/crates-io/`,
      },
    };
    app = await createApp(config, { logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    const db = createDatabase(databaseUrl ?? '');
    await db
      .deleteFrom('type_cache')
      .where('key', 'like', `%${pkg}%`)
      .execute();
    await db.destroy();
    await app?.close();
    upstream?.close();
  });

  it('fetches a file once and serves it from the cache after', async () => {
    const url = `/api/types?path=npm/${pkg}@1.0.0/index.d.ts`;
    const first = await get(app, url);
    expect(first.statusCode).toBe(200);
    expect(first.body).toBe('export declare const one: 1;');
    expect(first.headers['cache-control']).toContain('immutable');
    const second = await get(app, url);
    expect(second.body).toBe(first.body);
    expect(upstreamRequests.get(`/npm/${pkg}@1.0.0/index.d.ts`)).toBe(1);
  });

  it('remembers files that are missing', async () => {
    const url = `/api/types?path=npm/${pkg}@1.0.0/missing.d.ts`;
    expect((await get(app, url)).statusCode).toBe(404);
    expect((await get(app, url)).statusCode).toBe(404);
    expect(upstreamRequests.get(`/npm/${pkg}@1.0.0/missing.d.ts`)).toBe(1);
  });

  it('keeps a version range for a day only', async () => {
    const response = await get(
      app,
      `/api/types?path=npm/${pkg}@latest/package.json`
    );
    expect(response.json()).toEqual({ version: '1.0.0' });
    expect(response.headers['cache-control']).toBe('public, max-age=3600');
  });

  it('serves listings of exact versions', async () => {
    const response = await get(app, `/api/types/listing?path=npm/${pkg}@1.0.0`);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json()).toEqual({ files: [{ name: '/index.d.ts' }] });
    expect(
      (await get(app, `/api/types/listing?path=npm/${pkg}@latest`)).statusCode
    ).toBe(400);
  });

  it('refuses anything but declaration files of the allowed sources', async () => {
    for (const path of [
      `npm/${pkg}@1.0.0/index.js`,
      'https://example.test/x.d.ts',
      `npm/${pkg}@1.0.0/../../x.d.ts`,
      '',
    ]) {
      const response = await get(
        app,
        `/api/types?path=${encodeURIComponent(path)}`
      );
      expect(response.statusCode).toBe(400);
    }
  });

  it("serves a crate's API as Rust declarations from docs.rs", async () => {
    const response = await get(
      app,
      `/api/types/crate?name=${pkg}&version=1.2.3`
    );
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toContain('immutable');
    const stubs = response.json<{
      version: string;
      modules: Record<string, string>;
    }>();
    expect(stubs.version).toBe('1.2.3');
    expect(stubs.modules.nested).toBe(
      'pub fn run(input: &str) -> Result<Value> {}'
    );

    // No rustdoc JSON of 1.0.0: the newest compatible version, for a day.
    const old = await get(app, `/api/types/crate?name=${pkg}&version=1.0.0`);
    expect(old.statusCode).toBe(200);
    expect(old.headers['cache-control']).toBe('public, max-age=3600');
    expect((await get(app, '/api/types/crate?name=../x')).statusCode).toBe(400);
  });

  it("serves a Python package's typed files from its wheel", async () => {
    const response = await get(
      app,
      `/api/types/pypi?name=${pkg}&version=0.27.0`
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      name: pkg,
      version: '0.27.0',
      files: { 'pkg/__init__.py': 'def get(url: str) -> int: ...\n' },
    });
    // A wheel on another host than PyPI's files is never fetched.
    expect(
      (await get(app, `/api/types/pypi?name=${pkg}&version=0.1.0`)).statusCode
    ).toBe(404);
  });

  it('searches the registries for libraries to add', async () => {
    const npm = await get(app, `/api/types/search?ecosystem=npm&q=${pkg}`);
    expect(npm.json()).toEqual([{ name: pkg, version: '2.0.0' }]);
    const crates = await get(
      app,
      `/api/types/search?ecosystem=crates&q=${pkg}`
    );
    expect(crates.json()).toEqual([{ name: pkg, version: '0.3.0' }]);
    // Asked once: the second search comes from memory.
    await get(app, `/api/types/search?ecosystem=npm&q=${pkg}`);
    expect(
      upstreamRequests.get(`/npm-registry/-/v1/search?text=${pkg}&size=20`)
    ).toBe(1);
    // PyPI by exact name; an unknown one finds nothing.
    const pypi = await get(
      app,
      `/api/types/search?ecosystem=pypi&q=${pkg}-nope`
    );
    expect(pypi.json()).toEqual([]);
    expect(
      (await get(app, '/api/types/search?ecosystem=maven&q=x')).statusCode
    ).toBe(400);
  });

  it('reports how full the cache is', async () => {
    const stats = (await get(app, '/api/types/stats')).json<TypeCacheStats>();
    expect(stats.maxBytes).toBe(1024 * 1024 * 1024);
    expect(stats.entries).toBeGreaterThanOrEqual(4);
    expect(stats.hits).toBeGreaterThanOrEqual(2);
    expect(stats.hitRate).toBeGreaterThan(0);
  });

  it('drops the least recently used files over the limit', async () => {
    for (const name of ['a', 'b']) {
      await get(app, `/api/types?path=npm/${pkg}@1.0.0/${name}.d.ts`);
    }

    // Ours are the newest rows: `b`, then `a`, then the other files.
    const db = createDatabase(databaseUrl ?? '');
    const key = (name: string): string => `file:npm/${pkg}@1.0.0/${name}.d.ts`;
    await db
      .updateTable('type_cache')
      .set({ last_used_at: sql`now() + interval '1 day'` })
      .where('key', '=', key('a'))
      .execute();
    await db
      .updateTable('type_cache')
      .set({ last_used_at: sql`now() + interval '2 days'` })
      .where('key', '=', key('b'))
      .execute();

    // Room for `b` only.
    const limited = new TypeCacheService(db, {
      ...config,
      typeCacheMaxBytes: Buffer.byteLength(
        upstreamFiles[`/npm/${pkg}@1.0.0/b.d.ts`] ?? ''
      ),
    });
    await limited.evict(true);
    const left = await db
      .selectFrom('type_cache')
      .select('key')
      .where('key', 'in', [key('a'), key('b')])
      .execute();
    await db.destroy();
    expect(left.map((row) => row.key)).toEqual([key('b')]);
  });
});
