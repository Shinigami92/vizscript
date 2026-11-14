<script setup lang="ts">
import { COMMENT_BOX_TOP } from '@vizscript/canvas';
import type {
  GraphDocument,
  GraphNode,
  GraphOp,
  GraphOverlay,
  LayoutPatch,
  Positions,
  TextEdit,
  TypeSystemInfo,
} from '@vizscript/core';
import {
  applyOverlay,
  boxColorEntries,
  diffEdits,
  findDefinition,
  findNode,
  graphEditsFor,
  layoutDocument,
  reconcilePositions,
  reconcileReroutes,
  reconcileVias,
  remapOverlay,
  renamedNodes,
  rerouteEntries,
} from '@vizscript/core';
import { useDebounceFn, useMediaQuery } from '@vueuse/core';
import {
  computed,
  defineAsyncComponent,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  useTemplateRef,
  watch,
} from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useToasts } from '../composables/use-toasts';
import { GraphClient } from '../graph/graph-client';
import { isPreviewable, isVisualizable } from '../graph/languages';
import { symbolNodes, topLevelGraph } from '../graph/symbols';
import { useWorkbenchStore } from '../stores/workbench';
import LayoutMenu from '../workbench/LayoutMenu.vue';
import WorkbenchView from '../workbench/WorkbenchView.vue';
import DetailsPanel from './DetailsPanel.vue';
import GraphCanvas from './GraphCanvas.vue';
import MyScriptPanel from './MyScriptPanel.vue';
import ProblemsPanel from './ProblemsPanel.vue';
import EditorActions from './script-workspace/EditorActions.vue';
import GraphBreadcrumb from './script-workspace/GraphBreadcrumb.vue';
import type { PendingPlacement } from './script-workspace/placement';
import {
  floatingLayout,
  placementFor,
  placeNewNodes,
} from './script-workspace/placement';
import {
  currentFunctionOf,
  describeTarget,
  findDefinitionTarget,
  parentGraphs,
  variableOfNode,
} from './script-workspace/symbol-lookup';
import type {
  CodeEditorInstance,
  ScriptWorkspaceProps,
  ViewMode,
} from './script-workspace/types';
import { useCodeGraphSync } from './script-workspace/use-code-graph-sync';
import { useFocusMode } from './script-workspace/use-focus-mode';
import { useGraphOverlay } from './script-workspace/use-graph-overlay';
import { useImports } from './script-workspace/use-imports';
import { useLayoutHistory } from './script-workspace/use-layout-history';
import { useProblems } from './script-workspace/use-problems';
import { useViaWires } from './script-workspace/use-via-wires';
import WorkspaceStatus from './script-workspace/WorkspaceStatus.vue';

export type { DefinitionTarget } from './script-workspace/symbol-lookup';
export type { ViewMode } from './script-workspace/types';

const CodeEditor = defineAsyncComponent(() => import('./CodeEditor.vue'));
const MarkdownPreview = defineAsyncComponent(
  () => import('./MarkdownPreview.vue')
);

const props = defineProps<ScriptWorkspaceProps>();

const emit = defineEmits<{
  'update:text': [text: string];
  /** Graph-only edits changed (stored with the draft). */
  'update:overlay': [overlay: GraphOverlay];
  /** The graph has edits the code doesn't have yet: saving is blocked. */
  'out-of-sync': [outOfSync: boolean];
  /**
   * Open another repository file (Ctrl/Cmd+click on an import, "Go to
   * definition"), optionally at the definition of `symbol`.
   */
  open: [path: string, symbol?: string];
}>();

const { show } = useToasts();
const workbench = useWorkbenchStore();
const isMobile = computed(() => workbench.isMobile);
const isCoarse = useMediaQuery('(pointer: coarse)');
const visualizable = computed(() => isVisualizable(props.path));
const codeVisible = computed(() => workbench.isVisible('code'));
const graphVisible = computed(
  () => visualizable.value && workbench.isVisible('graph')
);
const previewable = computed(() => isPreviewable(props.path));
const previewVisible = computed(
  () => previewable.value && workbench.isVisible('preview')
);
/** First visible editor line, followed by the Markdown preview. */
const syncLine = ref<number | null>(null);
/** State of the Code / Split / Viz quick switch. */
const mode = computed<ViewMode | null>(() => {
  const visual = graphVisible.value || previewVisible.value;
  if (codeVisible.value && visual) {
    return 'split';
  }

  return visual ? 'viz' : codeVisible.value ? 'code' : null;
});
const editable = computed(() => !isCoarse.value && !isMobile.value);

