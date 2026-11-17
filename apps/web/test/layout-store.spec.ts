import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ClientModule from '../src/api/client';
import { ApiError } from '../src/api/client';
import { repoLayoutStore } from '../src/graph/layout-store';

const server = vi.hoisted(() => ({
  reachable: true,
  canWrite: true,
  positions: {} as Record<string, { x: number; y: number }>,
  saved: [] as Array<Record<string, unknown>>,
}));

vi.mock('../src/api/client', async (original) => {
  const actual = await original<typeof ClientModule>();
  return {
    ...actual,
    api: {
      getLayout: () =>
        server.reachable
          ? Promise.resolve({
              positions: server.positions,
              canWrite: server.canWrite,
            })
          : Promise.reject(new TypeError('Failed to fetch')),
      saveLayout: (...args: unknown[]) => {
        if (!server.reachable) {
          return Promise.reject(new TypeError('Failed to fetch'));
        }

        const body = args[5] as { positions: Record<string, unknown> };
        server.saved.push(body.positions);
        return Promise.resolve();
      },
    },
  };
});

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    key: (index) => [...data.keys()][index] ?? null,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

const store = () => repoLayoutStore('github', 'octo', 'demo', 'main', 'a.ts');

describe('repository layout store', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
    Object.assign(server, {
      reachable: true,
      canWrite: true,
      positions: {},
      saved: [],
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('keeps moves while the server is unreachable and sends them later', async () => {
    server.reachable = false;
    const offline = store();
    expect(await offline.load()).toEqual({});
    await offline.save({ n1: { x: 10, y: 20 } });
    expect(server.saved).toEqual([]);

    // Back: the next load sends them and shows them.
    server.reachable = true;
    server.positions = { n2: { x: 1, y: 1 } };
    expect(await store().load()).toEqual({
      n2: { x: 1, y: 1 },
      n1: { x: 10, y: 20 },
    });
    expect(server.saved).toEqual([{ n1: { x: 10, y: 20 } }]);
    // Sent once.
    await store().load();
    expect(server.saved).toHaveLength(1);
  });

  it('keeps moves of someone without write access in the browser', async () => {
    server.reachable = false;
    const offline = store();
    await offline.load();
    await offline.save({ n1: { x: 5, y: 5 } });

    server.reachable = true;
    server.canWrite = false;
    expect(await store().load()).toEqual({ n1: { x: 5, y: 5 } });
    expect(server.saved).toEqual([]);
  });

  it('treats a lost session as this browser only', async () => {
    const shared = store();
    await shared.load();
    server.reachable = true;
    const { api } = await import('../src/api/client');
    vi.spyOn(api, 'saveLayout').mockRejectedValueOnce(
      new ApiError(401, 'Your session has expired', 'session_expired')
    );
    await shared.save({ n1: { x: 3, y: 3 } });
    expect(server.saved).toEqual([]);
    server.canWrite = false;
    expect(await store().load()).toEqual({ n1: { x: 3, y: 3 } });
  });
});
