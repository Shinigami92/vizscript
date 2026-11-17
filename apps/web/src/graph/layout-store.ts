import type { ProviderId } from '@vizscript/api-contract';
import type { Point, Positions } from '@vizscript/core';
import { api, ApiError } from '../api/client';
import { useToasts } from '../composables/use-toasts';
import {
  readStored,
  removeStored,
  writeStored,
} from '../storage/browser-storage';

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
 *
 * While the server can't be reached, moves are kept as pending and sent
 * with the next load that works, so they aren't saved in the browser only
 * and then hidden by the shared layout. An expired session is told by the
 * API client; its moves stay in this browser.
 */
export function repoLayoutStore(
  provider: ProviderId,
  owner: string,
  repo: string,
  ref: string,
  path: string,
  onAccess?: (canWrite: boolean) => void
): LayoutStore {
  const scope = `${provider}/${owner}/${repo}@${ref}:${path}`;
  const local = localLayoutStore(scope);
  const pending = localLayoutStore(`pending/${scope}`);
  let mode: 'shared' | 'local' | 'offline' = 'local';

  async function sendPending(): Promise<Positions> {
    const moves = await pending.load();
    if (Object.keys(moves).length === 0) {
      return moves;
    }

    if (mode === 'shared') {
      try {
        await api.saveLayout(provider, owner, repo, ref, path, {
          positions: moves,
        });
        await pending.clear();
      } catch {
        // still unreachable: they wait for the next load
      }
    } else {
      // No write access (anymore): they are this browser's moves.
      await local.save(moves);
      await pending.clear();
    }

    return moves;
  }

  return {
    load: async () => {
      let shared: Positions = {};
      try {
        const layout = await api.getLayout(provider, owner, repo, ref, path);
        shared = layout.positions;
        mode = layout.canWrite ? 'shared' : 'local';
      } catch (error) {
        // Signed out or expired: this browser's layout. Unreachable: the
        // moves wait to be sent.
        mode = isUnreachable(error) ? 'offline' : 'local';
        if (mode === 'offline') {
          reportOffline();
        }
      }

      onAccess?.(mode === 'shared');
      const sent =
        mode === 'offline' ? await pending.load() : await sendPending();
      return mode === 'shared'
        ? { ...shared, ...sent }
        : { ...shared, ...(await local.load()), ...sent };
    },
    save: async (patch) => {
      if (mode === 'local') {
        await local.save(patch);
        return;
      }

      if (mode === 'offline') {
        await pending.save(patch);
        return;
      }

      try {
        await api.saveLayout(provider, owner, repo, ref, path, {
          positions: patch,
        });
      } catch (error) {
        if (isUnreachable(error)) {
          mode = 'offline';
          reportOffline();
          await pending.save(patch);
        } else {
          // Lost access or the session: keep the moves in this browser.
          mode = 'local';
          await local.save(patch);
        }
      }
    },
  };
}

/** No answer, or the server failed (not: no access, signed out). */
function isUnreachable(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status >= 500;
}

let toldOffline = false;

function reportOffline(): void {
  if (!toldOffline) {
    toldOffline = true;
    useToasts().show(
      'The server cannot be reached: node moves are kept in this browser and saved once it is back.'
    );
  }
}

function isPositions(data: unknown): Positions | null {
  return typeof data === 'object' && data !== null && !Array.isArray(data)
    ? (data as Positions)
    : null;
}

export function localLayoutStore(
  key: string
): LayoutStore & { clear: () => Promise<void> } {
  const storageKey = `vizscript:layout:${key}`;
  const read = (): Positions => readStored(storageKey, isPositions) ?? {};

  return {
    load: async () => read(),
    clear: async () => removeStored(storageKey),
    save: async (patch) => {
      const current = read();
      for (const [id, value] of Object.entries(patch)) {
        if (value) {
          current[id] = value;
        } else {
          delete current[id];
        }
      }

      // A full storage is reported; the layout stays in memory.
      writeStored(storageKey, current);
    },
  };
}
