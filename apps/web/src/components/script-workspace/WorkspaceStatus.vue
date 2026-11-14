<script setup lang="ts">
import { shortcut } from '../../graph/source';
import { useWorkbenchStore } from '../../stores/workbench';

defineProps<{
  problemCounts: { errors: number; warnings: number };
  /** State of saving the layout; `null` without a layout store. */
  saving: 'idle' | 'saving' | 'saved' | 'error' | null;
  /** The graph has edits the code doesn't have yet. */
  outOfSync?: boolean;
}>();

const workbench = useWorkbenchStore();
</script>

<template>
  <!-- The status bar is rendered by the Workbench after this toolbar. -->
  <Teleport defer to="#workbench-status">
    <button
      data-ui="status-problems"
      type="button"
      class="flex h-full items-center gap-1 rounded-sm px-1.5 hover:bg-zinc-800 hover:text-zinc-100"
      :class="
        problemCounts.errors > 0
          ? 'text-red-300'
          : problemCounts.warnings > 0
            ? 'text-amber-300'
            : ''
      "
      :title="`Problems (${shortcut('M', true)})`"
      :aria-label="`${problemCounts.errors} errors, ${problemCounts.warnings} warnings. Toggle problems`"
      :aria-pressed="workbench.isVisible('problems')"
      @click="workbench.toggle('problems')"
    >
      <span class="i-mdi-close-circle-outline" />{{ problemCounts.errors }}
      <span class="i-mdi-alert-outline ml-1" />{{ problemCounts.warnings }}
    </button>
    <span
      v-if="outOfSync"
      data-ui="status-graph-sync"
      class="flex items-center gap-1 px-1.5 text-amber-300"
      role="status"
      title="The graph has changes the code doesn't have yet; saving is blocked"
    >
      <span class="i-mdi-sync-alert" />
      Graph not in sync
    </span>
    <!-- Pushes the layout state and the language to the right. -->
    <span class="flex-1" aria-hidden="true" />
    <span
      v-if="saving && saving !== 'idle'"
      data-ui="status-layout"
      class="flex items-center gap-1 px-1.5"
      :class="saving === 'error' ? 'text-red-400' : ''"
      role="status"
    >
      <span
        :class="
          saving === 'saving'
            ? 'i-mdi-loading animate-spin'
            : saving === 'saved'
              ? 'i-mdi-check'
              : 'i-mdi-alert-circle-outline'
        "
      />
      {{
        saving === 'saving'
          ? 'Saving layout…'
          : saving === 'saved'
            ? 'Layout saved'
            : 'Layout not saved'
      }}
    </span>
  </Teleport>
</template>
