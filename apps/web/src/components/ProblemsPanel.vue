<script setup lang="ts">
import { computed } from 'vue';
import type { Problem } from '../graph/problems';
import { SEVERITY_ORDER } from '../graph/problems';

const props = defineProps<{
  problems: ReadonlyArray<Problem>;
  path: string;
}>();

const emit = defineEmits<{
  /** Show the problem in the code and its node in the graph. */
  select: [problem: Problem];
}>();

const sorted = computed(() =>
  props.problems.toSorted(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.line - b.line ||
      a.column - b.column
  )
);

const ICONS: Record<Problem['severity'], string> = {
  error: 'i-mdi-close-circle text-red-400',
  warning: 'i-mdi-alert text-amber-400',
  info: 'i-mdi-information text-sky-400',
};

const fileName = computed(() => props.path.split('/').at(-1) ?? props.path);
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-zinc-950 text-sm">
    <div
      v-if="sorted.length === 0"
      class="px-4 py-3 text-xs text-zinc-500"
      role="status"
    >
      No problems have been detected in {{ fileName }}.
    </div>
    <ul
      v-else
      class="min-h-0 flex-1 overflow-y-auto py-1"
      aria-label="Problems"
    >
      <li v-for="(problem, i) in sorted" :key="i">
        <button
          type="button"
          class="flex w-full items-start gap-2 px-3 py-1 text-left hover:bg-zinc-800/70 focus-visible:bg-zinc-800/70 focus-visible:outline-none"
          @click="emit('select', problem)"
        >
          <span
            class="mt-0.5 shrink-0"
            :class="ICONS[problem.severity]"
            :aria-label="problem.severity"
          />
          <span class="min-w-0 flex-1 whitespace-pre-wrap text-zinc-200">{{
            problem.message
          }}</span>
          <span class="shrink-0 font-mono text-xs text-zinc-500">
            <template v-if="problem.source"
              >{{ problem.source
              }}<template v-if="problem.code">({{ problem.code }})</template>
            </template>
            [Ln {{ problem.line }}, Col {{ problem.column }}]
          </span>
        </button>
      </li>
    </ul>
  </div>
</template>
