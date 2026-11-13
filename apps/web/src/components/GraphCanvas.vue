<script setup lang="ts">
import type { Camera, CommentTarget, GraphViewEvents } from '@vizscript/canvas';
import { DARK_THEME, GraphView, LIGHT_THEME } from '@vizscript/canvas';
import type {
  GraphNode,
  GraphOp,
  LayoutPatch,
  NodeTemplate,
  PinRef,
  Point,
} from '@vizscript/core';
import { endOfFunction } from '@vizscript/core';
import { usePreferredReducedMotion } from '@vueuse/core';
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  toRaw,
  useTemplateRef,
  watch,
} from 'vue';
import { useTheme } from '../composables/use-theme';
import { useToasts } from '../composables/use-toasts';
import { indexDocument } from '../graph/doc-index';
import type { ProblemSeverity } from '../graph/problems';
import { worstSeverity } from '../graph/problems';
import { topLevelGraph } from '../graph/symbols';
import ActionMenu from './ActionMenu.vue';
import type { MenuEntry } from './ContextMenu.vue';
import ContextMenu from './ContextMenu.vue';
import { createActionEntries } from './graph-canvas/action-entries';
import { createContextEntries } from './graph-canvas/context-entries';
import {
  collectCallables,
  newExternalNames,
  withPosition,
} from './graph-canvas/graph-helpers';
import { createNodeCommands } from './graph-canvas/node-commands';
import { createReplaceEntries } from './graph-canvas/replace-entries';
import type {
  CanvasContext,
  CanvasEvents,
  GraphCanvasProps,
  MenuState,
  Place,
  Prompt,
  PromptOptions,
} from './graph-canvas/types';
import { useCanvasKeys } from './graph-canvas/use-canvas-keys';
import { useGraphClipboard } from './graph-canvas/use-graph-clipboard';
import { useSymbolDrop } from './graph-canvas/use-symbol-drop';
import ZoomControls from './graph-canvas/ZoomControls.vue';
import GraphSearch from './GraphSearch.vue';
import NodeTooltip from './NodeTooltip.vue';

const props = defineProps<GraphCanvasProps>();
const emit = defineEmits<{
  selectionChange: [ids: string[]];
  hoverChange: [id: string | null];
  layoutChange: [patch: LayoutPatch];
  op: [op: GraphOp];
  activate: [id: string];
  goToDefinition: [id: string];
  cameraChange: [camera: Camera];
  /** Forget saved positions so the nodes go back to the auto layout. */
  resetLayout: [ids: string[]];
  undo: [];
  redo: [];
  /** The action menu opened (names of other files can be looked up). */
  actionMenu: [];
  /** Show only this function (UE: open its graph). */
  openFunction: [fnId: string];
  /** Back / forward through the shown functions (mouse buttons, Alt+←/→). */
  navigate: [direction: 'back' | 'forward'];
}>();

const { show } = useToasts();
const { scheme } = useTheme();
/** Eased camera and node moves, unless the user asked for less motion. */
const reducedMotion = usePreferredReducedMotion();
const motion = computed(() => reducedMotion.value !== 'reduce');

const canvasTheme = computed(() =>
  scheme.value === 'light' ? LIGHT_THEME : DARK_THEME
);
/** Zoom of the camera, for the zoom controls. */
const zoom = ref(1);
const canvas = useTemplateRef<HTMLCanvasElement>('canvas');
const view = shallowRef<GraphView>();
const index = computed(() => indexDocument(props.doc));
const selection = ref<string[]>([]);
/** Last pointer position, in client coordinates. */
const pointer = { x: 0, y: 0 };

// ------------------------------------------------------- inline literal

const literal = ref<GraphViewEvents['editLiteral'] | null>(null);
const literalValue = ref('');
const literalInput = useTemplateRef<HTMLInputElement>('literalInput');

function commitLiteral(): void {
  const current = literal.value;
  literal.value = null;
  if (current && literalValue.value !== current.value) {
    emit('op', {
      type: 'setLiteral',
      node: current.node,
      pin: current.pin,
      value: literalValue.value,
    });
  }

  canvas.value?.focus();
}

function cancelLiteral(): void {
  literal.value = null;
  canvas.value?.focus();
}

// --------------------------------------------------------- comment edit

const commentEdit = ref<GraphViewEvents['editComment'] | null>(null);
const commentValue = ref('');
const commentInput = useTemplateRef<HTMLInputElement | HTMLTextAreaElement>(
  'commentInput'
);