const editor = useTemplateRef<CodeEditorInstance>('editor');
const canvas = useTemplateRef<InstanceType<typeof GraphCanvas>>('canvas');

const text = ref(props.text);
/** The graph as shown: the parsed code plus graph-only edits. */
const doc = shallowRef<GraphDocument | null>(null);
/** The graph of the code alone. */
const parsedDoc = shallowRef<GraphDocument | null>(null);
/** Positions stored by the user (or server); everything else is auto-laid. */
const pinned = shallowRef<Positions>({});
const positions = shallowRef<Positions>({});
const selection = ref<string[]>([]);
/** The edits of the last op and the text they were made on. */
let lastOpEdits: { base: string; edits: ReadonlyArray<TextEdit> } | null = null;
let pendingPlacement: PendingPlacement | null = null;

const route = useRoute();
const router = useRouter();

const client = new GraphClient();
onBeforeUnmount(() => client.dispose());

const {
  resolveReference,
  fileLinks,
  references,
  importedNames,
  importTarget,
  canOpenImport,
  openImport,
  updateReferences,
  updateImports,
  onActionMenu,
  externals,
  declarations: importDeclarations,
} = useImports({
  props,
  client,
  doc,
  text,
  visualizable,
  parseSeq: () => parseSeq,
  reparse: () => reparse(),
  open: (path, symbol) => emit('open', path, symbol),
});

const selectedImportPath = computed(() => {
  const symbol = selectedSymbol.value;
  if (symbol?.kind !== 'import') {
    return undefined;
  }

  const target = importTarget(symbol);
  return target === undefined ? undefined : (target?.path ?? null);
});

const {
  saving,
  codeHistory,
  canUndo,
  canRedo,
  persist,
  applyLayoutPatch,
  undo,
  redo,
  recordOverlay,
  recordOverlayCode,
  onLayoutChange,
  boxColorOf,
  setBoxColor,
  resetLayout,
  resetAllLayout,
} = useLayoutHistory({
  layoutStore: () => props.layoutStore,
  pinned,
  positions,
  relayout,
  currentPositions: () => canvas.value?.getPositions(),
  undoCode: () => editor.value?.undo(),
  redoCode: () => editor.value?.redo(),
  setOverlay: (overlay) => setOverlay(overlay),
  show,
});

const {
  overlay,
  issues: syncIssues,
  outOfSync,
  syncNodes,
  syncProblems,
  addEdits,
  addFloating,
  setOverlay,
  discard: discardGraphChanges,
  resolve: resolveOverlay,
} = useGraphOverlay(
  {
    path: () => props.path,
    text,
    client,
    imports: () => importDeclarations(),
    doc,
    writeCode: (next) => {
      const edits = diffEdits(text.value, next);
      lastOpEdits = { base: text.value, edits };
      editor.value?.applyEdits(edits);
    },
    changed: (next) => {
      if (parsedDoc.value) {
        doc.value = applyOverlay(parsedDoc.value, next);
        relayout();
      }

      emit('update:overlay', next);
      void resolveOverlay();
    },
    record: (before, after) => recordOverlay(before, after),
    // The editor reports its new version in a microtask.
    recordCode: () => queueMicrotask(recordOverlayCode),
    placeFloating: (edit, world) => {
      movePinned(floatingLayout(edit, world));
      // Selected like any node just placed (once the overlay shows them).
      const ids = edit.nodes.map((n) => n.id);
      void nextTick(() => {
        canvas.value?.setSelection(ids);
        onSelectionChange(ids);
      });
    },
    placed: (ids) => {
      const moved: Positions = {};
      for (const [from, to] of Object.entries(ids)) {
        const p = pinned.value[from];
        if (p) {
          moved[to] = p;
        }
      }

      movePinned(moved);
    },
    show,
  },
  props.overlay
);

/** Pins positions without an undo step (like placing new nodes). */
function movePinned(patch: Positions): void {
  if (Object.keys(patch).length > 0) {
    pinned.value = { ...pinned.value, ...patch };
    void persist(patch);
  }
}
watch(outOfSync, (value) => emit('out-of-sync', value), { immediate: true });
watch(
  () => props.overlay,
  (value) => {
    if (value && value !== overlay.value) {
      setOverlay(value);
    }
  }
);

