import type { ViewId, WorkbenchLayout, ZoneId } from '@vizscript/workbench';
import {
  defaultLayout,
  isViewVisible,
  matchingPreset,
  moveView,
  normalizeLayout,
  presetLayout,
  setActiveView,
  setViewHidden,
  setWeights,
  setZoneSize,
  setZoneSplit,
} from '@vizscript/workbench';
import { useDebounceFn, useMediaQuery, useStorage } from '@vueuse/core';
import { defineStore } from 'pinia';
import { computed, ref, shallowRef, watch } from 'vue';
import { api } from '../api/client';
import { useToasts } from '../composables/use-toasts';
import { useSessionStore } from './session';

const PREFERENCE_KEY = 'workbench.layout';
const CACHE_KEY = 'vizscript:workbench-layout';

function readCache(): WorkbenchLayout {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? normalizeLayout(JSON.parse(raw)) : defaultLayout();
  } catch {
    return defaultLayout();
  }
}

function writeCache(layout: WorkbenchLayout | null): void {
  try {
    if (layout) {
      localStorage.setItem(CACHE_KEY, JSON.stringify(layout));
    } else {
      localStorage.removeItem(CACHE_KEY);
    }
  } catch {
    // storage unavailable: the layout still lives in memory and the server
  }
}

/**
 * Workbench layout (which view sits where) for the signed-in user. It is
 * stored per user on the server and cached in localStorage, so the page
 * renders the right layout before the request returns. Signed-out pages
 * (the playground) only use the cache.
 */
export const useWorkbenchStore = defineStore('workbench', () => {
  const session = useSessionStore();
  const { show } = useToasts();

  const layout = shallowRef<WorkbenchLayout>(readCache());
  /** Views offered by the current page (registered by `WorkbenchView`). */
  const available = shallowRef<ReadonlySet<ViewId>>(new Set());
  /** View currently being dragged to another place. */
  const dragging = ref<ViewId | null>(null);

  // Phones show one view at a time instead of the zones.
  const isMobile = useMediaQuery('(max-width: 767px)');
  const mobileView = useStorage<'code' | 'graph'>(
    'vizscript:mobile-view',
    'graph'
  );
  const mobileDrawer = ref(false);
  const mobileDetails = ref(false);

  const presetId = computed(() => matchingPreset(layout.value));

  // ---------------------------------------------------------- persistence

  const saveRemote = useDebounceFn(async (value: WorkbenchLayout) => {
    if (!session.me) {
      return;
    }

    try {
      await api.savePreference(PREFERENCE_KEY, value);
    } catch (error) {
      show(`Saving the layout failed: ${(error as Error).message}`, 'error');
    }
  }, 800);

  function commit(next: WorkbenchLayout, persist = true): void {
    layout.value = next;
    writeCache(next);
    if (persist) {
      void saveRemote(next);
    }
  }

  watch(
    () => session.me?.id,
    async (userId) => {
      if (!userId) {
        return;
      }

      try {
        const stored = await api.getPreference(PREFERENCE_KEY);
        if (stored.value !== null && session.me?.id === userId) {
          commit(normalizeLayout(stored.value), false);
        }
      } catch {
        // keep the cached layout
      }
    },
    { immediate: true }
  );

  // ------------------------------------------------------------- queries

  function isVisible(view: ViewId): boolean {
    if (!available.value.has(view)) {
      return false;
    }

    if (isMobile.value) {
      switch (view) {
        case 'explorer': {
          return mobileDrawer.value;
        }

        case 'details': {
          return mobileDetails.value;
        }

        default: {
          return mobileMainView.value === view;
        }
      }
    }

    return isViewVisible(layout.value, view, available.value);
  }

  /**
   * View shown full screen on phones: the code, or the visual view of the
   * file (graph for scripts, preview for Markdown).
   */
  const mobileMainView = computed<ViewId>(() => {
    if (mobileView.value === 'graph') {
      if (available.value.has('graph')) {
        return 'graph';
      }

      if (available.value.has('preview')) {
        return 'preview';
      }
    }

    return 'code';
  });

  // ------------------------------------------------------------- actions

  function setAvailable(views: ReadonlySet<ViewId>): void {
    available.value = views;
  }

  function show_(view: ViewId): void {
    if (isMobile.value) {
      if (view === 'problems' || view === 'script') {
        // Phones show problems on the graph only and have no "My Script".
        return;
      }

      if (view === 'explorer') {
        mobileDrawer.value = true;
      } else if (view === 'details') {
        mobileDetails.value = true;
      } else {
        mobileView.value = view === 'code' ? 'code' : 'graph';
      }

      return;
    }

    commit(setViewHidden(layout.value, view, false));
  }

  function hide(view: ViewId): void {
    if (isMobile.value) {
      if (view === 'explorer') {
        mobileDrawer.value = false;
      } else if (view === 'details') {
        mobileDetails.value = false;
      }

      return;
    }

    commit(setViewHidden(layout.value, view, true));
  }

  function toggle(view: ViewId): void {
    if (isVisible(view)) {
      hide(view);
    } else {
      show_(view);
    }
  }

  /** Code / Split / Viz quick switch of the toolbar. */
  function setCodeGraph(mode: 'code' | 'split' | 'viz'): void {
    if (isMobile.value) {
      mobileView.value = mode === 'code' ? 'code' : 'graph';
      return;
    }

    // The visual view is the graph or, for Markdown, the preview.
    let next = setViewHidden(layout.value, 'code', mode === 'viz');
    next = setViewHidden(next, 'graph', mode === 'code');
    next = setViewHidden(next, 'preview', mode === 'code');
    commit(next);
  }

  function move(view: ViewId, zone: ZoneId, index?: number): void {
    commit(moveView(layout.value, view, zone, index));
  }

  function activate(view: ViewId): void {
    commit(setActiveView(layout.value, view));
  }

  function resizeZone(zone: Exclude<ZoneId, 'center'>, size: number): void {
    commit(setZoneSize(layout.value, zone, size));
  }

  function setSplit(zone: ZoneId, split: boolean): void {
    commit(setZoneSplit(layout.value, zone, split));
  }

  function resizeViews(
    zone: ZoneId,
    weights: Partial<Record<ViewId, number>>
  ): void {
    commit(setWeights(layout.value, zone, weights));
  }

  function applyPreset(id: string): void {
    const next = presetLayout(id);
    if (next) {
      commit(next);
    }
  }

  async function reset(): Promise<void> {
    layout.value = defaultLayout();
    writeCache(null);
    if (session.me) {
      try {
        await api.deletePreference(PREFERENCE_KEY);
      } catch (error) {
        show(
          `Resetting the layout failed: ${(error as Error).message}`,
          'error'
        );
      }
    }
  }

  return {
    layout,
    available,
    dragging,
    isMobile,
    mobileView,
    mobileMainView,
    mobileDrawer,
    mobileDetails,
    presetId,
    isVisible,
    setAvailable,
    show: show_,
    hide,
    toggle,
    setCodeGraph,
    move,
    activate,
    resizeZone,
    setSplit,
    resizeViews,
    applyPreset,
    reset,
  };
});