function commitComment(): void {
  const current = commentEdit.value;
  commentEdit.value = null;
  if (!current || commentValue.value.trim() === current.value.trim()) {
    canvas.value?.focus();
    return;
  }

  emitOp(
    current.target.kind === 'node'
      ? {
          type: 'setComment',
          node: current.target.nodeId,
          text: commentValue.value,
        }
      : {
          type: 'renameCommentBox',
          box: current.target.boxId,
          title: commentValue.value,
        }
  );
}

function cancelComment(): void {
  commentEdit.value = null;
  canvas.value?.focus();
}

function onCommentKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    cancelComment();
  } else if (event.key === 'Enter' && !event.shiftKey) {
    // Shift+Enter starts a new line.
    event.preventDefault();
    commitComment();
  }
}

// --------------------------------------------------------------- tooltip

const hover = ref<{ nodeId: string; pin: string | null } | null>(null);
const tooltip = ref<{
  nodeId: string;
  pin: string | null;
  x: number;
  y: number;
} | null>(null);
let tooltipTimer: ReturnType<typeof setTimeout> | undefined;

function hideTooltip(): void {
  clearTimeout(tooltipTimer);
  tooltip.value = null;
}

function scheduleTooltip(): void {
  hideTooltip();
  const current = hover.value;
  if (!current || menu.value || literal.value || commentEdit.value) {
    return;
  }

  tooltipTimer = setTimeout(() => {
    tooltip.value = { ...current, x: pointer.x, y: pointer.y };
  }, 550);
}

// ---------------------------------------------------------------- search

const searchOpen = ref(false);
const search = useTemplateRef<InstanceType<typeof GraphSearch>>('search');

async function openSearch(): Promise<void> {
  hideTooltip();
  if (searchOpen.value) {
    search.value?.focus();
    return;
  }

  searchOpen.value = true;
  await nextTick();
  search.value?.focus();
}

function closeSearch(): void {
  searchOpen.value = false;
  view.value?.setHighlight([]);
  canvas.value?.focus();
}

function selectNodes(ids: string[], focus = true): void {
  view.value?.setSelection(ids);
  selection.value = ids;
  emit('selectionChange', ids);
  if (focus) {
    view.value?.focusNodes(ids);
    view.value?.pulseNodes(ids);
  }
}

// ---------------------------------------------------------- context menu

const menu = ref<MenuState | null>(null);
const prompt = ref<Prompt | null>(null);
/** The node whose variable or function "Replace with…" picks. */
const replacing = ref<string | null>(null);
const promptInput = useTemplateRef<HTMLInputElement>('promptInput');

function openMenu(state: MenuState): void {
  hideTooltip();
  prompt.value = null;
  replacing.value = null;
  menu.value = state;
  if (props.editable) {
    emit('actionMenu');
  }
}

function closeMenu(): void {
  menu.value = null;
  prompt.value = null;
  replacing.value = null;
  view.value?.clearPendingWire();
}

async function ask(options: PromptOptions): Promise<void> {
  prompt.value = { value: '', ...options };
  await nextTick();
  promptInput.value?.focus();
  promptInput.value?.select();
}

function commitPrompt(): void {
  const current = prompt.value;
  const value = current?.value.trim() ?? '';
  if (!current || (!value && !current.allowEmpty)) {
    return;
  }

  current.submit(value);
}

// ------------------------------------------------------------------- ops

/**
 * Where new code for a point of the graph goes: the end of the function
 * whose frame contains it (else the module). `undefined` in a GDScript
 * file's top level, which is its class body.
 */
function placeAt(world: Point): Place | undefined {
  const v = view.value;
  const doc = props.doc;
  if (!v || !doc) {
    return undefined;
  }

  const top = topLevelGraph(doc, props.text);
  const fnId = v.functionAt(world) ?? top?.id;
  const anchor = fnId ? endOfFunction(doc, fnId) : undefined;
  if (!fnId || !anchor || (doc.language === 'gdscript' && fnId === top?.id)) {
    return undefined;
  }

  return { fnId, anchor };
}

/** Emits an op built from the menu state and closes the menu. */
function emitOp(op: GraphOp): void {
  const open = menu.value;
  const placed = open?.from ? withPosition(op, { ...open.world }) : op;
  closeMenu();
  // Ops are posted to a worker: strip reactive proxies (ops are plain JSON).
  emit('op', JSON.parse(JSON.stringify(placed)) as GraphOp);
  canvas.value?.focus();
}