const {
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
} = useFocusMode({ stateKey: () => props.stateKey, doc, canvas });
const { canvasDoc, throughVias, beforeOp, afterParse } = useViaWires({
  shownDoc,
  pinned,
});
const {
  selectedSymbol,
  onSelectionChange,
  selectSymbol,
  openSymbol,
  revealSymbol,
  onScriptOp,
  revealRange,
  selectNodes,
  selectFunction,
  onHoverChange,
  onCursor,
  revealSourceLine,
  onActivate,
} = useCodeGraphSync({
  doc,
  selection,
  editor,
  canvas,
  codeVisible,
  graphVisible,
  focus: { focusFn, focusFunction, hiddenFunctionOf },
  onOp,
});
const breadcrumbVisible = computed(
  () =>
    focusedFunction.value !== undefined ||
    focusBack.value.length > 0 ||
    focusAhead.value.length > 0
);

// ---------------------------------------------------- go to definition

function describeDefinition(nodeId: string): string | undefined {
  return describeTarget(
    findDefinitionTarget(
      doc.value,
      text.value,
      references.value,
      resolveReference,
      nodeId
    )
  );
}

async function goToDefinition(nodeId: string): Promise<void> {
  const target = findDefinitionTarget(
    doc.value,
    text.value,
    references.value,
    resolveReference,
    nodeId
  );
  if (!target) {
    show('No definition found for this node.');
    return;
  }

  if (target.kind === 'file') {
    emit('open', target.path, target.symbol);
    return;
  }

  // UE opens the graph of a function or collapsed graph.
  await focusFunction(target.fnId);
  await selectNodes([target.nodeId]);
  await onActivate(target.nodeId);
}

/**
 * Where the graph of an entry node is used: the nodes whose Go to
 * definition leads to it (a callback's node, the calls of a function).
 */
function usagesOf(entryId: string): Array<{ nodeId: string; label: string }> {
  const d = doc.value;
  const fn = d?.functions.find((f) => f.nodes.some((n) => n.id === entryId));
  if (!d || !fn) {
    return [];
  }

  return d.functions.flatMap((other) =>
    other.nodes
      .filter((node) => {
        if (node.kind !== 'call' && node.kind !== 'functionRef') {
          return false;
        }

        const target = findDefinitionTarget(
          d,
          text.value,
          references.value,
          resolveReference,
          node.id
        );
        return target?.kind === 'node' && target.fnId === fn.id;
      })
      .map((node) => ({
        nodeId: node.id,
        label: `${other.name} · line ${text.value.slice(0, node.range.start).split('\n').length}`,
      }))
  );
}

/** Shows a node of any function, switching the focused graph if needed. */
async function jumpTo(nodeId: string): Promise<void> {
  await selectNodes([nodeId]);
}

/**
 * Double-click on a node: a call or callback opens the graph it leads to
 * (UE's double-click on a function or collapsed graph node); other nodes
 * show their code.
 */
async function onNodeActivate(nodeId: string): Promise<void> {
  const node = doc.value ? findNode(doc.value, nodeId) : undefined;
  if (
    (node?.kind === 'call' || node?.kind === 'functionRef') &&
    describeDefinition(nodeId) !== undefined
  ) {
    await goToDefinition(nodeId);
    return;
  }

  await onActivate(nodeId);
}

/** Definition to show once the file is parsed (`?symbol=` from a link). */
let pendingSymbol =
  typeof route.query.symbol === 'string' ? route.query.symbol : null;

async function revealPendingSymbol(): Promise<void> {
  const symbol = pendingSymbol;
  if (!symbol || (visualizable.value && !doc.value)) {
    return;
  }

  if (codeVisible.value && !editor.value) {
    // The editor loads lazily; it calls again when it is ready.
    return;
  }

  pendingSymbol = null;
  const { symbol: _, ...query } = route.query;
  void router.replace({ query });
  const range = findDefinition(doc.value, text.value, symbol);
  if (!range) {
    show(`${symbol} was not found in this file.`);
    return;
  }

  const fn = doc.value?.functions.find(
    (f) => f.range.start === range.start && f.range.end === range.end
  );
  const entry = fn?.nodes.find((n) => n.kind === 'entry');
  if (entry && graphVisible.value) {
    await nextTick();
    canvas.value?.selectNodes([entry.id]);
  }

  // Once a freshly mounted editor has its size, show the definition near
  // the top (this also ends the scroll started by the node selection).
  await new Promise(requestAnimationFrame);
  const line = text.value.slice(0, range.start).split('\n').length;
  editor.value?.revealLine(line, true);
}

