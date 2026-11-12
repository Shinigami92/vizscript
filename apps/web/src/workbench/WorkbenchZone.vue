<script setup lang="ts">
import type { ViewId, ZoneId } from '@vizscript/workbench';
import { VIEW_TITLES } from '@vizscript/workbench';
import { computed, inject, ref, useTemplateRef } from 'vue';
import { useWorkbenchStore } from '../stores/workbench';
import { DRAG_MIME, VIEW_ICONS, WORKBENCH } from './context';
import WorkbenchSash from './WorkbenchSash.vue';

const props = defineProps<{
  zone: ZoneId;
  /** Shown views of the zone, in order. */
  views: ReadonlyArray<ViewId>;
}>();

const ZONE_LABELS: Record<ZoneId, string> = {
  left: 'left sidebar',
  center: 'main area',
  right: 'right sidebar',
  bottom: 'bottom panel',
};

const context = inject(WORKBENCH);
const store = useWorkbenchStore();
const root = useTemplateRef<HTMLDivElement>('root');

const state = computed(() => store.layout.zones[props.zone]);
const split = computed(() => state.value.split && props.views.length > 1);
const active = computed(() =>
  state.value.active && props.views.includes(state.value.active)
    ? state.value.active
    : props.views[0]
);
/** Sidebars stack split views, the main area and panel put them in a row. */
const stacked = computed(() => props.zone === 'left' || props.zone === 'right');

// ------------------------------------------------------------ dragging

const dropHover = ref(false);

function onDragStart(event: DragEvent, view: ViewId): void {
  event.dataTransfer?.setData(DRAG_MIME, view);
  event.dataTransfer?.setData('text/plain', VIEW_TITLES[view]);
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
  }

  // Changing the DOM inside dragstart cancels the drag in Chrome.
  requestAnimationFrame(() => {
    store.dragging = view;
  });
}

function onDragEnd(): void {
  store.dragging = null;
  dropHover.value = false;
}

/** Insert position from the pointer, relative to the tabs / split cells. */
function dropIndex(event: DragEvent, dragged: ViewId): number {
  const items = [
    ...(root.value?.querySelectorAll<HTMLElement>('[data-view-tab]') ?? []),
  ].filter((item) => item.dataset.viewTab !== dragged);
  for (const [i, item] of items.entries()) {
    const rect = item.getBoundingClientRect();
    const before =
      split.value && stacked.value
        ? event.clientY < rect.top + rect.height / 2
        : event.clientX < rect.left + rect.width / 2;
    const inRow =
      split.value ||
      (event.clientY >= rect.top && event.clientY <= rect.bottom);
    if (inRow && before) {
      return i;
    }
  }

  return items.length;
}

function onDrop(event: DragEvent): void {
  dropHover.value = false;
  const view = store.dragging;
  store.dragging = null;
  if (!view) {
    return;
  }

  event.preventDefault();
  // Indices refer to shown views; translate to the full zone list.
  const index = dropIndex(event, view);
  const anchor = props.views.filter((v) => v !== view)[index];
  const all = state.value.views.filter((v) => v !== view);
  store.move(view, props.zone, anchor ? all.indexOf(anchor) : all.length);
}

// ------------------------------------------------------------ split sizes

let startWeights: [number, number] = [1, 1];
let startPixels = 1;

function weightOf(view: ViewId | undefined): number {
  return (view && state.value.weights[view]) || 1;
}

function startResize(index: number): void {
  const a = props.views[index];
  const b = props.views[index + 1];
  startWeights = [weightOf(a), weightOf(b)];
  const cells = root.value?.querySelectorAll<HTMLElement>('[data-cell]');
  const first = cells?.[index]?.getBoundingClientRect();
  const second = cells?.[index + 1]?.getBoundingClientRect();
  startPixels = stacked.value
    ? (first?.height ?? 1) + (second?.height ?? 1)
    : (first?.width ?? 1) + (second?.width ?? 1);
}

function resizeCells(index: number, delta: number): void {
  const a = props.views[index];
  const b = props.views[index + 1];
  if (!a || !b) {
    return;
  }

  const total = startWeights[0] + startWeights[1];
  const share = Math.min(
    0.9,
    Math.max(0.1, startWeights[0] / total + delta / startPixels)
  );
  store.resizeViews(props.zone, {
    [a]: share * total,
    [b]: (1 - share) * total,
  });
}
</script>

