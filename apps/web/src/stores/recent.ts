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

/** Recently opened repositories of the signed-in user (stored on the server). */
export const useRecentStore = defineStore('recent', () => {
  const session = useSessionStore();
  const projects = ref<RecentProject[]>([]);
  const loaded = ref(false);

  async function load(): Promise<void> {
    if (!session.me) {
      projects.value = [];
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
