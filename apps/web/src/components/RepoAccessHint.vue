<script setup lang="ts">
import { useSessionStore } from '../stores/session';

defineProps<{
  /**
   * Layout changes go to the shared layout (`true`), stay in this browser
   * (`false`), or no file is open (`null`).
   */
  shared: boolean | null;
}>();

const session = useSessionStore();
</script>

<template>
  <!-- Signed out, the header's Sign in button explains what's kept where. -->
  <span
    v-if="session.me && shared === false"
    data-ui="repo-access-hint"
    class="flex shrink-0 items-center gap-1 rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-400"
    title="You can't push to this repository, so your node moves are kept in this browser and not shared with others."
  >
    <span class="i-mdi-monitor" />
    <span class="hidden lg:inline">Layout in this browser</span>
  </span>
</template>
