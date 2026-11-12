<script setup lang="ts">
import { computed, ref } from 'vue';
import { shortcut } from '../../graph/source';
import { useWorkbenchStore } from '../../stores/workbench';
import type { MenuEntry } from '../ContextMenu.vue';
import ContextMenu from '../ContextMenu.vue';
import ShareLink from '../ShareLink.vue';
import type { ViewMode } from './types';

const props = defineProps<{
  editable: boolean;
  canUndo: boolean;
  canRedo: boolean;
  graphVisible: boolean;
  visualizable: boolean;
  previewable: boolean;
  mode: ViewMode | null;
  hideShare?: boolean;
}>();

const emit = defineEmits<{
  undo: [];
  redo: [];
  find: [];
  selectAll: [];
  frameSelection: [];
  frameAll: [];
  /** Forget the saved positions of the whole file. */
  resetLayout: [];
}>();

const workbench = useWorkbenchStore();
const isMobile = computed(() => workbench.isMobile);

const actionsMenu = ref<{ x: number; y: number } | null>(null);

function toggleActions(event: MouseEvent): void {
  if (actionsMenu.value) {
    actionsMenu.value = null;
    return;
  }

  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  actionsMenu.value = { x: rect.right - 224, y: rect.bottom + 4 };
}

const actionEntries = computed<MenuEntry[]>(() => {
  const graph = props.graphVisible;
  return [
    {
      label: 'Undo',
      icon: 'i-mdi-undo',
      shortcut: shortcut('Z'),
      disabled: !props.canUndo,
      action: () => emit('undo'),
    },
    {
      label: 'Redo',
      icon: 'i-mdi-redo',
      shortcut: shortcut('Z', true),
      disabled: !props.canRedo,
      action: () => emit('redo'),
    },
    ...(graph
      ? ([
          { type: 'separator' },
          {
            label: 'Find in graph…',
            icon: 'i-mdi-magnify',
            shortcut: shortcut('F'),
            action: () => emit('find'),
          },
          {
            label: 'Select all',
            icon: 'i-mdi-select-all',
            shortcut: shortcut('A'),
            action: () => emit('selectAll'),
          },
          {
            label: 'Zoom to selection',
            icon: 'i-mdi-image-filter-center-focus',
            shortcut: 'F',
            action: () => emit('frameSelection'),
          },
          {
            label: 'Zoom to fit all',
            icon: 'i-mdi-fit-to-screen-outline',
            shortcut: 'Home',
            action: () => emit('frameAll'),
          },
          { type: 'separator' },
          {
            label: workbench.isVisible('details')
              ? 'Hide details panel'
              : 'Show details panel',
            icon: 'i-mdi-dock-right',
            action: () => workbench.toggle('details'),
          },
          {
            label: 'Reset layout of file',
            icon: 'i-mdi-auto-fix',
            danger: true,
            action: () => emit('resetLayout'),
          },
        ] satisfies MenuEntry[])
      : []),
  ];
});
</script>

<template>
  <!-- File actions sit right of the editor tabs, like VS Code's. -->
  <Teleport :key="String(isMobile)" defer to="#workbench-editor-actions">
    <div data-ui="editor-actions-content" class="flex items-center gap-1 px-1">
      <div
        v-if="editable"
        class="flex items-center"
        role="group"
        aria-label="History"
      >
        <button
          type="button"
          class="btn-ghost px-1.5 py-1"
          :title="`Undo (${shortcut('Z')})`"
          aria-label="Undo"
          :disabled="!canUndo"
          @click="emit('undo')"
        >
          <span class="i-mdi-undo" />
        </button>
        <button
          type="button"
          class="btn-ghost px-1.5 py-1"
          :title="`Redo (${shortcut('Z', true)})`"
          aria-label="Redo"
          :disabled="!canRedo"
          @click="emit('redo')"
        >
          <span class="i-mdi-redo" />
        </button>
      </div>
      <button
        v-if="graphVisible"
        type="button"
        class="btn-ghost px-1.5 py-1"
        :title="`Find in graph (${shortcut('F')})`"
        aria-label="Find in graph"
        @click="emit('find')"
      >
        <span class="i-mdi-magnify" />
      </button>
      <div
        v-if="visualizable || previewable"
        class="flex rounded-md border border-zinc-800 p-0.5 text-xs"
        role="tablist"
        aria-label="Code and graph"
      >
        <button
          v-for="option in (isMobile
            ? ['code', 'viz']
            : ['code', 'split', 'viz']) as ViewMode[]"
          :key="option"
          type="button"
          role="tab"
          class="rounded px-2 py-0.5 capitalize"
          :class="
            mode === option
              ? 'bg-zinc-700 text-zinc-50'
              : 'text-zinc-400 hover:text-zinc-200'
          "
          :aria-selected="mode === option"
          @click="workbench.setCodeGraph(option)"
        >
          {{ option === 'viz' && previewable ? 'preview' : option }}
        </button>
      </div>
      <ShareLink v-if="!hideShare" />
      <button
        type="button"
        class="btn-ghost actions-toggle px-1.5 py-1"
        title="More actions"
        aria-label="More actions"
        aria-haspopup="menu"
        :aria-expanded="actionsMenu !== null"
        @click="toggleActions"
      >
        <span class="i-mdi-dots-horizontal" />
      </button>
      <ContextMenu
        v-if="actionsMenu"
        :x="actionsMenu.x"
        :y="actionsMenu.y"
        :entries="actionEntries"
        :ignore="['.actions-toggle']"
        label="Actions"
        @close="actionsMenu = null"
      />
    </div>
  </Teleport>
</template>