watch(editor, () => void revealPendingSymbol());

const {
  diagnostics,
  parserDiagnostics,
  problems,
  allProblems,
  nodeProblems,
  problemCounts,
  showProblem,
} = useProblems({
  path: () => props.path,
  doc,
  editor,
  canvas,
  codeVisible,
  graphVisible,
  extra: () => syncProblems.value,
});

// ------------------------------------------------------------------ parse

const layoutOptions = {
  sizeOf: (node: GraphNode) =>
    canvas.value?.sizeOf(node) ?? { width: 160, height: 60 },
  spaceAbove: (node: GraphNode) => canvas.value?.spaceAbove(node) ?? 0,
  commentBoxTop: COMMENT_BOX_TOP,
};

function relayout(): void {
  if (!doc.value) {
    return;
  }

  positions.value = {
    ...layoutDocument(doc.value, layoutOptions, pinned.value),
    ...rerouteEntries(pinned.value),
    ...boxColorEntries(pinned.value),
  };
}

/**
 * Positions of nodes that disappeared (deleted, cut): undo and redo bring
 * them back to where they were.
 */
const positionMemory: Positions = {};

let parseSeq = 0;
/** The text `doc` was parsed from (ranges of `doc` point into it). */
const docText = ref('');
async function reparse(): Promise<void> {
  if (!visualizable.value) {
    return;
  }

  const seq = ++parseSeq;
  const source = text.value;
  let next: GraphDocument;
  try {
    next = await client.parse(source, props.path, importDeclarations());
  } catch (error) {
    show(`Parsing failed: ${(error as Error).message}`, 'error');
    return;
  }

  if (seq !== parseSeq) {
    return;
  }

  const previous = doc.value;
  const previousParsed = parsedDoc.value;

  // Nodes are followed through the op's edits when this parse is its
  // result, else through the change of the text (typing, undo, redo).
  const change = {
    before: docText.value,
    edits:
      lastOpEdits && lastOpEdits.base === docText.value
        ? lastOpEdits.edits
        : diffEdits(docText.value, source),
  };
  lastOpEdits = null;

  // Graph-only edits follow the code's nodes, like positions do.
  if (previousParsed && overlay.value.edits.length > 0) {
    const remapped = remapOverlay(previousParsed, next, overlay.value, change);
    if (remapped.dropped > 0) {
      show(
        `${remapped.dropped} graph-only change${remapped.dropped === 1 ? '' : 's'} no longer match the code and were dropped.`
      );
    }

    overlay.value = remapped.overlay;
    emit('update:overlay', remapped.overlay);
  }

  const shown = applyOverlay(next, overlay.value);
  parsedDoc.value = next;
  // A renamed function keeps the focus (its id follows the name).
  followRename(previous, shown);

  pinned.value = previous
    ? {
        ...reconcilePositions(
          previous,
          shown,
          pinned.value,
          change,
          positionMemory
        ),
        ...reconcileReroutes(previous, shown, pinned.value, change),
        ...reconcileVias(previous, shown, pinned.value, change),
        ...boxColorEntries(pinned.value),
      }
    : pinned.value;
  // Wired from a SET's output: the new Get is drawn as that wire (UE).
  const vias = afterParse(previous ?? undefined, shown, change);
  if (Object.keys(vias).length > 0) {
    pinned.value = { ...pinned.value, ...vias };
    void persist(vias);
  }

  let selectAfter: string[] | undefined;
  if (pendingPlacement) {
    const placement = pendingPlacement;
    pendingPlacement = null;
    const result = placeNewNodes(
      placement,
      previous,
      shown,
      change,
      source,
      pinned.value,
      layoutOptions
    );
    if (result.placed) {
      pinned.value = { ...pinned.value, ...result.placed };
      void persist(result.placed);
    }

    selectAfter = result.selectAfter;
  }

  doc.value = shown;
  docText.value = source;
  relayout();
  void resolveOverlay();
  if (props.files) {
    void updateReferences(seq);
  } else {
    // No repository (playground): libraries only.
    void updateImports(seq);
  }

  void revealPendingSymbol();

  // Keep the selection on nodes whose own text changed (e.g. an edited value).
  if (previous && selection.value.length > 0) {
    const renamed = renamedNodes(previous, shown);
    const before = selection.value;
    const kept = before
      .map((id) => renamed.get(id) ?? id)
      .filter((id) => findNode(shown, id) !== undefined);
    await nextTick();
    // Unless something else was selected meanwhile (a new symbol of My Script).
    if (selection.value === before) {
      canvas.value?.setSelection(kept);
      if (kept.join() !== selection.value.join()) {
        onSelectionChange(kept);
      }
    }
  }

  if (selectAfter) {
    await nextTick();
    canvas.value?.setSelection(selectAfter);
    onSelectionChange(selectAfter);
  }
}