function pinOf(pinRef: PinRef): ReturnType<CanvasContext['pinOf']> {
  const node = index.value.nodes.get(pinRef.node)?.node;
  const pin = node?.pins.find((p) => p.id === pinRef.pin);
  return node && pin ? { node, pin } : undefined;
}

function addNode(
  template: NodeTemplate,
  state: MenuState | null,
  wrap?: (op: GraphOp) => GraphOp
): void {
  const current = toRaw(state);
  if (!current) {
    closeMenu();
    return;
  }

  const from = current.from ? pinOf(current.from) : undefined;
  const anchor: PinRef | undefined =
    from?.pin.kind === 'exec' && current.from
      ? { ...toRaw(current.from) }
      : undefined;
  // Without an exec pin: at the end of the function under the cursor.
  const place = anchor ? undefined : placeAt(current.world);
  const op: GraphOp = place
    ? {
        type: 'addNode',
        template,
        ...place.anchor,
        position: { ...current.world },
      }
    : {
        type: 'addNode',
        template,
        after: from?.pin.direction === 'out' ? anchor : undefined,
        before: from?.pin.direction === 'in' ? anchor : undefined,
        position: { ...current.world },
      };
  emitOp(wrap ? wrap(op) : op);
}

/** Functions worth offering: called in this file, defined, or imported. */
const callables = computed(() =>
  collectCallables(props.doc, props.text, props.imports, props.types?.globals)
);

/** Names of other files and libraries not offered as callables already. */
const externalNames = computed(() =>
  newExternalNames(callables.value, props.externals)
);

// ----------------------------------------------------------------- menus

const ctx: CanvasContext = {
  props,
  view,
  canvas,
  index,
  selection,
  callables,
  externalNames,
  emitOp,
  show,
  ask,
  addNode,
  placeAt,
  pinOf,
};
const events: CanvasEvents = {
  op: (op) => emit('op', op),
  activate: (id) => emit('activate', id),
  goToDefinition: (id) => emit('goToDefinition', id),
  resetLayout: (ids) => emit('resetLayout', ids),
  openFunction: (fnId) => emit('openFunction', fnId),
};
const commands = createNodeCommands({
  ...ctx,
  openMenu,
  closeMenu,
  selectNodes,
  pointer,
});
const clipboard = useGraphClipboard({ ...ctx, pointer });
const { dropMenu, onDragOver, onDrop } = useSymbolDrop(ctx);
const { actionEntries, suggestActions, actionTitle } = createActionEntries({
  ...ctx,
  commands,
  pasteFromClipboard: clipboard.pasteFromClipboard,
  openSearch,
});
const { replaceEntries, replaceTitle, replaceSuggest } =
  createReplaceEntries(ctx);
const targetEntries = createContextEntries({
  ...ctx,
  ...clipboard,
  events,
  commands,
  replacing,
  selectNodes,
});

const menuEntries = computed<MenuEntry[]>(() =>
  menu.value ? targetEntries(menu.value.target, menu.value) : []
);

// ----------------------------------------------------------- lifecycle

onMounted(() => {
  const v = new GraphView(canvas.value as HTMLCanvasElement, {
    editable: props.editable,
    theme: canvasTheme.value,
    motion: motion.value,
  });
  view.value = v;
  if (props.initialCamera) {
    v.setCamera(props.initialCamera);
    zoom.value = props.initialCamera.zoom;
  }

  v.on('selectionChange', ({ nodeIds }) => {
    selection.value = nodeIds;
    emit('selectionChange', nodeIds);
  });
  v.on('hoverChange', ({ nodeId, pin }) => {
    if (nodeId !== hover.value?.nodeId) {
      emit('hoverChange', nodeId);
    }

    hover.value = nodeId ? { nodeId, pin } : null;
    scheduleTooltip();
  });
  v.on('layoutChange', ({ patch }) => emit('layoutChange', patch));
  v.on('op', (op) => emit('op', op));
  v.on('activate', ({ nodeId }) => emit('activate', nodeId));
  v.on('openFunction', ({ fnId }) => emit('openFunction', fnId));
  v.on('cameraChange', (camera) => {
    zoom.value = camera.zoom;
    hideTooltip();
    emit('cameraChange', camera);
  });
  v.on('editLiteral', async (event) => {
    hideTooltip();
    literal.value = event;
    literalValue.value = event.value;
    await nextTick();
    literalInput.value?.focus();
    literalInput.value?.select();
  });
  v.on('editComment', async (event) => {
    hideTooltip();
    closeMenu();
    commentEdit.value = event;
    commentValue.value = event.value;
    await nextTick();
    commentInput.value?.focus();
    commentInput.value?.select();
  });
  v.on('contextMenu', (event) => {
    if (event.from && !props.editable) {
      return;
    }

    openMenu(event);
  });

  if (props.doc) {
    v.setDocument(props.doc, props.positions);
  }

  v.setProblems(severities.value);
});

