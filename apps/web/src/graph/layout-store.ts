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

export function apiLayoutStore(
  provider: ProviderId,
  owner: string,
  repo: string,
  ref: string,
  path: string
): LayoutStore {
  return {
    load: async () =>
      (await api.getLayout(provider, owner, repo, ref, path)).positions,
    save: async (patch) => {
      await api.saveLayout(provider, owner, repo, ref, path, {
        positions: patch,
      });
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
