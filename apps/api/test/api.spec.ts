import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { RepoSummary } from '@vizscript/api-contract';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { SecretBox } from '../src/common/crypto';
import type { AppConfig } from '../src/config/config';
import { createDatabase } from '../src/database/database.module';
import { runMigrations } from '../src/database/migrate';
import type { ScmProvider } from '../src/scm/scm-provider';

const databaseUrl = process.env.DATABASE_URL;
const runId = Math.random().toString(36).slice(2, 8);

const repo: RepoSummary = {
  id: `repo-${runId}`,
  owner: 'octo',
  name: `demo-${runId}`,
  fullName: `octo/demo-${runId}`,
  description: null,
  private: false,
  defaultBranch: 'main',
  updatedAt: null,
};

const fakeProvider: ScmProvider = {
  id: 'github',
  verifyToken: async (token) => {
    if (token !== 'valid-token-1234') {
      const { UnauthorizedException } = await import('@nestjs/common');
      throw new UnauthorizedException('bad token');
    }

    return {
      providerUserId: `user-${runId}`,
      login: 'octocat',
      name: 'Octo Cat',
      avatarUrl: null,
      scopes: 'repo',
    };
  },
  listRepos: async () => [repo],
  getRepo: async () => repo,
  listBranches: async () => [{ name: 'main' }],
  getTree: async (_t, _o, _r, ref) => ({
    ref,
    truncated: false,
    entries: [{ path: 'src/index.ts', type: 'file' }],
  }),
  getFile: async (_t, _o, _r, ref, path) => ({
    path,
    ref,
    sha: 'abc',
    content: 'console.log(1);',
  }),
};

describe('SecretBox', () => {
  it('round-trips secrets and rejects tampering', () => {
    const box = new SecretBox('x'.repeat(32));
    const secret = box.encrypt('ghp_secret');
    expect(box.decrypt(secret)).toBe('ghp_secret');
    secret.ciphertext[0] = (secret.ciphertext[0] ?? 0) ^ 1;
    expect(() => box.decrypt(secret)).toThrow(
      'Unsupported state or unable to authenticate data'
    );
  });
});

