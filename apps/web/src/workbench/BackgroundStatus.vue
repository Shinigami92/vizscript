<script setup lang="ts">
import { useSlowTasks } from '../composables/use-background-tasks';

/** What is still loading, once it takes longer than two seconds. */
const slow = useSlowTasks();
</script>

<template>
  <span
    v-if="slow.length > 0"
    data-ui="status-loading"
    class="flex min-w-0 items-center gap-1 px-1.5 text-zinc-400"
    role="status"
    :title="slow.join('\n')"
  >
    <span class="i-mdi-loading shrink-0 animate-spin" />
    <span class="truncate"
      >{{ slow[0] }}…<template v-if="slow.length > 1">
        (+{{ slow.length - 1 }})</template
      ></span
    >
  </span>
</template>
