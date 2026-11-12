<script lang="ts">
export type MenuEntry =
  | {
      type?: 'item';
      label: string;
      icon?: string;
      /** Shortcut hint shown on the right, e.g. `Ctrl+Z`. */
      shortcut?: string;
      disabled?: boolean;
      danger?: boolean;
      action: () => void;
    }
  | { type: 'separator' }
  | { type: 'header'; label: string };
</script>

<script setup lang="ts">
import {
  onClickOutside,
  useElementBounding,
  useWindowSize,
} from '@vueuse/core';
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  useTemplateRef,
} from 'vue';

const props = defineProps<{
  x: number;
  y: number;
  entries: ReadonlyArray<MenuEntry>;
  /** Used for `aria-label`. */
  label?: string;
  /** Elements (selectors) whose clicks don't close the menu, e.g. its toggle. */
  ignore?: string[];
}>();

const emit = defineEmits<{ close: [] }>();

const menu = useTemplateRef<HTMLDivElement>('menu');
const { width, height } = useElementBounding(menu);
const viewport = useWindowSize();

// Keep the menu inside the viewport.
const position = computed(() => ({
  left: `${Math.max(4, Math.min(props.x, viewport.width.value - width.value - 4))}px`,
  top: `${Math.max(4, Math.min(props.y, viewport.height.value - height.value - 4))}px`,
}));

// A menu opened on pointer release (e.g. a dropped wire) would see the
// `click` of that same release as an outside click: arm after it.
let armed = false;
const arm = setTimeout(() => {
  armed = true;
}, 0);
onBeforeUnmount(() => clearTimeout(arm));
onClickOutside(
  menu,
  () => {
    if (armed) {
      emit('close');
    }
  },
  { ignore: props.ignore ?? [] }
);

function items(): HTMLButtonElement[] {
  return [
    ...(menu.value?.querySelectorAll<HTMLButtonElement>(
      'button:not(:disabled)'
    ) ?? []),
  ];
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    emit('close');
    return;
  }

  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
    return;
  }

  event.preventDefault();
  const list = items();
  const index = list.indexOf(document.activeElement as HTMLButtonElement);
  const next =
    event.key === 'ArrowDown'
      ? list[(index + 1) % list.length]
      : list[(index - 1 + list.length) % list.length];
  next?.focus();
}

function run(entry: MenuEntry): void {
  if (entry.type === 'separator' || entry.type === 'header') {
    return;
  }

  entry.action();
  emit('close');
}

onMounted(async () => {
  await nextTick();
  items()[0]?.focus({ preventScroll: true });
});
</script>

<template>
  <div
    ref="menu"
    data-ui="context-menu"
    role="menu"
    :aria-label="label"
    class="fixed z-40 min-w-56 max-w-80 rounded-lg border border-zinc-700 bg-zinc-900/98 p-1 text-sm shadow-2xl backdrop-blur"
    :style="position"
    @keydown="onKeydown"
    @contextmenu.prevent
  >
    <template v-for="(entry, i) in entries" :key="i">
      <div
        v-if="entry.type === 'separator'"
        class="my-1 h-px bg-zinc-800"
        role="separator"
      />
      <div
        v-else-if="entry.type === 'header'"
        class="truncate px-2 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500"
      >
        {{ entry.label }}
      </div>
      <button
        v-else
        type="button"
        role="menuitem"
        class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left outline-none disabled:cursor-not-allowed disabled:opacity-40"
        :class="
          entry.danger
            ? 'text-red-300 hover:bg-red-950/60 focus:bg-red-950/60'
            : 'text-zinc-200 hover:bg-zinc-800 focus:bg-zinc-800'
        "
        :disabled="entry.disabled"
        @click="run(entry)"
      >
        <span
          class="w-4 shrink-0 text-zinc-400"
          :class="entry.icon ?? ''"
          aria-hidden="true"
        />
        <span class="flex-1 truncate">{{ entry.label }}</span>
        <kbd
          v-if="entry.shortcut"
          class="font-sans text-[11px] text-zinc-500"
          >{{ entry.shortcut }}</kbd
        >
      </button>
    </template>
  </div>
</template>