const reparseDebounced = useDebounceFn(reparse, 150);

watch(
  () => props.text,
  (value) => {
    if (value !== text.value) {
      text.value = value;
      void reparse();
    }
  }
);

function onCodeChange(value: string): void {
  text.value = value;
  emit('update:text', value);
  void reparseDebounced();
}

// ------------------------------------------------------------------ reset

/** The saved version, parsed once (reset ↶ in Details). */
const baseDoc = shallowRef<GraphDocument | null>(null);
watch(
  () => props.baseText,
  async (base) => {
    baseDoc.value =
      base === undefined || !visualizable.value
        ? null
        : await client.parse(base, props.path).catch(() => null);
  },
  { immediate: true }
);

// ------------------------------------------------------- My Script

/** Types and modifiers of the file's language (for the Details panel). */
const typeSystem = shallowRef<TypeSystemInfo | null>(null);
watch(
  () => props.path,
  async (path) => {
    typeSystem.value = visualizable.value
      ? await client.typeSystem(path).catch(() => null)
      : null;
  },
  { immediate: true }
);

const nodeSymbol = computed(() => variableOfNode(doc.value, selection.value));

/** Nodes using the selected symbol, highlighted like UE does. */
const symbolUses = computed(() =>
  selectedSymbol.value ? symbolNodes(doc.value, selectedSymbol.value) : []
);
watch(symbolUses, (ids) => canvas.value?.setHighlight(ids));
/** Uses without the function's own entry node (highlighted, not counted). */
const symbolUseCount = computed(
  () =>
    symbolUses.value.filter(
      (id) =>
        (doc.value ? findNode(doc.value, id)?.kind : undefined) !== 'entry'
    ).length
);

/** Function whose local variables "My Script" lists. */
const currentFunction = computed(() =>
  currentFunctionOf(
    doc.value,
    selectedSymbol.value,
    selection.value,
    focusFn.value
  )
);

/**
 * Like Blueprints, editing must not move other nodes: pins the current auto
 * layout first (it looks the same, so no undo step). Otherwise a node
 * placed relative to an edited one would jump.
 */
function freezeLayout(): void {
  const current = canvas.value?.getPositions() ?? positions.value;
  const freeze: LayoutPatch = {};
  for (const [id, p] of Object.entries(current)) {
    if (!pinned.value[id]) {
      freeze[id] = p;
    }
  }

  if (Object.keys(freeze).length > 0) {
    applyLayoutPatch(freeze);
  }
}

async function onOp(requested: GraphOp): Promise<void> {
  if (!editable.value) {
    return;
  }

  // A wire drawn from a SET stands for a Get node in the code.
  const op = throughVias(requested);

  // Wires and deletions the code can't follow stay in the graph (like UE's
  // graphs, which may be in states that don't compile). While the graph has
  // such edits, the next ones join them, so the code follows what is shown.
  const graphEdits = doc.value ? graphEditsFor(doc.value, op) : undefined;
  if (outOfSync.value && graphEdits) {
    freezeLayout();
    addEdits(graphEdits);
    return;
  }

  beforeOp(op, doc.value);
  const result = await client.applyOp(
    text.value,
    props.path,
    op,
    importDeclarations()
  );
  if (!result.ok) {
    if (graphEdits) {
      freezeLayout();
      addEdits(graphEdits);
    } else if (op.type === 'addNode' && !op.after && !op.before) {
      // No place in the code (e.g. a GDScript class body): it floats in
      // the graph until it is wired in, like a new node in UE.
      freezeLayout();
      await addFloating(
        op.template,
        op.position ?? { x: 0, y: 0 },
        // Shown with the function in focus, else with the class body.
        focusFn.value ?? topLevelGraph(parsedDoc.value, text.value)?.id
      );
    } else if (JSON.stringify(op).includes('"overlay:')) {
      show('This node is not in the code yet: wire it in first.', 'error');
    } else {
      show(result.error, 'error');
    }

    return;
  }

  if (result.edits.length === 0) {
    return;
  }

  // New nodes go where the wire was dropped or the menu was opened.
  const placement = placementFor(op, doc.value);
  if (placement) {
    pendingPlacement = placement;
  }

  freezeLayout();
  lastOpEdits = { base: text.value, edits: result.edits };
  editor.value?.applyEdits(result.edits);

  // Like UE, nothing stays selected after a delete (entry nodes would).
  if (op.type === 'deleteNodes') {
    canvas.value?.setSelection([]);
    onSelectionChange([]);
  }
}

