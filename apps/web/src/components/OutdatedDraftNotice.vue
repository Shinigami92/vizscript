<script setup lang="ts">
/**
 * Unsaved edits made on an older version of the open file (it changed
 * since): offered next to the file name instead of being dropped.
 */
defineEmits<{
  restore: [];
  discard: [];
}>();
</script>

<template>
  <span
    class="flex shrink-0 items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-300"
    data-ui="outdated-draft"
    title="You have unsaved edits from an older version of this file. Restore them on top of the current version, or discard them."
  >
    <span class="i-mdi-history shrink-0" />
    <span class="hidden truncate lg:inline">Older unsaved edits</span>
    <button
      type="button"
      class="rounded px-1 hover:bg-amber-500/20"
      @click="$emit('restore')"
    >
      Restore
    </button>
    <button
      type="button"
      class="rounded px-1 hover:bg-amber-500/20"
      @click="$emit('discard')"
    >
      Discard
    </button>
  </span>
</template>
