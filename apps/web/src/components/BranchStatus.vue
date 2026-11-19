<script setup lang="ts">
import { computed, ref, useTemplateRef } from 'vue';
import type { ActionEntry } from './ActionMenu.vue';
import ActionMenu from './ActionMenu.vue';

const props = defineProps<{
  /** The branch (or tag, commit) shown. */
  current: string;
  branches: ReadonlyArray<{ name: string }>;
  /** Files with unsaved changes on the current branch. */
  unsaved: number;
}>();

const emit = defineEmits<{ switch: [ref: string] }>();

const button = useTemplateRef<HTMLButtonElement>('button');
const open = ref(false);
const at = ref({ x: 0, y: 0 });
/** The click that closed the picker (outside it) must not reopen it. */
let closedAt = 0;

function toggle(): void {
  if (open.value || performance.now() - closedAt < 300) {
    open.value = false;
    return;
  }

  const rect = button.value?.getBoundingClientRect();
  // Right above the status bar.
  const top = rect?.top ?? globalThis.innerHeight;
  at.value = { x: rect?.left ?? 0, y: top };
  open.value = true;
}

function close(): void {
  open.value = false;
  closedAt = performance.now();
}

const note = computed(() =>
  props.unsaved > 0
    ? `Unsaved changes of ${props.unsaved} file${props.unsaved === 1 ? '' : 's'} stay with ${props.current} as drafts.`
    : undefined
);

function choose(name: string): void {
  if (name !== props.current) {
    emit('switch', name);
  }
}

const entries = computed((): ActionEntry[] => {
  const listed = props.branches.some((b) => b.name === props.current)
    ? props.branches
    : [{ name: props.current }, ...props.branches];
  return listed.map((branch) => ({
    label: branch.name,
    category: 'Branches',
    icon:
      branch.name === props.current
        ? 'i-mdi-check text-amber-400'
        : 'i-mdi-source-branch text-zinc-500',
    ...(branch.name === props.current ? { hint: 'current' } : {}),
    ...(note.value ? { detail: note.value } : {}),
    action: () => choose(branch.name),
  }));
});

/** A tag or commit typed by hand opens like a branch. */
function suggest(query: string): ActionEntry[] {
  return /^[\w./-]+$/.test(query) &&
    !props.branches.some((b) => b.name === query)
    ? [
        {
          label: `Open ${query}`,
          category: 'Tag or commit',
          icon: 'i-mdi-tag-outline text-zinc-500',
          action: () => choose(query),
        },
      ]
    : [];
}
</script>

<template>
  <!-- VS Code's branch item: first in the status bar. -->
  <Teleport defer to="#workbench-status">
    <button
      ref="button"
      data-ui="status-branch"
      type="button"
      class="flex h-full min-w-0 items-center gap-1 rounded-sm px-1.5 hover:bg-zinc-800 hover:text-zinc-100"
      :title="`${current} — switch branch`"
      :aria-label="`Branch ${current}. Switch branch`"
      aria-haspopup="dialog"
      :aria-expanded="open"
      @click="toggle"
    >
      <span class="i-mdi-source-branch shrink-0" />
      <span class="max-w-48 truncate">{{ current }}</span>
    </button>
  </Teleport>
  <Teleport to="body">
    <ActionMenu
      v-if="open"
      :x="at.x"
      :y="at.y"
      :bottom="at.y"
      title="Switch branch"
      :entries="entries"
      :suggest="suggest"
      @close="close"
    />
  </Teleport>
</template>