onMounted(async () => {
  if (props.layoutStore) {
    try {
      pinned.value = await props.layoutStore.load();
    } catch (error) {
      show(`Loading the layout failed: ${(error as Error).message}`, 'error');
    }
  }

  await reparse();
});

defineExpose({ frameAll: () => canvas.value?.frameAll() });
</script>

<template>
  <div data-ui="script-workspace" class="shrink-0">
    <div
      data-ui="workspace-toolbar"
      class="flex h-10 shrink-0 items-center gap-2 border-b border-zinc-800 bg-zinc-950 px-2"
    >
      <slot name="toolbar" />
      <div class="ml-auto flex items-center gap-2">
        <button
          v-if="graphVisible"
          type="button"
          class="btn-ghost px-2"
          :class="{
            'bg-zinc-800 text-zinc-100': workbench.isVisible('details'),
          }"
          title="Details panel"
          aria-label="Details panel"
          :aria-pressed="workbench.isVisible('details')"
          @click="workbench.toggle('details')"
        >
          <span class="i-mdi-dock-right" />
        </button>
        <LayoutMenu v-if="!isMobile" />
      </div>
    </div>

    <EditorActions
      :editable="editable"
      :can-undo="canUndo"
      :can-redo="canRedo"
      :graph-visible="graphVisible"
      :visualizable="visualizable"
      :previewable="previewable"
      :mode="mode"
      :hide-share="hideShare"
      @undo="undo"
      @redo="redo"
      @find="canvas?.openSearch()"
      @select-all="canvas?.selectAll()"
      @frame-selection="canvas?.frameSelection()"
      @frame-all="canvas?.frameAll()"
      @reset-layout="resetAllLayout"
    />

    <WorkspaceStatus
      :problem-counts="problemCounts"
      :saving="layoutStore ? saving : null"
      :out-of-sync="outOfSync"
    />

    <WorkbenchView id="code">
      <CodeEditor
        ref="editor"
        :path="path"
        :value="text"
        :read-only="!editable"
        :links="fileLinks"
        :diagnostics="parserDiagnostics"
        :keep-model="keepEditor"
        @problems="problems = $event"
        @change="onCodeChange"
        @cursor="onCursor"
        @history="codeHistory = $event"
        @scroll-line="syncLine = $event"
      />
    </WorkbenchView>

    <WorkbenchView v-if="visualizable" id="graph">
      <div class="relative h-full w-full">
        <GraphBreadcrumb
          v-if="breadcrumbVisible"
          :path="path"
          :focused="focusedFunction?.name"
          :parents="parentGraphs(doc, focusedFunction?.id)"
          :can-back="focusBack.length > 0"
          :can-forward="focusAhead.length > 0"
          @navigate="navigateFocus"
          @show-all="focusFunction(null)"
          @open="focusFunction"
        />
        <GraphCanvas
          ref="canvas"
          :doc="canvasDoc"
          :text="text"
          :positions="positions"
          :editable="editable"
          :initial-camera="initialCamera"
          :definition-of="describeDefinition"
          :usages-of="usagesOf"
          :problems="nodeProblems"
          :sync-nodes="syncNodes"
          :imports="importedNames"
          :externals="externals"
          :types="typeSystem"
          @selection-change="onSelectionChange"
          @hover-change="onHoverChange"
          @layout-change="onLayoutChange"
          @reset-layout="resetLayout"
          @op="onOp"
          @action-menu="onActionMenu"
          @open-function="focusFunction"
          @navigate="navigateFocus"
          @activate="onNodeActivate"
          @go-to-definition="goToDefinition"
          @jump-to="jumpTo"
          @camera-change="onCameraChange"
          @undo="undo"
          @redo="redo"
        />
        <button
          v-if="diagnostics.length > 0"
          type="button"
          class="absolute left-3 max-w-md rounded-md border border-red-900 bg-red-950/90 px-3 py-1.5 text-left text-xs text-red-200 hover:bg-red-950"
          :class="breadcrumbVisible ? 'top-12' : 'top-3'"
          @click="workbench.show('problems')"
        >
          {{ diagnostics.length }} syntax error{{
            diagnostics.length === 1 ? '' : 's'
          }}
          — the graph may be incomplete.
          <span class="text-red-300/80">{{ diagnostics[0]?.message }}</span>
        </button>
        <div
          v-if="outOfSync"
          data-ui="graph-sync-warning"
          role="status"
          class="absolute left-3 flex max-w-lg items-start gap-2 rounded-md border border-amber-800 bg-amber-950/90 px-3 py-1.5 text-xs text-amber-100"
          :class="
            diagnostics.length > 0
              ? breadcrumbVisible
                ? 'top-22'
                : 'top-13'
              : breadcrumbVisible
                ? 'top-12'
                : 'top-3'
          "
        >
          <span class="i-mdi-sync-alert mt-0.5 shrink-0 text-amber-400" />
          <span class="min-w-0">
            Graph not in sync with the code —
            {{ overlay.edits.length }} graph-only change{{
              overlay.edits.length === 1 ? '' : 's'
            }}. Saving is blocked until the graph is valid.
            <span v-if="syncIssues[0]" class="block text-amber-300/80">{{
              syncIssues[0].message
            }}</span>
          </span>
          <button
            v-if="syncNodes.size > 0"
            type="button"
            class="btn-ghost shrink-0 px-1.5 py-0 text-amber-200"
            @click="selectNodes([...syncNodes])"
          >
            Show
          </button>
          <button
            type="button"
            class="btn-ghost shrink-0 px-1.5 py-0 text-amber-200"
            title="Drop the graph-only changes; the graph shows the code again"
            @click="discardGraphChanges"
          >
            Discard
          </button>
        </div>
        <div
          v-if="selection.length > 1"
          class="pointer-events-none absolute bottom-3 left-3 rounded bg-zinc-900/80 px-2 py-1 text-xs text-zinc-400"
        >
          {{ selection.length }} nodes selected
        </div>
        <div
          v-if="!editable"
          class="pointer-events-none absolute top-3 right-3 rounded bg-zinc-900/80 px-2 py-1 text-xs text-zinc-400"
        >
          View only on small screens
        </div>
      </div>
    </WorkbenchView>

    <WorkbenchView id="problems">
      <ProblemsPanel
        :problems="allProblems"
        :path="path"
        @select="showProblem"
      />
    </WorkbenchView>

    <WorkbenchView v-if="previewable" id="preview">
      <MarkdownPreview
        :text="text"
        :path="path"
        :sync-line="syncLine"
        @reveal-line="revealSourceLine"
      />
    </WorkbenchView>

    <WorkbenchView v-if="visualizable" id="script">
      <MyScriptPanel
        :doc="doc"
        :text="text"
        :types="typeSystem"
        :selected-symbol="selectedSymbol?.id ?? null"
        :current-function="currentFunction"
        :editable="editable"
        :can-open-import="canOpenImport"
        @select-symbol="selectSymbol"
        @open-symbol="openSymbol"
        @open-import="openImport"
        @select-function="selectFunction"
        @select="selectNodes"
        @reveal="revealSymbol"
        @op="onScriptOp"
      />
    </WorkbenchView>

    <WorkbenchView v-if="visualizable" id="details">
      <DetailsPanel
        class="h-full"
        :doc="doc"
        :text="text"
        :selection="selection"
        :editable="editable"
        :closable="isMobile"
        :symbol="selection.length === 0 ? selectedSymbol : null"
        :node-symbol="nodeSymbol"
        :symbol-uses="symbolUseCount"
        :import-path="selectedImportPath"
        :box-color-of="boxColorOf"
        :base-doc="baseDoc"
        :base-text="baseText"
        :types="typeSystem"
        :doc-text="docText"
        @select="selectNodes"
        @select-function="selectFunction"
        @activate="onActivate"
        @reveal="revealRange"
        @open-symbol="openSymbol"
        @open-import="openImport"
        @select-symbol="selectSymbol"
        @box-color="setBoxColor"
        @op="onScriptOp"
        @close="workbench.hide('details')"
      />
    </WorkbenchView>
  </div>
</template>
