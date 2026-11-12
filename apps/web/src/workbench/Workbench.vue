<script setup lang="ts">
import type { ViewId, ZoneId } from '@vizscript/workbench';
import { shownViews, VIEW_TITLES } from '@vizscript/workbench';
import {
  computed,
  nextTick,
  onBeforeUnmount,
  provide,
  reactive,
  ref,
  watchEffect,
} from 'vue';
import { useWorkbenchStore } from '../stores/workbench';
import type { WorkbenchContext } from './context';
import { VIEW_ICONS, WORKBENCH } from './context';
import WorkbenchSash from './WorkbenchSash.vue';
import WorkbenchZone from './WorkbenchZone.vue';

const store = useWorkbenchStore();

// ----------------------------------------------------- views and places

const registered = reactive(new Map<ViewId, number>());
const targets = reactive(new Map<ViewId, HTMLElement>());
const parking = ref<HTMLElement | null>(null);
const placeRefs = new Map<ViewId, (el: unknown) => void>();

function register(view: ViewId): () => void {
  registered.set(view, (registered.get(view) ?? 0) + 1);
  return () => {
    const count = (registered.get(view) ?? 1) - 1;
    if (count > 0) {
      registered.set(view, count);
    } else {
      registered.delete(view);
    }
  };
}

function placeRef(view: ViewId): (el: unknown) => void {
  let fn = placeRefs.get(view);
  if (!fn) {
    fn = (el: unknown) => {
      if (el instanceof HTMLElement) {
        if (targets.get(view) !== el) {
          targets.set(view, el);
        }

        return;
      }

      // The place was removed; a new one may be created in the same update.
      void nextTick(() => {
        if (targets.get(view)?.isConnected === false) {
          targets.delete(view);
        }
      });
    };
    placeRefs.set(view, fn);
  }

  return fn;
}

const context: WorkbenchContext = {
  register,
  target: (view) => targets.get(view) ?? parking.value,
  placeRef,
  ready: computed(() => parking.value !== null),
};
provide(WORKBENCH, context);

watchEffect(() => {
  store.setAvailable(new Set(registered.keys()));
});
onBeforeUnmount(() => store.setAvailable(new Set()));

// ---------------------------------------------------------------- zones

const shown = computed(() => {
  const result = {} as Record<ZoneId, ViewId[]>;
  for (const zone of ['left', 'center', 'right', 'bottom'] as const) {
    result[zone] = shownViews(store.layout, zone, store.available);
  }

  return result;
});

let startSize = 0;

function startZoneResize(zone: 'left' | 'right' | 'bottom'): void {
  startSize = store.layout.zones[zone].size;
}

function resizeZone(zone: 'left' | 'right' | 'bottom', delta: number): void {
  store.resizeZone(
    zone,
    zone === 'left' ? startSize + delta : startSize - delta
  );
}

// Drop strips for zones that are empty while a view is dragged.
const emptyZones = computed(() =>
  (['left', 'right', 'bottom', 'center'] as const).filter(
    (zone) => shown.value[zone].length === 0
  )
);
const stripHover = ref<ZoneId | null>(null);

function dropOnEmpty(zone: ZoneId): void {
  const view = store.dragging;
  store.dragging = null;
  stripHover.value = null;
  if (view) {
    store.move(view, zone);
  }
}

const STRIP_CLASSES: Record<ZoneId, string> = {
  left: 'inset-y-0 left-0 w-20',
  right: 'inset-y-0 right-0 w-20',
  bottom: 'inset-x-0 bottom-0 h-20',
  center: 'inset-x-1/4 inset-y-1/4',
};

const STRIP_LABELS: Record<ZoneId, string> = {
  left: 'Left sidebar',
  right: 'Right sidebar',
  bottom: 'Bottom panel',
  center: 'Main area',
};

const mobileTitle = computed(() => VIEW_TITLES[store.mobileMainView]);
</script>

