<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useSessionStore } from '../stores/session';

const session = useSessionStore();
const router = useRouter();
const route = useRoute();
const token = ref('');
const busy = ref(false);
const error = ref<string | null>(null);

async function submit(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    await session.login('github', token.value);
    token.value = '';
    const redirect =
      typeof route.query.redirect === 'string'
        ? route.query.redirect
        : '/repos';
    await router.replace(redirect.startsWith('/') ? redirect : '/repos');
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="mx-auto flex max-w-md flex-col gap-6 px-4 py-12 sm:py-20">
    <div>
      <h1 class="text-2xl font-semibold">Sign in</h1>
      <p class="mt-2 text-sm text-zinc-400">
        Connect a GitHub account with a personal access token to browse and
        visualize your repositories.
      </p>
    </div>

    <form class="card flex flex-col gap-4 p-5" @submit.prevent="submit">
      <label class="flex flex-col gap-1.5 text-sm">
        <span class="font-medium text-zinc-200">GitHub token</span>
        <input
          v-model="token"
          class="input font-mono"
          type="password"
          autocomplete="off"
          placeholder="github_pat_… or ghp_…"
          required
        />
      </label>
      <p class="text-xs leading-relaxed text-zinc-500">
        Create a
        <a
          class="text-amber-400 hover:underline"
          href="https://github.com/settings/personal-access-tokens/new"
          target="_blank"
          rel="noopener noreferrer"
          >fine-grained token</a
        >
        with read access to <em>Contents</em> and <em>Metadata</em>. The token
        is stored encrypted on the server and only used to talk to GitHub on
        your behalf.
      </p>
      <p
        v-if="error"
        class="rounded-md border border-red-900 bg-red-950/60 px-3 py-2 text-sm text-red-200"
      >
        {{ error }}
      </p>
      <button
        class="btn-primary justify-center py-2"
        type="submit"
        :disabled="busy || token.length < 10"
      >
        <span v-if="busy" class="i-mdi-loading animate-spin" />
        Continue with GitHub token
      </button>
    </form>

    <p class="text-center text-sm text-zinc-500">
      Just looking?
      <RouterLink to="/playground" class="text-amber-400 hover:underline"
        >Open the playground</RouterLink
      >
    </p>
  </div>
</template>