<template>
  <section
    ref="root"
    class="relative flex min-h-0 min-w-0 flex-col bg-zinc-950"
    :aria-label="ZONE_LABELS[zone]"
  >
    <!-- Tabs -->
    <template v-if="!split">
      <div
        class="flex h-8 shrink-0 items-stretch border-b border-zinc-800 bg-zinc-950"
        role="tablist"
      >
        <div
          v-for="view in views"
          :key="view"
          :data-view-tab="view"
          role="tab"
          :aria-selected="view === active"
          draggable="true"
          class="group flex min-w-0 cursor-grab items-center gap-1.5 border-r border-zinc-800 pl-2.5 pr-1 text-xs select-none"
          :class="
            view === active
              ? 'bg-zinc-900 text-zinc-100 shadow-[inset_0_-2px_0_#f5a623]'
              : 'text-zinc-400 hover:text-zinc-200'
          "
          :title="`${VIEW_TITLES[view]} – drag to move`"
          @click="store.activate(view)"
          @auxclick.middle="store.hide(view)"
          @dragstart="onDragStart($event, view)"
          @dragend="onDragEnd"
        >
          <span :class="VIEW_ICONS[view]" class="shrink-0 text-sm" />
          <span class="truncate">{{ VIEW_TITLES[view] }}</span>
          <button
            type="button"
            class="ml-0.5 rounded p-0.5 text-zinc-500 opacity-0 hover:bg-zinc-800 hover:text-zinc-200 group-hover:opacity-100 focus:opacity-100"
            :aria-label="`Hide ${VIEW_TITLES[view]}`"
            @click.stop="store.hide(view)"
          >
            <span class="i-mdi-close block text-xs" />
          </button>
        </div>
        <button
          v-if="views.length > 1"
          type="button"
          class="ml-auto px-2 text-zinc-500 hover:text-zinc-200"
          :title="stacked ? 'Show stacked' : 'Show side by side'"
          @click="store.setSplit(zone, true)"
        >
          <span
            :class="
              stacked
                ? 'i-mdi-view-split-horizontal'
                : 'i-mdi-view-split-vertical'
            "
          />
        </button>
      </div>
      <div class="relative min-h-0 flex-1">
        <div
          v-for="view in views"
          v-show="view === active"
          :key="view"
          :ref="context?.placeRef(view)"
          class="absolute inset-0"
        />
      </div>
    </template>

    <!-- Side by side / stacked -->
    <div
      v-else
      class="flex min-h-0 min-w-0 flex-1"
      :class="stacked ? 'flex-col' : 'flex-row'"
    >
      <template v-for="(view, i) in views" :key="view">
        <WorkbenchSash
          v-if="i > 0"
          :direction="stacked ? 'row' : 'col'"
          :label="`Resize ${VIEW_TITLES[views[i - 1] ?? view]} and ${VIEW_TITLES[view]}`"
          @start="startResize(i - 1)"
          @move="resizeCells(i - 1, $event)"
        />
        <div
          data-cell
          class="flex min-h-0 min-w-0 flex-col"
          :style="{ flex: `${weightOf(view)} 1 0` }"
        >
          <div
            :data-view-tab="view"
            draggable="true"
            class="group flex h-7 shrink-0 cursor-grab items-center gap-1.5 border-b border-zinc-800 px-2.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500 select-none"
            :title="`${VIEW_TITLES[view]} – drag to move`"
            @dragstart="onDragStart($event, view)"
            @dragend="onDragEnd"
          >
            <span :class="VIEW_ICONS[view]" class="text-sm" />
            {{ VIEW_TITLES[view] }}
            <span class="ml-auto flex items-center gap-0.5">
              <button
                v-if="i === 0"
                type="button"
                class="rounded p-0.5 opacity-0 hover:bg-zinc-800 hover:text-zinc-200 group-hover:opacity-100 focus:opacity-100"
                title="Show as tabs"
                aria-label="Show as tabs"
                @click="store.setSplit(zone, false)"
              >
                <span class="i-mdi-tab block" />
              </button>
              <button
                type="button"
                class="rounded p-0.5 opacity-0 hover:bg-zinc-800 hover:text-zinc-200 group-hover:opacity-100 focus:opacity-100"
                :aria-label="`Hide ${VIEW_TITLES[view]}`"
                @click="store.hide(view)"
              >
                <span class="i-mdi-close block" />
              </button>
            </span>
          </div>
          <div class="relative min-h-0 flex-1">
            <div :ref="context?.placeRef(view)" class="absolute inset-0" />
          </div>
        </div>
      </template>
    </div>

    <!-- Drop target while a view is dragged -->
    <div
      v-if="store.dragging"
      class="absolute inset-0 z-40 border-2 border-dashed transition-colors"
      :class="
        dropHover
          ? 'border-amber-500 bg-amber-500/10'
          : 'border-transparent bg-transparent'
      "
      @dragenter.prevent="dropHover = true"
      @dragover.prevent
      @dragleave="dropHover = false"
      @drop="onDrop"
    >
      <span
        v-if="dropHover"
        class="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded bg-zinc-900/90 px-2 py-1 text-xs text-amber-200"
      >
        Move to {{ ZONE_LABELS[zone] }}
      </span>
    </div>
  </section>
</template>