<template>
  <div data-ui="workbench" class="flex h-full min-h-0 flex-col">
    <!-- Toolbars and the content of the views (teleported into place). -->
    <slot />

    <div
      v-if="!store.isMobile"
      data-ui="workbench-areas"
      class="relative flex min-h-0 flex-1"
      @dragover.prevent
      @drop.prevent="store.dragging = null"
    >
      <template v-if="shown.left.length > 0">
        <WorkbenchZone
          zone="left"
          :views="shown.left"
          class="shrink-0"
          :style="{ width: `${store.layout.zones.left.size}px` }"
        />
        <WorkbenchSash
          direction="col"
          label="Resize left sidebar"
          @start="startZoneResize('left')"
          @move="resizeZone('left', $event)"
        />
      </template>

      <div data-ui="editor-area" class="flex min-w-0 flex-1 flex-col">
        <!-- Editor tabs (open files) go here, between the sidebars. -->
        <div data-ui="editor-bar" class="editor-bar">
          <div
            id="workbench-editor-tabs"
            data-ui="editor-tabs-slot"
            class="min-w-0 flex-1"
          />
          <div
            id="workbench-editor-actions"
            data-ui="editor-actions"
            class="flex shrink-0 items-center"
          />
        </div>
        <WorkbenchZone
          v-if="shown.center.length > 0"
          zone="center"
          :views="shown.center"
          class="flex-1"
        />
        <template v-if="shown.bottom.length > 0">
          <WorkbenchSash
            v-if="shown.center.length > 0"
            direction="row"
            label="Resize bottom panel"
            @start="startZoneResize('bottom')"
            @move="resizeZone('bottom', $event)"
          />
          <WorkbenchZone
            zone="bottom"
            :views="shown.bottom"
            :class="shown.center.length > 0 ? 'shrink-0' : 'flex-1'"
            :style="
              shown.center.length > 0
                ? { height: `${store.layout.zones.bottom.size}px` }
                : {}
            "
          />
        </template>
        <div
          v-if="shown.center.length === 0 && shown.bottom.length === 0"
          class="flex flex-1 items-center justify-center p-6 text-center text-sm text-zinc-500"
        >
          All views are hidden. Use the layout menu
          <span class="i-mdi-view-dashboard-edit-outline mx-1" /> to show them.
        </div>
      </div>

      <template v-if="shown.right.length > 0">
        <WorkbenchSash
          direction="col"
          label="Resize right sidebar"
          @start="startZoneResize('right')"
          @move="resizeZone('right', $event)"
        />
        <WorkbenchZone
          zone="right"
          :views="shown.right"
          class="shrink-0"
          :style="{ width: `${store.layout.zones.right.size}px` }"
        />
      </template>

      <template v-if="store.dragging">
        <div
          v-for="zone in emptyZones"
          :key="zone"
          class="absolute z-50 flex items-center justify-center rounded-md border-2 border-dashed text-xs transition-colors"
          :class="[
            STRIP_CLASSES[zone],
            stripHover === zone
              ? 'border-amber-500 bg-amber-500/20 text-amber-100'
              : 'border-zinc-600 bg-zinc-900/80 text-zinc-400',
          ]"
          @dragenter.prevent="stripHover = zone"
          @dragover.prevent
          @dragleave="stripHover = null"
          @drop.prevent.stop="dropOnEmpty(zone)"
        >
          <span class="pointer-events-none px-1 text-center">{{
            STRIP_LABELS[zone]
          }}</span>
        </div>
      </template>
    </div>

    <!-- Phones: one view at a time, explorer and details as overlays. -->
    <div v-else data-ui="workbench-phone" class="flex min-h-0 flex-1 flex-col">
      <div data-ui="editor-bar" class="editor-bar">
        <div
          id="workbench-editor-tabs"
          data-ui="editor-tabs-slot"
          class="min-w-0 flex-1"
        />
        <div
          id="workbench-editor-actions"
          data-ui="editor-actions"
          class="flex shrink-0 items-center"
        />
      </div>
      <div class="relative min-h-0 flex-1">
        <div
          :key="store.mobileMainView"
          :ref="placeRef(store.mobileMainView)"
          class="absolute inset-0"
          :aria-label="mobileTitle"
        />
        <template v-if="store.mobileDrawer && store.available.has('explorer')">
          <div
            class="fixed inset-0 z-30 bg-black/50"
            @click="store.mobileDrawer = false"
          />
          <aside
            class="fixed inset-y-0 left-0 z-40 flex w-[85vw] max-w-80 flex-col border-r border-zinc-800 bg-zinc-950"
          >
            <div
              class="flex h-10 shrink-0 items-center justify-between border-b border-zinc-800 px-3 text-sm"
            >
              <span class="flex items-center gap-2">
                <span :class="VIEW_ICONS.explorer" /> Explorer
              </span>
              <button
                type="button"
                class="btn-ghost px-2"
                aria-label="Close"
                @click="store.mobileDrawer = false"
              >
                <span class="i-mdi-close" />
              </button>
            </div>
            <div :ref="placeRef('explorer')" class="relative min-h-0 flex-1" />
          </aside>
        </template>
        <div
          v-if="store.mobileDetails && store.available.has('details')"
          :ref="placeRef('details')"
          class="absolute inset-y-0 right-0 z-10 w-[min(20rem,88vw)] shadow-2xl"
        />
      </div>
    </div>

    <!-- Status bar like VS Code's; views teleport their items into it. -->
    <footer
      id="workbench-status"
      data-ui="status-bar"
      class="flex h-6 shrink-0 items-center gap-1 border-t border-zinc-800 bg-zinc-950 px-1 text-xs text-zinc-400"
      aria-label="Status bar"
    />

    <div ref="parking" class="hidden" aria-hidden="true" />
  </div>
</template>

<style scoped>
/* Like VS Code's editor title: open files left, their actions right. */
.editor-bar {
  @apply flex h-9 min-w-0 shrink-0 border-b border-zinc-800 bg-zinc-950;
}

/* Nothing to show (no tabs, no file): no empty bar. */
.editor-bar:not(
  :has([data-ui='file-tabs'], [data-ui='editor-actions-content'])
) {
  display: none;
}
</style>
