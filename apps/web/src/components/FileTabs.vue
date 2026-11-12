<script setup lang="ts">
import { computed, nextTick, ref, useTemplateRef, watch } from 'vue';
import type { FileTab } from '../composables/use-file-tabs';
import { fileIcon } from '../graph/languages';
import type { MenuEntry } from './ContextMenu.vue';
import ContextMenu from './ContextMenu.vue';

/**
 * Open files as tabs, like VS Code's editor tabs: italic preview tabs, a
 * dot for unsaved changes, middle-click or × to close, drag to reorder.
 */
const props = defineProps<{
  tabs: ReadonlyArray<FileTab>;
  active: string | null;
  /** Files with unsaved changes. */
  dirty: ReadonlySet<string>;
}>();

const emit = defineEmits<{
  select: [path: string];
  pin: [path: string];
  close: [path: string];
  closeOthers: [path: string];
  closeAll: [];
  move: [path: string, index: number];
}>();

const strip = useTemplateRef<HTMLDivElement>('strip');

function nameOf(path: string): string {
  return path.split('/').at(-1) ?? path;
}

/** Folder shown after names that are open more than once (`a/index.ts`). */
const hints = computed(() => {
  const counts = new Map<string, number>();
  for (const tab of props.tabs) {
    const name = nameOf(tab.path);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  return new Map(
    props.tabs.map((tab) => [
      tab.path,
      (counts.get(nameOf(tab.path)) ?? 0) > 1
        ? (tab.path.split('/').at(-2) ?? '')
        : '',
    ])
  );
});

// Keep the active tab in view.
watch(
  () => props.active,
  async (path) => {
    await nextTick();
    strip.value
      ?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(path ?? '')}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  },
  { immediate: true }
);

function onMouseDown(event: MouseEvent, path: string): void {
  // Middle click closes, like in browsers and VS Code.
  if (event.button === 1) {
    event.preventDefault();
    emit('close', path);
  }
}

const menu = ref<{ x: number; y: number; path: string } | null>(null);
const menuEntries = computed<MenuEntry[]>(() => {
  const path = menu.value?.path;
  if (!path) {
    return [];
  }

  const tab = props.tabs.find((t) => t.path === path);
  return [
    { type: 'header', label: nameOf(path) },
    ...(tab?.preview
      ? [
          {
            label: 'Keep open',
            icon: 'i-mdi-pin-outline',
            action: () => emit('pin', path),
          },
        ]
      : []),
    {
      label: 'Close',
      icon: 'i-mdi-close',
      action: () => emit('close', path),
    },
    {
      label: 'Close others',
      disabled: props.tabs.length < 2,
      action: () => emit('closeOthers', path),
    },
    { label: 'Close all', action: () => emit('closeAll') },
    { type: 'separator' },
    {
      label: 'Copy path',
      icon: 'i-mdi-content-copy',
      action: () => void navigator.clipboard?.writeText(path),
    },
  ];
});

// Drag to reorder.
const TAB_MIME = 'application/x-vizscript-tab';
const dropIndex = ref<number | null>(null);

function onDragStart(event: DragEvent, path: string): void {
  event.dataTransfer?.setData(TAB_MIME, path);
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
  }
}

function onDragOver(event: DragEvent, index: number): void {
  if (event.dataTransfer?.types.includes(TAB_MIME)) {
    event.preventDefault();
    const target = event.currentTarget as HTMLElement;
    const { left, width } = target.getBoundingClientRect();
    dropIndex.value = event.clientX < left + width / 2 ? index : index + 1;
  }
}

function onDrop(event: DragEvent): void {
  const path = event.dataTransfer?.getData(TAB_MIME);
  const index = dropIndex.value;
  dropIndex.value = null;
  if (!path || index === null) {
    return;
  }

  event.preventDefault();
  const from = props.tabs.findIndex((t) => t.path === path);
  emit('move', path, from < index ? index - 1 : index);
}
</script>

<template>
  <div
    v-if="tabs.length > 0"
    ref="strip"
    data-ui="file-tabs"
    class="flex h-9 shrink-0 overflow-x-auto overflow-y-hidden border-b border-zinc-800 bg-zinc-950 [scrollbar-width:thin]"
    role="tablist"
    aria-label="Open files"
    @dragleave="dropIndex = null"
    @drop="onDrop"
  >
    <div
      v-for="(tab, index) in tabs"
      :key="tab.path"
      :data-tab="tab.path"
      data-ui="file-tab"
      role="tab"
      draggable="true"
      :aria-selected="tab.path === active"
      class="group relative flex max-w-56 shrink-0 cursor-pointer items-center gap-1.5 border-r border-zinc-800 pr-1 pl-2.5 text-xs select-none"
      :class="[
        tab.path === active
          ? 'bg-zinc-900 text-zinc-100 shadow-[inset_0_-2px_0_var(--colors-amber-500)]'
          : 'text-zinc-400 hover:bg-zinc-900/60 hover:text-zinc-200',
        dropIndex === index
          ? 'shadow-[inset_2px_0_0_var(--colors-amber-500)]'
          : '',
        dropIndex === index + 1 && index === tabs.length - 1
          ? 'shadow-[inset_-2px_0_0_var(--colors-amber-500)]'
          : '',
      ]"
      :title="tab.path"
      tabindex="0"
      @click="emit('select', tab.path)"
      @dblclick="emit('pin', tab.path)"
      @mousedown="onMouseDown($event, tab.path)"
      @keydown.enter.prevent="emit('select', tab.path)"
      @keydown.delete.prevent="emit('close', tab.path)"
      @contextmenu.prevent="
        menu = { x: $event.clientX, y: $event.clientY, path: tab.path }
      "
      @dragstart="onDragStart($event, tab.path)"
      @dragover="onDragOver($event, index)"
    >
      <span class="shrink-0" :class="fileIcon(tab.path)" />
      <span class="truncate" :class="{ italic: tab.preview }">{{
        nameOf(tab.path)
      }}</span>
      <span
        v-if="hints.get(tab.path)"
        class="shrink-0 truncate text-[10px] text-zinc-500"
        >{{ hints.get(tab.path) }}</span
      >
      <button
        type="button"
        class="ml-0.5 flex size-5 shrink-0 items-center justify-center rounded hover:bg-zinc-700"
        :class="
          dirty.has(tab.path) || tab.path === active
            ? 'opacity-100'
            : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
        "
        :title="dirty.has(tab.path) ? 'Unsaved changes – close' : 'Close'"
        :aria-label="`Close ${nameOf(tab.path)}`"
        @click.stop="emit('close', tab.path)"
      >
        <span
          v-if="dirty.has(tab.path)"
          class="size-2 rounded-full bg-zinc-300 group-hover:hidden"
        />
        <span
          class="i-mdi-close text-sm"
          :class="{ 'hidden group-hover:inline-block': dirty.has(tab.path) }"
        />
      </button>
    </div>

    <ContextMenu
      v-if="menu"
      :x="menu.x"
      :y="menu.y"
      :entries="menuEntries"
      label="Tab actions"
      @close="menu = null"
    />
  </div>
</template>
