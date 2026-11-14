<script setup lang="ts">
import type { ProviderId } from '@vizscript/api-contract';
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { repoSource } from '../api/repo-source';
import { useSessionStore } from '../stores/session';

const route = useRoute();
const router = useRouter();
const session = useSessionStore();
const error = ref<string | null>(null);

// Resolves the default branch, then redirects to the repository view.
onMounted(async () => {
  const provider = String(route.params.provider) as ProviderId;
  const owner = String(route.params.owner);
  const repo = String(route.params.repo);
  try {
    const info = await repoSource(provider, session.me !== null).getRepo(
      owner,
      repo
    );
    await router.replace({
      name: 'repo',
      params: {
        provider,
        owner: info.owner,
        repo: info.name,
        ref: info.defaultBranch,
        path: [],
      },
    });
  } catch (e) {
    error.value = (e as Error).message;
  }
});
</script>

<template>
  <div
    data-ui="repo-root-page"
    class="flex h-full items-center justify-center text-sm text-zinc-400"
  >
    <span v-if="error" class="text-red-300">{{ error }}</span>
    <span v-else
      ><span class="i-mdi-loading animate-spin" /> Opening repository…</span
    >
  </div>
</template>
