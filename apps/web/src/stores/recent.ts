import type {
  RecentProject,
  RecentProjectRequest,
} from '@vizscript/api-contract';
import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import type { RouteLocationRaw } from 'vue-router';
import { api } from '../api/client';
import { useSessionStore } from './session';

/** Where a recent project reopens: its last file, branch or the repository. */
export function recentLocation(project: RecentProject): RouteLocationRaw {
  if (!project.ref) {
    return {
      name: 'repo-root',
      params: {
        provider: project.provider,
        owner: project.owner,
        repo: project.repo,
      },
    };
  }

  return {
    name: 'repo',
    params: {
      provider: project.provider,
      owner: project.owner,
      repo: project.repo,
      ref: project.ref,
      path: project.path ? project.path.split('/') : [],
    },
  };
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

/** "5 minutes ago", "yesterday", … */
export function timeAgo(iso: string, now = Date.now()): string {
  const seconds = (new Date(iso).getTime() - now) / 1000;
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) {
      return relative.format(Math.round(seconds / size), unit);
    }
  }

  return 'just now';
}

const LOCAL_KEY = 'vizscript:recent';
const LOCAL_LIMIT = 20;

function sameRepo(a: RecentProjectRequest, b: RecentProjectRequest): boolean {
  return (
    a.provider === b.provider &&
    a.owner.toLowerCase() === b.owner.toLowerCase() &&
    a.repo.toLowerCase() === b.repo.toLowerCase()
  );
}

function readLocal(): RecentProject[] {
  try {
    const value = JSON.parse(
      localStorage.getItem(LOCAL_KEY) ?? '[]'
    ) as unknown;
    return Array.isArray(value) ? (value as RecentProject[]) : [];
  } catch {
    return [];
  }
}

function writeLocal(projects: RecentProject[]): void {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(projects));
  } catch {
    // storage unavailable: the list stays in memory
  }
}

/**
 * Moves a repository to the top, like the server does: a new file wins, the
 * repository root of the same branch keeps the last file, and another branch
 * forgets it.
 */
function touchLocal(
  projects: ReadonlyArray<RecentProject>,
  request: RecentProjectRequest
): RecentProject[] {
  const previous = projects.find((p) => sameRepo(p, request));
  const branch = request.ref ?? previous?.ref ?? null;
  const keepsPath =
    previous !== undefined &&
    (request.ref === undefined ||
      request.ref === null ||
      request.ref === previous.ref);
  const path = request.path ?? (keepsPath ? previous.path : null);

  const next: RecentProject = {
    provider: request.provider,
    owner: request.owner,
    repo: request.repo,
    ref: branch,
    path,
    openedAt: new Date().toISOString(),
  };
  return [next, ...projects.filter((p) => !sameRepo(p, request))].slice(
    0,
    LOCAL_LIMIT
  );
}

/**
 * Recently opened repositories: stored on the server for signed-in users,
 * in this browser for signed-out visitors.
 */
export const useRecentStore = defineStore('recent', () => {
  const session = useSessionStore();
  const projects = ref<RecentProject[]>([]);
  const loaded = ref(false);

  async function load(): Promise<void> {
    if (!session.me) {
      projects.value = readLocal();
      loaded.value = true;
      return;
    }

    try {
      projects.value = await api.listRecent();
    } catch {
      // the list is a convenience: keep what we have
    } finally {
      loaded.value = true;
    }
  }

  async function touch(project: RecentProjectRequest): Promise<void> {
    if (!session.me) {
      projects.value = touchLocal(readLocal(), project);
      writeLocal(projects.value);
      return;
    }

    try {
      projects.value = await api.touchRecent(project);
    } catch {
      // not worth bothering the user
    }
  }

  async function remove(project: RecentProject): Promise<void> {
    projects.value = projects.value.filter((p) => p !== project);
    if (!session.me) {
      writeLocal(projects.value);
      return;
    }

    try {
      await api.removeRecent(project.provider, project.owner, project.repo);
    } catch {
      await load();
    }
  }

  watch(
    () => session.me?.id,
    () => void load(),
    { immediate: true }
  );

  return { projects, loaded, load, touch, remove };
});
