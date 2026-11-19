<script setup lang="ts">
import { useSlowTasks } from '../../composables/use-background-tasks';
import { shortcut } from '../../graph/source';
import { useWorkbenchStore } from '../../stores/workbench';

defineProps<{
  problemCounts: { errors: number; warnings: number };
  /** State of saving the layout; `null` without a layout store. */
  saving: 'idle' | 'saving' | 'saved' | 'error' | null;
  /** The graph has edits the code doesn't have yet. */
  outOfSync?: boolean;
  /** Imports and library types are still read: the counts may change. */
  checking?: boolean;
}>();

const workbench = useWorkbenchStore();
/** The progress next to the problems says it already: one spinner. */
const slow = useSlowTasks();
</script>

<template>
  <!-- The status bar is rendered by the Workbench after this toolbar. -->
  <Teleport defer to="#workbench-status">
    <button
      data-ui="status-problems"
      type="button"
      class="flex h-full items-center gap-1 rounded-sm px-1.5 hover:bg-zinc-800 hover:text-zinc-100"
      :class="
        checking
          ? 'text-zinc-500'
          : problemCounts.errors > 0
            ? 'text-red-300'
            : problemCounts.warnings > 0
              ? 'text-amber-300'
              : ''
      "
      :title="
        checking
          ? `Problems (${shortcut('M', true)}), still checking: imports and library types are loading`
          : `Problems (${shortcut('M', true)})`
      "
      :aria-busy="checking"
      :aria-label="`${problemCounts.errors} errors, ${problemCounts.warnings} warnings. Toggle problems`"
      :aria-pressed="workbench.isVisible('problems')"
      @click="workbench.toggle('problems')"
    >
      <span
        v-if="checking && slow.length === 0"
        data-ui="status-problems-checking"
        class="i-mdi-loading animate-spin"
      />
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
  </Teleport>
  <Teleport defer to="#workbench-status-right">
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
