import type { Camera } from '@vizscript/canvas';
import { formatCameraParam, parseCameraParam } from '@vizscript/canvas';
import type { FunctionGraph, GraphDocument } from '@vizscript/core';
import { useDebounceFn } from '@vueuse/core';
import type { ComputedRef, Ref, ShallowRef } from 'vue';
import { computed, nextTick, onBeforeUnmount, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { VIEW_PARAM } from '../../graph/share';
import type { GraphCanvasInstance } from './types';

const FOCUS_PARAM = 'fn';

export interface FocusModeDeps {
  /** Key for per-file view state (camera) in localStorage. */
  stateKey: () => string;
  doc: ShallowRef<GraphDocument | null>;
  canvas: Readonly<ShallowRef<GraphCanvasInstance | null>>;
}

export interface FocusMode {
  /** The camera to start with (from the URL, else the last one). */
  initialCamera: Camera | null;
  onCameraChange: (camera: Camera) => void;
  /** Id of the function shown on its own. */
  focusFn: Ref<string | null>;
  focusBack: Ref<Array<string | null>>;
  focusAhead: Ref<Array<string | null>>;
  focusedFunction: ComputedRef<FunctionGraph | undefined>;
  /** The document the graph shows: one function in focus mode. */
  shownDoc: ComputedRef<GraphDocument | null>;
  /** Shows one function (or all with `null`), remembered for Back. */
  focusFunction: (id: string | null) => Promise<void>;
  navigateFocus: (direction: 'back' | 'forward') => void;
  /** The function of a node, when focus mode hides it. */
  hiddenFunctionOf: (ids: ReadonlyArray<string>) => string | null | undefined;
  /** A renamed function keeps the focus (its id follows the name). */
  followRename: (previous: GraphDocument | null, next: GraphDocument) => void;
}

/**
 * The camera of a file (URL and localStorage) and focus mode.
 *
 * Like UE's graph tabs: one function on its own, with a breadcrumb and
 * back / forward. `?fn=` keeps it for reloads and shared links.
 */
export function useFocusMode(deps: FocusModeDeps): FocusMode {
  const { doc, canvas } = deps;
  const route = useRoute();
  const router = useRouter();
  const cameraKey = computed(() => `vizscript:camera:${deps.stateKey()}`);
  // The URL (`?view=x,y,zoom`) wins, so reloads and shared links show the
  // same view; otherwise the view last used for this file in this browser.
  const initialCamera: Camera | null =
    parseCameraParam(route.query[VIEW_PARAM]) ??
    (() => {
      try {
        return JSON.parse(
          localStorage.getItem(cameraKey.value) ?? 'null'
        ) as Camera | null;
      } catch {
        return null;
      }
    })();

  let lastCamera: Camera | null = null;
  let unmounted = false;
  onBeforeUnmount(() => {
    unmounted = true;
  });

  const saveCamera = useDebounceFn((camera: Camera, path: string) => {
    try {
      localStorage.setItem(cameraKey.value, JSON.stringify(camera));
    } catch {
      // ignore
    }

    // Only while this file is still open (a pending update must not leak
    // into the URL of the next file).
    if (unmounted || route.path !== path) {
      return;
    }

    const view = formatCameraParam(camera);
    if (route.query[VIEW_PARAM] !== view) {
      void router.replace({ query: { ...route.query, [VIEW_PARAM]: view } });
    }
  }, 300);

  function onCameraChange(camera: Camera): void {
    lastCamera = camera;
    void saveCamera(camera, route.path);
  }

  // ---------------------------------------------------------- focus mode

  const focusFn = ref<string | null>(
    typeof route.query[FOCUS_PARAM] === 'string'
      ? route.query[FOCUS_PARAM]
      : null
  );
  const focusBack = ref<Array<string | null>>([]);
  const focusAhead = ref<Array<string | null>>([]);
  /** The camera of each view (`''`: all functions), to come back to. */
  const focusCameras = new Map<string, Camera>();

  const focusedFunction = computed(() =>
    focusFn.value
      ? doc.value?.functions.find((f) => f.id === focusFn.value)
      : undefined
  );

  const shownDoc = computed(() => {
    const d = doc.value;
    const fn = focusedFunction.value;
    return d && fn ? { ...d, functions: [fn] } : d;
  });

  async function showFocus(id: string | null): Promise<void> {
    if (lastCamera) {
      focusCameras.set(focusFn.value ?? '', lastCamera);
    }

    focusFn.value = id;
    const query = { ...route.query };
    if (id) {
      query[FOCUS_PARAM] = id;
    } else {
      delete query[FOCUS_PARAM];
    }

    void router.replace({ query });
    // The canvas gets the new document first.
    await nextTick();
    await nextTick();
    const camera = focusCameras.get(id ?? '');
    if (camera) {
      canvas.value?.setCamera(camera);
    } else {
      canvas.value?.frameAll();
    }
  }

  async function focusFunction(id: string | null): Promise<void> {
    if (id === focusFn.value) {
      return;
    }

    focusBack.value = [...focusBack.value, focusFn.value];
    focusAhead.value = [];
    await showFocus(id);
  }

  function navigateFocus(direction: 'back' | 'forward'): void {
    const from = direction === 'back' ? focusBack : focusAhead;
    const to = direction === 'back' ? focusAhead : focusBack;
    const next = from.value.at(-1);
    if (next === undefined) {
      return;
    }

    from.value = from.value.slice(0, -1);
    to.value = [...to.value, focusFn.value];
    void showFocus(next);
  }

  function hiddenFunctionOf(
    ids: ReadonlyArray<string>
  ): string | null | undefined {
    const focused = focusedFunction.value;
    if (!focused || ids.every((id) => focused.nodes.some((n) => n.id === id))) {
      return undefined;
    }

    const fns = new Set(
      ids.map(
        (id) =>
          doc.value?.functions.find((f) => f.nodes.some((n) => n.id === id))?.id
      )
    );
    const [only] = fns;
    // Nodes of several functions: show all of them.
    return fns.size === 1 && only ? only : null;
  }

  function followRename(
    previous: GraphDocument | null,
    next: GraphDocument
  ): void {
    const focused = focusFn.value;
    if (!focused || !previous || next.functions.some((f) => f.id === focused)) {
      return;
    }

    const old = previous.functions.find((f) => f.id === focused);
    const same = old
      ? (next.functions.find((f) => f.range.start === old.range.start) ??
        next.functions[previous.functions.indexOf(old)])
      : undefined;
    focusFn.value = same?.id ?? null;
    const query = { ...route.query };
    if (same) {
      query[FOCUS_PARAM] = same.id;
    } else {
      delete query[FOCUS_PARAM];
    }

    void router.replace({ query });
  }

  return {
    initialCamera,
    onCameraChange,
    focusFn,
    focusBack,
    focusAhead,
    focusedFunction,
    shownDoc,
    focusFunction,
    navigateFocus,
    hiddenFunctionOf,
    followRename,
  };
}
