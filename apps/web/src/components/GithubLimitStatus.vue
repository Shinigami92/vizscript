<script setup lang="ts">
import { useDocumentVisibility, useIntervalFn } from '@vueuse/core';
import { computed, watch } from 'vue';
import { githubLimit, refreshGithubLimit } from '../api/github-public';

/** How often the limit is asked for while the page is visible. */
const POLL_MS = 60_000;

const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
});

const visibility = useDocumentVisibility();

// Requests update the limit too; polling catches other tabs and the reset.
void refreshGithubLimit();
useIntervalFn(() => {
  if (visibility.value === 'visible') {
    void refreshGithubLimit();
  }
}, POLL_MS);
watch(visibility, (value) => {
  if (value === 'visible') {
    void refreshGithubLimit();
  }
});

const limit = computed(() => {
  const value = githubLimit.value;
  if (!value) {
    return null;
  }

  return {
    ...value,
    tone:
      value.remaining === 0
        ? 'text-red-300'
        : value.remaining < 10
          ? 'text-amber-300'
          : '',
    title: [
      `GitHub requests left without signing in: ${value.remaining} of ${value.limit} (resets at ${timeFormat.format(value.reset)}).`,
      'They are counted per IP address. Opening a repository or branch uses them; files and this count do not.',
      'Sign in for 5,000 per hour.',
    ].join('\n'),
  };
});
</script>

<template>
  <Teleport defer to="#workbench-status-end">
    <span
      v-if="limit"
      data-ui="status-github-limit"
      class="flex items-center gap-1 px-1.5 tabular-nums"
      :class="limit.tone"
      role="status"
      :title="limit.title"
      :aria-label="`${limit.remaining} of ${limit.limit} GitHub requests left`"
    >
      <span class="i-mdi-github" />{{ limit.remaining }}/{{ limit.limit }}
    </span>
  </Teleport>
</template>
