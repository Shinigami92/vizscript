<script setup lang="ts">
import { COMMENT_BOX_TOP } from '@vizscript/canvas';
import type {
  GraphDocument,
  GraphNode,
  GraphOverlay,
  Positions,
  TypeSystemInfo,
} from '@vizscript/core';
import {
  applyOverlay,
  boxColorEntries,
  diffEdits,
  findNode,
  layoutDocument,
  reconcileLayout,
  remapOverlay,
  renamedNodes,
  rerouteEntries,
  withCallViews,
} from '@vizscript/core';
import { useDebounceFn, useElementSize, useMediaQuery } from '@vueuse/core';
import {
  computed,
  defineAsyncComponent,
  nextTick,
  onBeforeUnmount,
  onMounted,
  provide,
  ref,
  shallowRef,
  useTemplateRef,
  watch,
} from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useToasts } from '../composables/use-toasts';
import { GraphClient } from '../graph/graph-client';
import { isPreviewable, isVisualizable } from '../graph/languages';
import { countedUses, symbolNodes } from '../graph/symbols';
import { isCancelled } from '../graph/worker-connection';
import { useWorkbenchStore } from '../stores/workbench';
import LayoutMenu from '../workbench/LayoutMenu.vue';
import WorkbenchView from '../workbench/WorkbenchView.vue';
import DetailsPanel from './DetailsPanel.vue';
import GraphCanvas from './GraphCanvas.vue';
import MyScriptPanel from './MyScriptPanel.vue';
import ProblemsPanel from './ProblemsPanel.vue';
import AddPackageMenu from './script-workspace/AddPackageMenu.vue';
import EditorActions from './script-workspace/EditorActions.vue';
import GraphBreadcrumb from './script-workspace/GraphBreadcrumb.vue';
import LanguageStatus from './script-workspace/LanguageStatus.vue';
import type { OpTransaction } from './script-workspace/op-transaction';
import {
  opTransaction,
  parseRole,
  textChange,
} from './script-workspace/op-transaction';
import {
  anchoredTo,
  floatingLayout,
  placeNewNodes,
} from './script-workspace/placement';
import {
  currentFunctionOf,
  functionOfNode,
  parentGraphs,
  variableOfNode,
} from './script-workspace/symbol-lookup';
import type {
  CodeEditorInstance,
  ScriptWorkspaceProps,
  ViewMode,
} from './script-workspace/types';
import { useCheckerTypes } from './script-workspace/use-checker-types';
import { useCodeGraphSync } from './script-workspace/use-code-graph-sync';
import { useDefinitions } from './script-workspace/use-definitions';
import { useDraftLayout } from './script-workspace/use-draft-layout';
import { useFocusMode } from './script-workspace/use-focus-mode';
import { useGraphOverlay } from './script-workspace/use-graph-overlay';
import { useImports } from './script-workspace/use-imports';
import { useKeptNodes } from './script-workspace/use-kept-nodes';
import { useLanguageVersion } from './script-workspace/use-language-version';
import { useLayoutHistory } from './script-workspace/use-layout-history';
import { useLibraryAdditions } from './script-workspace/use-library-additions';
import { useOpRunner } from './script-workspace/use-op-runner';
import { provideParseValue } from './script-workspace/use-parse-value';
import { usePinnedLayout } from './script-workspace/use-pinned-layout';
import { usePlacedLayout } from './script-workspace/use-placed-layout';
import { useProblems } from './script-workspace/use-problems';
import { useTypeLibs } from './script-workspace/use-type-libs';
import { useViaWires } from './script-workspace/use-via-wires';
import WorkspaceStatus from './script-workspace/WorkspaceStatus.vue';
import { TYPE_CHOICES } from './symbol-details/type-choices';

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
/** The last edit written into the code, until its result is parsed. */
let transaction: OpTransaction | null = null;

const route = useRoute();
const router = useRouter();

const client = new GraphClient();
onBeforeUnmount(() => client.dispose());

