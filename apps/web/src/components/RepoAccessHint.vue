<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { githubLimit } from '../api/github-public';
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

const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
});

const limit = computed(() => {
  const value = githubLimit.value;
  if (!value || value.reset < Date.now()) {
    return null;
  }

  return {
    ...value,
    low: value.remaining < 10,
    text: `${value.remaining} of ${value.limit} GitHub requests left until ${timeFormat.format(value.reset)}`,
  };
});

const signedOutTitle = computed(() =>
  [
    'Signed out: public repositories only.',
    limit.value
      ? `${limit.value.text}.`
      : 'GitHub allows 60 requests per hour without signing in.',
    'Your node moves, recent repositories and unsaved changes are kept in this browser only.',
    'Sign in to share layouts on repositories you can push to.',
  ].join('\n')
);
</script>

<template>
  <span
    v-if="!session.me"
    data-ui="repo-access-hint"
    class="flex shrink-0 items-center gap-1.5 text-xs"
  >
    <span
      class="flex items-center gap-1 rounded px-1.5 py-0.5"
      :class="
        limit?.low
          ? 'bg-amber-500/15 text-amber-300'
          : 'bg-zinc-800 text-zinc-400'
      "
      :title="signedOutTitle"
    >
      <span class="i-mdi-account-off-outline" />
      <span class="hidden lg:inline">Signed out</span>
      <span v-if="limit" class="tabular-nums"
        >· {{ limit.remaining }}/{{ limit.limit }}</span
      >
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