const severities = computed(() => {
  const result = new Map<string, ProblemSeverity | 'sync'>();
  for (const [id, list] of props.problems ?? []) {
    const severity = worstSeverity(list);
    if (severity) {
      result.set(id, severity);
    }
  }

  // Not in the code yet (graph-only edits), unless the code has an error.
  for (const id of props.syncNodes ?? []) {
    if (result.get(id) !== 'error') {
      result.set(id, 'sync');
    }
  }

  return result;
});

watch(severities, (value) => view.value?.setProblems(value));
watch(canvasTheme, (value) => view.value?.setTheme(value));
watch(motion, (value) => view.value?.setMotion(value));

onBeforeUnmount(() => {
  clearTimeout(tooltipTimer);
  view.value?.destroy();
});

watch(
  () => [props.doc, props.positions] as const,
  ([doc, positions]) => {
    if (doc) {
      view.value?.setDocument(doc, positions);
      selection.value = view.value?.getSelection() ?? [];
    }
  }
);

watch(
  () => props.editable,
  (editable) => view.value?.setEditable(editable)
);

const { onKeydown, onHotkeyDown, onHotkeyUp, onPointerDownCapture } =
  useCanvasKeys({
    ...ctx,
    pointer,
    openMenu,
    openSearch,
    duplicateSelection: clipboard.duplicateSelection,
    createCommentBox: commands.createCommentBox,
    navigate: (direction) => emit('navigate', direction),
    undo: () => emit('undo'),
    redo: () => emit('redo'),
    goToDefinition: (id) => emit('goToDefinition', id),
  });

function onPointerDown(event: PointerEvent): void {
  hideTooltip();
  // Mouse back / forward buttons, like in UE and browsers.
  if (event.button === 3 || event.button === 4) {
    event.preventDefault();
    emit('navigate', event.button === 3 ? 'back' : 'forward');
  }
}

function onPointerMove(event: PointerEvent): void {
  pointer.x = event.clientX;
  pointer.y = event.clientY;
}

defineExpose({
  sizeOf: (node: GraphNode) =>
    view.value?.sizeOf(node) ?? { width: 160, height: 60 },
  spaceAbove: (node: GraphNode) => view.value?.spaceAbove(node) ?? 0,
  setHighlight: (ids: string[]) => view.value?.setHighlight(ids),
  getCamera: () => view.value?.getCamera(),
  setCamera: (camera: Camera) => view.value?.setCamera(camera),
  setSelection: (ids: string[]) => {
    view.value?.setSelection(ids);
    selection.value = view.value?.getSelection() ?? [];
  },
  /** Selects nodes, notifies listeners and centers them. */
  selectNodes,
  revealNodes: (ids: string[]) => view.value?.revealNodes(ids),
  frameAll: () => view.value?.frameAll(),
  frameSelection: () => view.value?.frameSelection(),
  selectAll: () => view.value?.selectAll(),
  selectFunction: (fnId: string) => {
    view.value?.selectFunction(fnId);
    view.value?.frameSelection();
  },
  editLiteral: (node: string, pin: string) =>
    view.value?.editLiteral(node, pin),
  editComment: (target: CommentTarget) => view.value?.editComment(target),
  getPositions: () => view.value?.getPositions() ?? {},
  openSearch,
  focus: () => canvas.value?.focus(),
});
</script>

