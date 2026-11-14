<script setup lang="ts">
import { RouterLink, useRoute } from 'vue-router';
import { useSessionStore } from '../stores/session';

const props = defineProps<{
  /**
   * Layout changes go to the shared layout (`true`), stay in this browser
   * (`false`), or no file is open (`null`).
   */
  shared: boolean | null;
}>();

const session = useSessionStore();
const route = useRoute();

const SIGNED_OUT_TITLE = [
  "Signed out: public repositories only, with GitHub's limit for signed-out use (see the status bar).",
  'Your node moves, recent repositories and unsaved changes are kept in this browser only.',
  'Sign in to share layouts on repositories you can push to.',
].join('\n');
</script>

<template>
  <span
    v-if="!session.me"
    data-ui="repo-access-hint"
    class="flex shrink-0 items-center gap-1.5 text-xs"
  >
    <span
      class="flex items-center gap-1 rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-400"
      :title="SIGNED_OUT_TITLE"
    >
      <span class="i-mdi-account-off-outline" />
      <span class="hidden lg:inline">Signed out</span>
    </span>
    <RouterLink
      :to="{ name: 'login', query: { redirect: route.fullPath } }"
      class="text-sky-300 hover:underline"
      >Sign in</RouterLink
    >
  </span>
  <span
    v-else-if="props.shared === false"
    data-ui="repo-access-hint"
    class="flex shrink-0 items-center gap-1 rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-400"
    title="You can't push to this repository, so your node moves are kept in this browser and not shared with others."
  >
    <span class="i-mdi-monitor" />
    <span class="hidden lg:inline">Layout in this browser</span>
  </span>
</template>
