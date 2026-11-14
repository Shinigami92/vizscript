import type { ProviderId } from '@vizscript/api-contract';
import type { Point, Positions } from '@vizscript/core';
import { api } from '../api/client';

/**
 * Where node positions of a file are persisted. The workspace only talks to
 * this interface, so repos (API), the playground (localStorage) and future
 * sources (local folders) can store layouts differently.
 */
export interface LayoutStore {
  load(): Promise<Positions>;
  save(patch: Record<string, Point | null>): Promise<void>;
}

/**
 * Layout of a repository file. Everyone who can read the repository sees the
 * shared layout stored on the server. Users with write access change it;
 * everyone else (also signed-out visitors) keeps their moves in this browser,
 * on top of the shared layout. `onAccess` reports which of both applies.
 */
export function repoLayoutStore(
  provider: ProviderId,
  owner: string,
  repo: string,
  ref: string,
  path: string,
  onAccess?: (canWrite: boolean) => void
): LayoutStore {
  const local = localLayoutStore(`${provider}/${owner}/${repo}@${ref}:${path}`);
  let canWrite = false;
  return {
    load: async () => {
      let shared: Positions = {};
      try {
        const layout = await api.getLayout(provider, owner, repo, ref, path);
        shared = layout.positions;
        canWrite = layout.canWrite;
      } catch {
        // no shared layout (server unreachable): this browser's layout only
        canWrite = false;
      }

      onAccess?.(canWrite);
      return canWrite ? shared : { ...shared, ...(await local.load()) };
    },
    save: async (patch) => {
      await (canWrite
        ? api.saveLayout(provider, owner, repo, ref, path, {
            positions: patch,
          })
        : local.save(patch));
    },
  };
}

export function localLayoutStore(key: string): LayoutStore {
  const storageKey = `vizscript:layout:${key}`;
  const read = (): Positions => {
    try {
      return JSON.parse(localStorage.getItem(storageKey) ?? '{}') as Positions;
    } catch {
      return {};
    }
  };

  return {
    load: async () => read(),
    save: async (patch) => {
      const current = read();
      for (const [id, value] of Object.entries(patch)) {
        if (value) {
          current[id] = value;
        } else {
          delete current[id];
        }
      }

      try {
        localStorage.setItem(storageKey, JSON.stringify(current));
      } catch {
        // storage full or unavailable; layout stays in memory
      }
    },
  };
}