<template>
  <div
    data-ui="graph-canvas"
    class="relative h-full w-full overflow-hidden"
    @keydown="onKeydown"
    @keydown.capture="onHotkeyDown"
    @keyup="onHotkeyUp"
    @pointermove="onPointerMove"
    @pointerdown.capture="onPointerDownCapture"
    @pointerdown="onPointerDown"
    @wheel.passive="hideTooltip"
    @dragover="onDragOver"
    @drop="onDrop"
  >
    <canvas
      ref="canvas"
      data-testid="graph-canvas"
      aria-label="Node graph. Press Shift+F10 for actions, Ctrl+F to search."
      class="block h-full w-full"
    />

    <ZoomControls :view="view" :zoom="zoom" />

    <GraphSearch
      v-if="searchOpen"
      ref="search"
      :doc="doc"
      :text="text"
      @select="(id) => selectNodes([id])"
      @matches="(ids) => view?.setHighlight(ids)"
      @close="closeSearch"
    />

    <NodeTooltip
      v-if="tooltip"
      :index="index"
      :text="text"
      :node-id="tooltip.nodeId"
      :pin-id="tooltip.pin"
      :problems="problems?.get(tooltip.nodeId)"
      :x="tooltip.x"
      :y="tooltip.y"
    />

    <input
      v-if="literal"
      ref="literalInput"
      v-model="literalValue"
      class="fixed z-20 rounded border border-amber-500 bg-zinc-900 px-2 font-mono text-xs text-zinc-100 outline-none"
      :style="{
        left: `${literal.rect.x}px`,
        top: `${literal.rect.y}px`,
        width: `${Math.max(literal.rect.width, 140)}px`,
        height: `${Math.max(literal.rect.height, 22)}px`,
      }"
      @keydown.enter.prevent="commitLiteral"
      @keydown.escape.prevent="cancelLiteral"
      @blur="commitLiteral"
    />

    <template v-if="commentEdit">
      <textarea
        v-if="commentEdit.target.kind === 'node'"
        ref="commentInput"
        v-model="commentValue"
        class="fixed z-20 resize-none rounded border border-amber-500 bg-zinc-100 px-2 py-1 text-xs text-zinc-900 shadow-xl outline-none"
        :style="{
          left: `${commentEdit.rect.x}px`,
          top: `${commentEdit.rect.y}px`,
          width: `${Math.max(commentEdit.rect.width, 240)}px`,
          height: `${Math.max(commentEdit.rect.height, 64)}px`,
        }"
        placeholder="Comment (Shift+Enter for a new line, empty to remove)"
        aria-label="Node comment"
        @keydown="onCommentKeydown"
        @blur="commitComment"
      />
      <input
        v-else
        ref="commentInput"
        v-model="commentValue"
        class="fixed z-20 rounded border border-amber-500 bg-zinc-900 px-2 text-sm font-semibold text-zinc-100 outline-none"
        :style="{
          left: `${commentEdit.rect.x}px`,
          top: `${commentEdit.rect.y}px`,
          width: `${Math.max(commentEdit.rect.width, 160)}px`,
          height: `${Math.max(commentEdit.rect.height, 24)}px`,
        }"
        placeholder="Comment box title"
        aria-label="Comment box title"
        @keydown="onCommentKeydown"
        @blur="commitComment"
      />
    </template>

    <template v-if="menu">
      <form
        v-if="prompt"
        class="motion-pop fixed z-40 w-72 rounded-lg border border-zinc-700 bg-zinc-900/98 p-2 shadow-2xl"
        :style="{ left: `${menu.client.x}px`, top: `${menu.client.y}px` }"
        @submit.prevent="commitPrompt"
      >
        <label class="mb-1 block text-xs text-zinc-400">
          {{ prompt.label }}
        </label>
        <input
          ref="promptInput"
          v-model="prompt.value"
          class="input font-mono"
          :placeholder="prompt.placeholder"
          @keydown.escape="closeMenu"
          @blur="closeMenu"
        />
      </form>
      <ActionMenu
        v-else-if="replacing"
        :x="menu.client.x"
        :y="menu.client.y"
        :title="replaceTitle(replacing)"
        :entries="replaceEntries(replacing)"
        :suggest="
          (query) => (replacing ? replaceSuggest(replacing, query) : [])
        "
        context-toggle
        @close="closeMenu()"
      />
      <ActionMenu
        v-else-if="menu.from || menu.target.kind === 'background'"
        :x="menu.client.x"
        :y="menu.client.y"
        :title="actionTitle(menu)"
        :entries="actionEntries(menu)"
        :suggest="(query) => (menu ? suggestActions(menu, query) : [])"
        :context-toggle="Boolean(menu.from)"
        @close="prompt || closeMenu()"
      />
      <ContextMenu
        v-else-if="menuEntries.length > 0"
        :x="menu.client.x"
        :y="menu.client.y"
        :entries="menuEntries"
        label="Graph actions"
        @close="prompt || replacing || closeMenu()"
      />
    </template>
    <ContextMenu
      v-if="dropMenu"
      :x="dropMenu.x"
      :y="dropMenu.y"
      :entries="dropMenu.entries"
      label="Variable"
      @close="dropMenu = null"
    />
  </div>
</template>