describe.skipIf(!databaseUrl)('api (e2e)', () => {
  let app: NestFastifyApplication;
  let cookie = '';

  beforeAll(async () => {
    const config: AppConfig = {
      port: 0,
      host: '127.0.0.1',
      databaseUrl: databaseUrl ?? '',
      appSecret: 'test-secret-test-secret-test-secret!',
      secureCookies: false,
      sessionTtlDays: 1,
      runMigrations: true,
    };
    await runMigrations(
      config.databaseUrl,
      join(import.meta.dirname, '..', 'migrations')
    );
    app = await createApp(config, {
      scmProviders: [fakeProvider],
      logger: false,
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    const db = createDatabase(databaseUrl ?? '');
    await db
      .deleteFrom('repositories')
      .where('external_id', '=', repo.id)
      .execute();
    await db
      .deleteFrom('users')
      .where('id', 'in', (qb) =>
        qb
          .selectFrom('identities')
          .select('user_id')
          .where('provider_user_id', '=', `user-${runId}`)
      )
      .execute();
    await db.destroy();
    await app?.close();
  });

  it('rejects unauthenticated requests', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(response.statusCode).toBe(401);
  });

  it('rejects invalid tokens', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/token',
      payload: { provider: 'github', token: 'invalid-token-123' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('logs in with a provider token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/token',
      payload: { provider: 'github', token: 'valid-token-1234' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      login: 'octocat',
      provider: 'github',
    });
    const setCookie = response.headers['set-cookie'];
    cookie =
      String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(
        ';'
      )[0] ?? '';
    expect(cookie).toMatch(/^vz_session=/);

    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie },
    });
    expect(me.json()).toMatchObject({ login: 'octocat' });
  });

  it('proxies repository data', async () => {
    const tree = await app.inject({
      method: 'GET',
      url: `/api/scm/github/repos/${repo.owner}/${repo.name}/tree?ref=main`,
      headers: { cookie },
    });
    expect(tree.json().entries).toHaveLength(1);

    const unknown = await app.inject({
      method: 'GET',
      url: '/api/scm/gitlab/repos',
      headers: { cookie },
    });
    expect(unknown.statusCode).toBe(400);
  });

  it('stores and merges layouts', async () => {
    const url = `/api/layouts/github/${repo.owner}/${repo.name}?ref=main&path=src/index.ts`;
    const empty = await app.inject({ method: 'GET', url, headers: { cookie } });
    expect(empty.json()).toEqual({ positions: {}, updatedAt: null });

    await app.inject({
      method: 'PUT',
      url,
      headers: { cookie },
      payload: { positions: { a: { x: 1.4, y: 2 }, b: { x: 3, y: 4 } } },
    });
    const merged = await app.inject({
      method: 'PUT',
      url,
      headers: { cookie },
      payload: { positions: { a: null, c: { x: 5, y: 6 } } },
    });
    expect(merged.json().positions).toEqual({
      b: { x: 3, y: 4 },
      c: { x: 5, y: 6 },
    });

    const invalid = await app.inject({
      method: 'PUT',
      url,
      headers: { cookie },
      payload: { positions: { a: { x: 'nope' } } },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('stores per-user preferences', async () => {
    const url = '/api/preferences/workbench.layout';
    const empty = await app.inject({ method: 'GET', url, headers: { cookie } });
    expect(empty.json()).toEqual({
      key: 'workbench.layout',
      value: null,
      updatedAt: null,
    });

    const value = { version: 1, hidden: ['details'] };
    const saved = await app.inject({
      method: 'PUT',
      url,
      headers: { cookie },
      payload: { value },
    });
    expect(saved.json()).toMatchObject({ value });
    const loaded = await app.inject({
      method: 'GET',
      url,
      headers: { cookie },
    });
    expect(loaded.json().value).toEqual(value);

    const badKey = await app.inject({
      method: 'PUT',
      url: '/api/preferences/Bad%20Key',
      headers: { cookie },
      payload: { value },
    });
    expect(badKey.statusCode).toBe(400);
    const tooLarge = await app.inject({
      method: 'PUT',
      url,
      headers: { cookie },
      payload: { value: 'x'.repeat(40_000) },
    });
    expect(tooLarge.statusCode).toBe(400);

    const removed = await app.inject({
      method: 'DELETE',
      url,
      headers: { cookie },
    });
    expect(removed.statusCode).toBe(204);
    const gone = await app.inject({ method: 'GET', url, headers: { cookie } });
    expect(gone.json().value).toBeNull();

    const anonymous = await app.inject({ method: 'GET', url });
    expect(anonymous.statusCode).toBe(401);
  });

  it('remembers recently opened repositories', async () => {
    const touch = (payload: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: '/api/recent',
        headers: { cookie },
        payload,
      });

    await touch({
      provider: 'github',
      owner: 'octo',
      repo: 'one',
      ref: 'main',
      path: 'a.ts',
    });
    await touch({ provider: 'github', owner: 'octo', repo: 'two', ref: 'dev' });
    // Opening the root of `one` again keeps its last file and moves it up.
    const response = await touch({
      provider: 'github',
      owner: 'octo',
      repo: 'one',
    });
    expect(response.statusCode).toBe(200);
    expect(
      response
        .json()
        .map((p: { repo: string; ref: string; path: string }) => [
          p.repo,
          p.ref,
          p.path,
        ])
    ).toEqual([
      ['one', 'main', 'a.ts'],
      ['two', 'dev', null],
    ]);

    // The root of the same branch keeps the file.
    const sameBranch = await touch({
      provider: 'github',
      owner: 'octo',
      repo: 'one',
      ref: 'main',
    });
    expect(sameBranch.json()[0]).toMatchObject({ ref: 'main', path: 'a.ts' });

    // Switching the branch forgets the file of the old branch.
    const switched = await touch({
      provider: 'github',
      owner: 'octo',
      repo: 'one',
      ref: 'next',
    });
    expect(switched.json()[0]).toMatchObject({ ref: 'next', path: null });

    const invalid = await touch({
      provider: 'github',
      owner: '../x',
      repo: 'y',
    });
    expect(invalid.statusCode).toBe(400);

    const removed = await app.inject({
      method: 'DELETE',
      url: '/api/recent/github/octo/two',
      headers: { cookie },
    });
    expect(removed.statusCode).toBe(204);
    const list = await app.inject({
      method: 'GET',
      url: '/api/recent',
      headers: { cookie },
    });
    expect(list.json().map((p: { repo: string }) => p.repo)).toEqual(['one']);
  });

  it('keeps only the newest recent repositories', async () => {
    for (let i = 0; i < 25; i++) {
      await app.inject({
        method: 'POST',
        url: '/api/recent',
        headers: { cookie },
        payload: { provider: 'github', owner: 'bulk', repo: `r${i}` },
      });
    }

    const list = await app.inject({
      method: 'GET',
      url: '/api/recent',
      headers: { cookie },
    });
    const repos = list.json().map((p: { repo: string }) => p.repo);
    expect(repos).toHaveLength(20);
    expect(repos[0]).toBe('r24');
  });

  it('logs out', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(204);
    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie },
    });
    expect(me.statusCode).toBe(401);
  });
});