const { version: languageVersion, versionFiles } = useLanguageVersion({
  client,
  path: () => props.path,
  files: () => props.files,
  readFile: () => props.readFile,
});
const {
  moduleInfos,
  addingPackage,
  canAddPackage,
  addLibrary,
  restoreOtherFile,
} = useLibraryAdditions({
  props,
  doc,
  version: languageVersion,
  apply: (op) => onScriptOp(op),
  codeVersion: () => codeHistory.value.version,
  recordFileEdit: (edit, beforeVersion) => recordFileEdit(edit, beforeVersion),
});

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
  externalTypes,
  declarations: importDeclarations,
  packageOffer,
  localModules,
  localExports,
  withNeededImport,
  busy: importsBusy,
  forgetFiles: forgetImportFiles,
} = useImports({
  props,
  client,
  doc,
  text,
  visualizable,
  parseSeq: () => parseSeq,
  reparse: () => reparse(),
  open: (path, symbol) => emit('open', path, symbol),
  version: () => languageVersion.value?.text,
});

// Type pickers of Details offer other files' and libraries' types.
provide(TYPE_CHOICES, { types: externalTypes, load: onActionMenu });

const { busy: typesBusy, forgetFiles: forgetTypeFiles } = useTypeLibs({
  props,
  client,
  references,
  text,
});

/**
 * Problems may still change: imports or library types are being read, or
 * the repository's file list (for imported files) is still on its way.
 */
const checking = computed(
  () =>
    importsBusy.value ||
    typesBusy.value ||
    (props.readFile !== undefined && props.files === undefined)
);

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
  beforeCodeEdit,
  recordCodeLayout,
  parsed,
  recordOverlayCode,
  recordCodeOverlay,
  recordFileEdit,
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
  restoreFile: restoreOtherFile,
  show,
});
const placedLayout = usePlacedLayout({ pinned, recordCodeLayout });

