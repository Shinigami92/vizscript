<script setup lang="ts">
import type { RepoSummary } from '@vizscript/api-contract';
import { watchDebounced } from '@vueuse/core';
import { computed, onMounted, ref } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import { api } from '../api/client';
import { recentLocation, timeAgo, useRecentStore } from '../stores/recent';

const REPO_PATTERN = /^([\w.-]+)\/([\w.-]+)$/;

const recent = useRecentStore();
void recent.load();

function fileName(path: string): string {
  return path.split('/').at(-1) ?? path;
}

const router = useRouter();
const query = ref('');
const repos = ref<RepoSummary[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const direct = computed(() => query.value.trim().match(REPO_PATTERN));

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    repos.value = await api.listRepos('github', query.value.trim());
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watchDebounced(query, load, { debounce: 350 });

function open(repo: RepoSummary): void {
  void router.push({
    name: 'repo',
    params: {
      provider: 'github',
      owner: repo.owner,
      repo: repo.name,
      ref: repo.defaultBranch,
      path: [],
    },
  });
}

function openDirect(): void {
  const match = direct.value;
  if (match?.[1] && match[2]) {
    void router.push({
      name: 'repo-root',
      params: { provider: 'github', owner: match[1], repo: match[2] },
    });
  }
}
</script>

<template>
  <div class="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-8">
    <div>
      <h1 class="text-xl font-semibold">Repositories</h1>
      <p class="text-sm text-zinc-400">
        Pick a repository, or type
        <code class="text-zinc-300">owner/name</code> to open any public one.
      </p>
    </div>

    <section
      v-if="recent.projects.length > 0 && !query.trim()"
      aria-labelledby="recent-title"
    >
      <h2
        id="recent-title"
        class="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500"
      >
        <span class="i-mdi-history text-sm" /> Recently opened
      </h2>
      <ul class="grid gap-2 sm:grid-cols-2">
        <li
          v-for="project in recent.projects.slice(0, 8)"
          :key="`${project.provider}/${project.owner}/${project.repo}`"
          class="group relative"
        >
          <RouterLink
            :to="recentLocation(project)"
            class="card flex h-full flex-col gap-1 px-3 py-2.5 pr-9 hover:border-zinc-600 hover:bg-zinc-800/60 focus-visible:border-amber-500 focus-visible:outline-none"
          >
            <span class="truncate text-sm">
              <span class="text-zinc-400">{{ project.owner }}/</span
              ><span class="font-medium text-zinc-100">{{ project.repo }}</span>
            </span>
            <span
              class="flex min-w-0 items-center gap-1.5 text-xs text-zinc-500"
            >
              <template v-if="project.ref">
                <span class="i-mdi-source-branch shrink-0" />
                <span class="max-w-28 truncate">{{ project.ref }}</span>
              </template>
              <template v-if="project.path">
                <span class="i-mdi-file-outline ml-1 shrink-0" />
                <span
                  class="truncate font-mono text-zinc-400"
                  :title="project.path"
                  >{{ fileName(project.path) }}</span
                >
              </template>
              <span class="ml-auto shrink-0 pl-2" :title="project.openedAt">{{
                timeAgo(project.openedAt)
              }}</span>
            </span>
          </RouterLink>
          <button
            type="button"
            class="absolute right-1.5 top-1.5 rounded p-1 text-zinc-500 opacity-0 hover:bg-zinc-700 hover:text-zinc-100 focus:opacity-100 group-hover:opacity-100"
            :aria-label="`Remove ${project.owner}/${project.repo} from recent`"
            title="Remove from recent"
            @click="recent.remove(project)"
          >
            <span class="i-mdi-close block text-sm" />
          </button>
        </li>
      </ul>
    </section>

    <form class="flex gap-2" @submit.prevent="openDirect">
      <input
        v-model="query"
        class="input"
        type="search"
        placeholder="Search or owner/name…"
      />
      <button
        class="btn-ghost border border-zinc-700"
        type="submit"
        :disabled="!direct"
      >
        Open
      </button>
    </form>

    <p
      v-if="error"
      class="rounded-md border border-red-900 bg-red-950/60 px-3 py-2 text-sm text-red-200"
    >
      {{ error }}
    </p>

    <ul class="card divide-y divide-zinc-800">
      <li
        v-if="loading && repos.length === 0"
        class="px-4 py-6 text-center text-sm text-zinc-500"
      >
        <span class="i-mdi-loading animate-spin" /> Loading…
      </li>
      <li
        v-else-if="repos.length === 0"
        class="px-4 py-6 text-center text-sm text-zinc-500"
      >
        No repositories found
      </li>
      <li v-for="repo in repos" :key="repo.id">
        <button
          type="button"
          class="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-zinc-800/60"
          @click="open(repo)"
        >
          <span
            class="mt-0.5 shrink-0 text-zinc-500"
            :class="
              repo.private ? 'i-mdi-lock-outline' : 'i-mdi-source-repository'
            "
          />
          <span class="min-w-0 flex-1">
            <span class="block truncate font-medium text-zinc-100">{{
              repo.fullName
            }}</span>
            <span
              v-if="repo.description"
              class="block truncate text-sm text-zinc-400"
            >
              {{ repo.description }}
            </span>
          </span>
          <span class="shrink-0 text-xs text-zinc-500">{{
            repo.defaultBranch
          }}</span>
        </button>
      </li>
    </ul>
  </div>
</template>