const {
  overlay,
  issues: syncIssues,
  outOfSync,
  syncNodes,
  syncProblems,
  addEdits,
  followCode,
  addFloating,
  floatValueUse,
  floatPromote,
  floatReceiver,
  floatInput,
  floatLiteral,
  fillCutReceiver,
  setOverlay,
  discard: discardGraphChanges,
  resolve: resolveOverlay,
  restoreLoose,
} = useGraphOverlay(
  {
    pinned,
    patchLayout: (patch) => applyLayoutPatch(patch),
    path: () => props.path,
    text,
    client,
    imports: () => importDeclarations(),
    doc,
    writeCode: (next) => {
      const edits = diffEdits(text.value, next);
      transaction = opTransaction(text.value, edits, parseSeq);
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
    placeFloating: (edit, world, fixed, anchored, extra) => {
      const laid = floatingLayout(edit, world);
      movePinned({
        ...(anchored ? anchoredTo(laid, fixed) : laid),
        ...fixed,
        ...extra,
      });
      // Selected like any node just placed (once the overlay shows them).
      const ids = edit.nodes.map((n) => n.id);
      void nextTick(() => {
        canvas.value?.setSelection(ids);
        onSelectionChange(ids);
      });
    },
    positionOf: (id) => canvas.value?.getPositions()[id] ?? positions.value[id],
    typeFloating: (edit, source) => typeFloating(edit, source),
    containerOps: () => typeSystem.value?.containerOps,
    placed: (ids) => {
      placedNodes(ids);
      placedLayout.placed(ids);
    },
    writing: (written, wrote) => {
      placedLayout.writing(wrote);
      const kept = keepWired(written, wrote);
      if (Object.keys(kept).length > 0) {
        recordCodeLayout(kept);
      }
    },
    show,
  },
  props.overlay
);

const layoutLoaded = ref(false);
const draftLayout = useDraftLayout({
  key: () => props.stateKey,
  baseText: () => props.baseText,
  text: () => text.value,
  hasOverlay: () => overlay.value.edits.length > 0,
  pinned,
  loaded: () => layoutLoaded.value,
  applyLayoutPatch,
});

const { movePinned, freezeLayout } = usePinnedLayout({
  pinned,
  positions,
  canvasPositions: () => canvas.value?.getPositions(),
  persist: (patch) => persist(patch),
  applyLayoutPatch,
});
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
const layoutOptions = {
  sizeOf: (node: GraphNode) =>
    canvas.value?.sizeOf(node) ?? { width: 160, height: 60 },
  spaceAbove: (node: GraphNode) => canvas.value?.spaceAbove(node) ?? 0,
  commentBoxTop: COMMENT_BOX_TOP,
};

const {
  canvasDoc,
  throughVias,
  viaProblems,
  keepWired,
  placedNodes,
  beforeOp,
  cancelOp: cancelViaOp,
  afterParse,
} = useViaWires({
  // Container nodes the user shows as their calls (`~call|…`).
  shownDoc: computed(() =>
    shownDoc.value ? withCallViews(shownDoc.value, pinned.value) : null
  ),
  parsedDoc,
  pinned,
  autoLayout: (shown) => layoutDocument(shown, layoutOptions),
});
const keptNodes = useKeptNodes({
  parsedDoc: () => parsedDoc.value,
  drawnDoc: () => canvasDoc.value,
  text,
  path: () => props.path,
  client,
  imports: () => importDeclarations(),
  placeholder: () => typeSystem.value?.placeholder ?? 'undefined',
  positionOf: (id) => canvas.value?.getPositions()[id] ?? positions.value[id],
  typeFloating: (edit, source) => typeFloating(edit, source),
  overlay: () => overlay.value,
  keep: (before, after, layout) => {
    setOverlay(after);
    recordCodeOverlay(before, after, layout);
  },
  replace: (before, after, layout) => {
    recordOverlay(before, after);
    setOverlay(after);
    applyLayoutPatch(layout);
  },
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
  onOp: (op) => onOp(op),
  textParsed: () => text.value === docText.value,
});
const breadcrumbVisible = computed(
  () =>
    focusedFunction.value !== undefined ||
    focusBack.value.length > 0 ||
    focusAhead.value.length > 0
);
/**
 * How far the notices (breadcrumb, syntax errors, out-of-sync banner) reach
 * into the canvas: their column's top offset, height and a gap.
 */
const { height: noticesHeight } = useElementSize(useTemplateRef('notices'));
const noticesInset = computed(() =>
  noticesHeight.value > 0 ? noticesHeight.value + 16 : 0
);

// ---------------------------------------------------- go to definition

const {
  describeDefinition,
  goToDefinition,
  usagesOf,
  jumpTo,
  onNodeActivate,
  revealPendingSymbol,
} = useDefinitions({
  doc,
  docText: () => docText.value,
  references,
  resolveReference,
  editor,
  canvas,
  visualizable,
  codeVisible,
  graphVisible,
  route,
  router,
  focusFunction,
  selectNodes,
  onActivate,
  open: (path, symbol) => emit('open', path, symbol),
  show,
});

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

function relayout(): void {
  if (!doc.value) {
    return;
  }

  positions.value = {
    ...layoutDocument(
      withCallViews(doc.value, pinned.value),
      layoutOptions,
      pinned.value
    ),
    ...rerouteEntries(pinned.value),
    ...boxColorEntries(pinned.value),
  };
}

/** Entries `after` has that `before` hasn't (or has elsewhere). */
function followedEntries(
  before: Positions,
  after: Positions
): Positions | undefined {
  const changed: Positions = {};
  for (const [id, p] of Object.entries(after)) {
    const was = before[id];
    if (!was || was.x !== p.x || was.y !== p.y) {
      changed[id] = p;
    }
  }

  return Object.keys(changed).length > 0 ? changed : undefined;
}

/**
 * Positions of nodes that disappeared (deleted, cut): undo and redo bring
 * them back to where they were.
 */
const positionMemory: Positions = {};

let parseSeq = 0;
/** The text `doc` was parsed from (ranges of `doc` point into it). */
const docText = ref('');

const { refineTypes, checkedFor, typeFloating } = useCheckerTypes({
  path: () => props.path,
  parsedDoc,
  docText,
  parseSeq: () => parseSeq,
  apply: (typed) => {
    parsedDoc.value = typed;
    doc.value = applyOverlay(typed, overlay.value);
    // Typed nodes change: container nodes leave the exec chain, calls get
    // their parameter pins. Generated positions follow, pinned ones stay.
    relayout();
  },
  containerOps: () => typeSystem.value?.containerOps,
});

async function reparse(): Promise<void> {
  if (!visualizable.value) {
    return;
  }

  const seq = ++parseSeq;
  const source = text.value;
  let next: GraphDocument;
  try {
    // A newer text replaces this parse while it still waits.
    next = await client.parse(source, props.path, importDeclarations(), {
      key: 'editor',
    });
  } catch (error) {
    if (!isCancelled(error)) {
      show(`Parsing failed: ${(error as Error).message}`, 'error');
    }

    return;
  }

  if (seq !== parseSeq) {
    return;
  }

  const previous = doc.value;
  const previousParsed = parsedDoc.value;

  // A parse started before an op's edits were written leaves the op's
  // notes to the parse of its result.
  const role = parseRole(transaction, seq);
  const written = role === 'result' ? transaction : null;
  if (written) {
    transaction = null;
  }

  // Nodes are followed through the op's edits when this parse is its
  // result, else through the change of the text (typing, undo, redo).
  const change = textChange(written, docText.value, source);

  // Graph-only edits follow the code's nodes, like positions do.
  if (previousParsed && overlay.value.edits.length > 0) {
    const remapped = remapOverlay(previousParsed, next, overlay.value, change);
    if (remapped.dropped > 0) {
      show(
        `${remapped.dropped} graph-only change${remapped.dropped === 1 ? '' : 's'} no longer match the code and were dropped.`
      );
    }

    followCode(remapped.overlay);
    emit('update:overlay', remapped.overlay);
  }

  const shown = applyOverlay(next, overlay.value);
  parsedDoc.value = next;
  // A renamed function keeps the focus (its id follows the name).
  followRename(previous, shown);

  if (previous) {
    const before = pinned.value;
    pinned.value = reconcileLayout(
      previous,
      shown,
      before,
      change,
      positionMemory
    );
    // Positions that followed their nodes to new ids are saved under them,
    // or a reload finds the nodes without a place. Entries of nodes that
    // are gone stay stored: undo, a discarded draft or another branch may
    // bring the old code back.
    const followed = followedEntries(before, pinned.value);
    if (followed) {
      void persist(followed);
    }
  }

  draftLayout.afterParse();

  placedLayout.afterParse(written !== null);
  if (role !== 'earlier') {
    // Wired from a SET's output: the new Get is drawn as that wire (UE).
    const vias = afterParse(previous ?? undefined, shown, change);
    if (Object.keys(vias).length > 0) {
      recordCodeLayout(vias);
    }

    keptNodes.afterParse(next, change);
  }

  parsed();

  let selectAfter: string[] | undefined;
  const placement = written?.placement;
  if (placement) {
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
  refineTypes(seq, source, next);
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
        : await client
            .parse(base, props.path, undefined, { background: true })
            .catch(() => null);
  },
  { immediate: true }
);

// ------------------------------------------------------- My Script

/** Types and modifiers of the file's language (for the Details panel). */
const typeSystem = shallowRef<TypeSystemInfo | null>(null);

// A function input's default is no node: Details edits it in a host file.
provideParseValue({
  client,
  text,
  typeSystem,
  path: () => props.path,
  imports: () => importDeclarations(),
});
watch(
  () => props.path,
  async (path) => {
    typeSystem.value = visualizable.value
      ? await client.typeSystem(path).catch(() => null)
      : null;
  },
  { immediate: true }
);

const nodeSymbol = computed(
  () =>
    variableOfNode(doc.value, selection.value) ??
    functionOfNode(doc.value, selection.value)
);

/** Nodes using the selected symbol, highlighted like UE does. */
const symbolUses = computed(() =>
  selectedSymbol.value ? symbolNodes(doc.value, selectedSymbol.value) : []
);
watch(symbolUses, (ids) => canvas.value?.setHighlight(ids));
/** Uses without the symbol's own declaration (highlighted, not counted). */
const symbolUseCount = computed(() =>
  selectedSymbol.value
    ? countedUses(doc.value, selectedSymbol.value, symbolUses.value)
    : 0
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

const { onOp } = useOpRunner({
  editable: () => editable.value,
  text: () => text.value,
  parsedText: () => docText.value,
  reparse,
  doc: () => doc.value,
  parsedDoc: () => parsedDoc.value,
  focusFn: () => focusFn.value,
  outOfSync: () => outOfSync.value,
  placeholder: () => typeSystem.value?.placeholder ?? 'undefined',
  vias: { throughVias, beforeOp, cancelOp: cancelViaOp },
  keptNodes,
  overlay: {
    addEdits,
    addFloating,
    fillCutReceiver,
    floatInput,
    floatLiteral,
    floatReceiver,
    floatValueUse,
    floatPromote,
  },
  freezeLayout,
  beforeCodeEdit,
  applyOp: (base, op) =>
    client.applyOp(
      base,
      props.path,
      op,
      importDeclarations(),
      checkedFor(base)
    ),
  write: (base, edits, placement) => {
    transaction = opTransaction(base, edits, parseSeq, placement);
    editor.value?.applyEdits(edits);
  },
  deselect: () => {
    canvas.value?.setSelection([]);
    onSelectionChange([]);
  },
  show,
});

// The repository's file list can arrive after the file (it loads alongside
// it): imports resolve to files then, and libraries get their versions. A
// newer list (the branch moved since the kept one, files created or
// renamed) may change imported files. Either way, what was read without
// it is read again.
watch(
  () => props.files,
  (now) => {
    if (now !== undefined) {
      forgetImportFiles();
      forgetTypeFiles();
      void reparse();
    }
  }
);

onMounted(async () => {
  if (props.layoutStore) {
    try {
      pinned.value = await props.layoutStore.load();
    } catch (error) {
      show(`Loading the layout failed: ${(error as Error).message}`, 'error');
    }
  }

  layoutLoaded.value = true;

  await reparse();
  await restoreLoose();
});

defineExpose({
  frameAll: () => canvas.value?.frameAll(),
  /** The draft is being discarded: its layout goes with it. */
  discardLayout: () => draftLayout.discard(),
});
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
      :checking="checking"
      :saving="layoutStore ? saving : null"
      :out-of-sync="outOfSync"
    />
    <LanguageStatus
      :path="path"
      :version="languageVersion"
      :version-files="versionFiles"
      :has-project="files !== undefined"
      @open="emit('open', $event)"
    />

    <WorkbenchView id="code">
      <CodeEditor
        ref="editor"
        :path="path"
        :value="text"
        :read-only="!editable"
        :links="fileLinks"
        :diagnostics="parserDiagnostics"
        :keep-scope="editorScope"
        :base-text="baseText"
        @problems="problems = $event"
        @change="onCodeChange"
        @cursor="onCursor"
        @history="codeHistory = $event"
        @scroll-line="syncLine = $event"
      />
    </WorkbenchView>

    <WorkbenchView v-if="visualizable" id="graph">
      <div class="relative h-full w-full">
        <GraphCanvas
          ref="canvas"
          :doc="canvasDoc"
          :text="docText"
          :positions="positions"
          :editable="editable"
          :initial-camera="initialCamera"
          :top-inset="noticesInset"
          :definition-of="describeDefinition"
          :usages-of="usagesOf"
          :problems="viaProblems(nodeProblems)"
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
        <!-- Notices over the canvas's top; framing keeps nodes below them. -->
        <div
          ref="notices"
          data-ui="graph-notices"
          class="pointer-events-none absolute top-2 left-2 z-10 flex max-w-[calc(100%-1rem)] flex-col items-start gap-2"
        >
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
          <button
            v-if="diagnostics.length > 0"
            type="button"
            class="pointer-events-auto max-w-md rounded-md border border-red-900 bg-red-950/90 px-3 py-1.5 text-left text-xs text-red-200 hover:bg-red-950"
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
            class="pointer-events-auto flex max-w-lg items-start gap-2 rounded-md border border-amber-800 bg-amber-950/90 px-3 py-1.5 text-xs text-amber-100"
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
        :checking="checking"
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
        :text="docText"
        :types="typeSystem"
        :selected-symbol="selectedSymbol?.id ?? null"
        :current-function="currentFunction"
        :editable="editable"
        :can-open-import="canOpenImport"
        :module-info="moduleInfos"
        :can-add-package="canAddPackage"
        @select-symbol="selectSymbol"
        @open-symbol="openSymbol"
        @open-import="openImport"
        @select-function="selectFunction"
        @select="selectNodes"
        @reveal="revealSymbol"
        @op="onScriptOp"
        @add-package="addingPackage = $event"
      />
      <AddPackageMenu
        v-if="addingPackage && editFile"
        :at="addingPackage"
        :path="path"
        :files="files"
        :read-file="readFile"
        :add-library="addLibrary"
        :offer="packageOffer"
        :list-only="addingPackage.library"
        :local-modules="localModules"
        :local-exports="localExports"
        :import-file="
          (request) => onScriptOp({ type: 'addImport', import: request })
        "
        @close="addingPackage = null"
      />
    </WorkbenchView>

    <WorkbenchView v-if="visualizable" id="details">
      <DetailsPanel
        class="h-full"
        :doc="doc"
        :text="docText"
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
        @select="selectNodes"
        @select-function="selectFunction"
        @activate="onActivate"
        @go-to-definition="goToDefinition"
        @reveal="revealRange"
        @open-symbol="openSymbol"
        @open-import="openImport"
        @select-symbol="selectSymbol"
        @box-color="setBoxColor"
        @op="(op) => void withNeededImport(op).then(onScriptOp)"
        @close="workbench.hide('details')"
      />
    </WorkbenchView>
  </div>
</template>
