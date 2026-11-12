<script setup lang="ts">
import type { Camera } from '@vizscript/canvas';
import {
  COMMENT_BOX_TOP,
  formatCameraParam,
  parseCameraParam,
} from '@vizscript/canvas';
import type {
  GraphDocument,
  GraphNode,
  GraphOp,
  LayoutPatch,
  ModuleReference,
  NodeTemplate,
  Point,
  Positions,
  ScriptSymbol,
  SourceRange,
  TypeSystemInfo,
} from '@vizscript/core';
import {
  findDefinition,
  findNode,
  findNodeAtOffset,
  isRerouteKey,
  layoutDocument,
  qualifiedName,
  reconcilePositions,
  reconcileReroutes,
  renamedNodes,
  rerouteEntries,
  resolveModuleReference,
} from '@vizscript/core';
import { useDebounceFn, useEventListener, useMediaQuery } from '@vueuse/core';
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
import {
  isPreviewable,
  isVisualizable,
  monacoLanguage,
} from '../graph/languages';
import type { LayoutStore } from '../graph/layout-store';
import type { Problem } from '../graph/problems';
import { problemsByNode } from '../graph/problems';
import { VIEW_PARAM } from '../graph/share';
import { shortcut } from '../graph/source';
import { symbolNodes } from '../graph/symbols';
import type { FileLinkSource } from '../monaco/file-links';
import { useWorkbenchStore } from '../stores/workbench';
import LayoutMenu from '../workbench/LayoutMenu.vue';
import WorkbenchView from '../workbench/WorkbenchView.vue';
import type { MenuEntry } from './ContextMenu.vue';
import ContextMenu from './ContextMenu.vue';
import DetailsPanel from './DetailsPanel.vue';
import GraphCanvas from './GraphCanvas.vue';
import MyScriptPanel from './MyScriptPanel.vue';
import ProblemsPanel from './ProblemsPanel.vue';
import ShareLink from './ShareLink.vue';

const CodeEditor = defineAsyncComponent(() => import('./CodeEditor.vue'));
const MarkdownPreview = defineAsyncComponent(
  () => import('./MarkdownPreview.vue')
);

export type ViewMode = 'code' | 'split' | 'viz';

const props = defineProps<{
  path: string;
  text: string;
  layoutStore: LayoutStore | null;
  /** Key for per-file view state (camera) in localStorage. */
  stateKey: string;
  /** Paths of the repository's files: imports of them open on Cmd+click. */
  files?: ReadonlySet<string>;
  /** Hide the share button (e.g. local folders, which have no shareable URL). */
  hideShare?: boolean;
  /** The file is open in a tab: keep its editor state when switching. */
  keepEditor?: boolean;
}>();

const emit = defineEmits<{
  'update:text': [text: string];
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

const editor =
  useTemplateRef<InstanceType<typeof import('./CodeEditor.vue').default>>(
    'editor'
  );
const canvas = useTemplateRef<InstanceType<typeof GraphCanvas>>('canvas');

const text = ref(props.text);
const doc = shallowRef<GraphDocument | null>(null);
/** Positions stored by the user (or server); everything else is auto-laid. */
const pinned = shallowRef<Positions>({});
const positions = shallowRef<Positions>({});
const selection = ref<string[]>([]);
const saving = ref<'idle' | 'saving' | 'saved' | 'error'>('idle');
let pendingPlacement: {
  world: Point;
  known: Set<string>;
  /** Prefers the node the user asked for over helper nodes of the edit. */
  matches?: (node: GraphNode) => boolean;
} | null = null;

/** Recognizes the node an `addNode` op creates (by kind and name). */
function templateMatcher(template: NodeTemplate): (node: GraphNode) => boolean {
  switch (template.type) {
    case 'call': {
      return (n) => n.kind === 'call' && n.title === template.callee;
    }

    case 'setVar': {
      return (n) => n.kind === 'setVar' && n.title === `Set ${template.name}`;
    }

    case 'branch': {
      return (n) => n.kind === 'branch';
    }

    case 'return': {
      return (n) => n.kind === 'return';
    }

    case 'value': {
      const expression = template.expression.trim();
      return (n) =>
        n.purity === 'pure' &&
        (n.title === expression || n.title === expression.split('.').at(-1));
    }
  }
}

const cameraKey = computed(() => `vizscript:camera:${props.stateKey}`);
const route = useRoute();
const router = useRouter();
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

const client = new GraphClient();
onBeforeUnmount(() => client.dispose());

function resolveReference(
  reference: ModuleReference
): { path: string; symbol?: string } | undefined {
  const files = props.files;
  const path = files
    ? resolveModuleReference(props.path, reference, (p) => files.has(p))
    : null;
  return path ? { path, symbol: reference.symbol } : undefined;
}

/** Import paths and uses of imported names that resolve to repository files. */
const fileLinks = computed<FileLinkSource | undefined>(() => {
  if (!props.files || !visualizable.value) {
    return undefined;
  }

  return {
    links: async (value) => {
      const references = await client.references(value, props.path);
      return references.flatMap((reference) => {
        const target = resolveReference(reference);
        return target ? [{ range: reference.range, ...target }] : [];
      });
    },
    open: (path, symbol) => emit('open', path, symbol),
  };
});

/** File references of the current text, for "Go to definition". */
const references = shallowRef<ModuleReference[]>([]);

/** Imported names used in the file, offered by the graph's action menu. */
const importedNames = computed(() => [
  ...new Set(
    references.value
      .filter((r) => r.symbol && !r.typeOnly)
      .map((r) => text.value.slice(r.range.start, r.range.end))
      .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name))
  ),
]);

/**
 * The file an import comes from and the name to open there; `null` when it
 * is not a repository file, `undefined` without a repository (playground).
 */
function importTarget(
  symbol: ScriptSymbol
): { path: string; symbol?: string } | null | undefined {
  if (!props.files || symbol.kind !== 'import') {
    return undefined;
  }

  const within = symbol.declarationRange ?? symbol.range;
  const paths = references.value.filter(
    (r) =>
      !r.symbol && r.range.start >= within.start && r.range.end <= within.end
  );
  // `from . import utils`: the name is a module itself.
  const submodule = paths.find((r) => r.specifier === symbol.imported);
  const reference =
    paths.find((r) => r.specifier === symbol.module) ?? submodule;
  const target = reference ? resolveReference(reference) : undefined;
  if (!target) {
    return null;
  }

  const name =
    reference === submodule ||
    symbol.imported === '*' ||
    symbol.imported === 'default'
      ? undefined
      : symbol.imported;
  return { path: target.path, ...(name ? { symbol: name } : {}) };
}

function canOpenImport(symbol: ScriptSymbol): boolean {
  return Boolean(importTarget(symbol));
}

function openImport(id: string): void {
  const symbol = doc.value?.symbols?.find((s) => s.id === id);
  const target = symbol ? importTarget(symbol) : undefined;
  if (target) {
    emit('open', target.path, target.symbol);
  }
}

const selectedImportPath = computed(() => {
  const symbol = selectedSymbol.value;
  if (symbol?.kind !== 'import') {
    return undefined;
  }

  const target = importTarget(symbol);
  return target === undefined ? undefined : (target?.path ?? null);
});

async function updateReferences(seq: number): Promise<void> {
  const refs = await client.references(text.value, props.path);
  if (seq === parseSeq) {
    references.value = refs;
  }
}

/** Where "Go to definition" of a node leads. */
export type DefinitionTarget =
  | { kind: 'file'; path: string; symbol?: string }
  | { kind: 'node'; nodeId: string; name: string };

const DEFINITION_KINDS = new Set([
  'call',
  'getVar',
  'functionRef',
  'getProperty',
  'unknown',
]);

function definitionOf(nodeId: string): DefinitionTarget | undefined {
  const d = doc.value;
  const node = d ? findNode(d, nodeId) : undefined;
  if (!d || !node || !DEFINITION_KINDS.has(node.kind)) {
    return undefined;
  }

  // Imported names used by the node itself (a call's callee, not its
  // arguments, which are nodes of their own).
  const paren = text.value.indexOf('(', node.range.start);
  const head =
    node.kind === 'call' && paren !== -1 && paren < node.range.end
      ? paren
      : node.range.end;
  const inside = references.value.filter(
    (r) => r.range.start >= node.range.start && r.range.end <= head
  );
  for (const reference of [
    ...inside.filter((r) => r.symbol),
    ...inside.filter((r) => !r.symbol),
  ]) {
    const target = resolveReference(reference);
    if (target) {
      return { kind: 'file', ...target };
    }
  }

  // A function of this file.
  if (node.kind === 'call' || node.kind === 'functionRef') {
    const name = node.title.replace(/^this\./, '');
    const own = d.functions.find((f) => f.nodes.includes(node));
    const fn =
      d.functions.find((f) => f !== own && f.name === name) ??
      d.functions.find((f) => f !== own && f.name.endsWith(`.${name}`));
    const entry = fn?.nodes.find((n) => n.kind === 'entry');
    if (fn && entry) {
      return { kind: 'node', nodeId: entry.id, name: fn.name };
    }
  }

  return undefined;
}

function describeDefinition(nodeId: string): string | undefined {
  const target = definitionOf(nodeId);
  if (!target) {
    return undefined;
  }

  if (target.kind === 'node') {
    return target.name;
  }

  const file = target.path.split('/').at(-1) ?? target.path;
  return target.symbol ? `${target.symbol} · ${file}` : file;
}

async function goToDefinition(nodeId: string): Promise<void> {
  const target = definitionOf(nodeId);
  if (!target) {
    show('No definition found for this node.');
    return;
  }

  if (target.kind === 'file') {
    emit('open', target.path, target.symbol);
    return;
  }

  canvas.value?.selectNodes([target.nodeId]);
  await onActivate(target.nodeId);
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

const diagnostics = computed(() => doc.value?.diagnostics ?? []);

// ---------------------------------------------------------------- problems

/** TypeScript and JavaScript are checked by the editor itself. */
const hasChecker = computed(() =>
  ['typescript', 'javascript'].includes(monacoLanguage(props.path))
);
/** Parser problems shown as editor markers (when there is no checker). */
const parserDiagnostics = computed(() =>
  hasChecker.value ? [] : diagnostics.value
);
/** Every problem of the file, from the editor's markers. */
const problems = shallowRef<Problem[]>([]);
const nodeProblems = computed(() => problemsByNode(doc.value, problems.value));
const problemCounts = computed(() => ({
  errors: problems.value.filter((p) => p.severity === 'error').length,
  warnings: problems.value.filter((p) => p.severity === 'warning').length,
}));

async function showProblem(problem: Problem): Promise<void> {
  if (!codeVisible.value) {
    workbench.show('code');
    await nextTick();
  }

  const node = [...nodeProblems.value].find(([, list]) =>
    list.includes(problem)
  )?.[0];
  if (node && graphVisible.value) {
    canvas.value?.selectNodes([node]);
  }

  // A code view that was just shown needs a frame to get its size.
  await new Promise(requestAnimationFrame);
  editor.value?.layout();
  editor.value?.reveal(problem.range, true);
}

// Like VS Code: Shift+Cmd+M (Shift+Ctrl+M) toggles the problems panel.
useEventListener(window, 'keydown', (event: KeyboardEvent) => {
  if (
    (event.metaKey || event.ctrlKey) &&
    event.shiftKey &&
    event.key.toLowerCase() === 'm'
  ) {
    event.preventDefault();
    workbench.toggle('problems');
  }
});

function allNodeIds(d: GraphDocument | null): Set<string> {
  return new Set(d?.functions.flatMap((f) => f.nodes.map((n) => n.id)) ?? []);
}

function relayout(): void {
  if (!doc.value) {
    return;
  }

  positions.value = {
    ...layoutDocument(
      doc.value,
      {
        sizeOf: (node: GraphNode) =>
          canvas.value?.sizeOf(node) ?? { width: 160, height: 60 },
        spaceAbove: (node: GraphNode) => canvas.value?.spaceAbove(node) ?? 0,
        commentBoxTop: COMMENT_BOX_TOP,
      },
      pinned.value
    ),
    ...rerouteEntries(pinned.value),
  };
}

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
    next = await client.parse(source, props.path);
  } catch (error) {
    show(`Parsing failed: ${(error as Error).message}`, 'error');
    return;
  }

  if (seq !== parseSeq) {
    return;
  }

  const previous = doc.value;
  pinned.value = previous
    ? {
        ...reconcilePositions(previous, next, pinned.value),
        ...reconcileReroutes(previous, next, pinned.value),
      }
    : pinned.value;

  if (pendingPlacement) {
    const { world, known, matches } = pendingPlacement;
    pendingPlacement = null;
    const fresh = next.functions
      .flatMap((f) => f.nodes)
      .filter((n) => !known.has(n.id));
    // The node asked for (also a pure one, e.g. a lone Get), else the first
    // new statement, else the root of a new expression (output not wired).
    const used = new Set(
      next.functions.flatMap((f) => f.edges.map((e) => e.from.node))
    );
    const added =
      (matches && fresh.find(matches)) ??
      fresh.find((n) => n.purity === 'impure') ??
      fresh.find((n) => !used.has(n.id));
    if (added) {
      pinned.value = { ...pinned.value, [added.id]: world };
      void persist({ [added.id]: world });
    }
  }

  doc.value = next;
  docText.value = source;
  relayout();
  if (props.files) {
    void updateReferences(seq);
  }

  void revealPendingSymbol();

  // Keep the selection on nodes whose own text changed (e.g. an edited value).
  if (previous && selection.value.length > 0) {
    const renamed = renamedNodes(previous, next);
    const kept = selection.value
      .map((id) => renamed.get(id) ?? id)
      .filter((id) => findNode(next, id) !== undefined);
    await nextTick();
    canvas.value?.setSelection(kept);
    if (kept.join() !== selection.value.join()) {
      onSelectionChange(kept);
    }
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

// ------------------------------------------------------------- persistence

let pendingPatch: Record<string, Point | null> = {};
const flush = useDebounceFn(async () => {
  const patch = pendingPatch;
  pendingPatch = {};
  if (!props.layoutStore || Object.keys(patch).length === 0) {
    return;
  }

  saving.value = 'saving';
  try {
    await props.layoutStore.save(patch);
    saving.value = 'saved';
  } catch (error) {
    saving.value = 'error';
    show(`Saving the layout failed: ${(error as Error).message}`, 'error');
  }
}, 600);

function persist(patch: Record<string, Point | null>): Promise<void> {
  Object.assign(pendingPatch, patch);
  return flush();
}

function applyLayoutPatch(patch: LayoutPatch): void {
  const next = { ...pinned.value };
  for (const [key, value] of Object.entries(patch)) {
    if (value) {
      next[key] = value;
    } else {
      delete next[key];
    }
  }

  pinned.value = next;
  relayout();
  void persist(patch);
}

// --------------------------------------------------------------- history
//
// Code edits live in Monaco's undo stack. Layout changes (moves, reroutes,
// resets) get their own stack; each step remembers the code version it was
// made at, so undo/redo replay both in the order they happened.

interface LayoutStep {
  before: LayoutPatch;
  after: LayoutPatch;
  codeVersion: number;
}

interface EditorHistory {
  canUndo: boolean;
  canRedo: boolean;
  version: number;
}

const codeHistory = ref<EditorHistory>({
  canUndo: false,
  canRedo: false,
  version: 0,
});
const undoStack = shallowRef<LayoutStep[]>([]);
const redoStack = shallowRef<LayoutStep[]>([]);
const canUndo = computed(
  () => undoStack.value.length > 0 || codeHistory.value.canUndo
);
const canRedo = computed(
  () => redoStack.value.length > 0 || codeHistory.value.canRedo
);

function recordLayout(after: LayoutPatch): void {
  const before: LayoutPatch = {};
  for (const key of Object.keys(after)) {
    before[key] = pinned.value[key] ?? null;
  }

  undoStack.value = [
    ...undoStack.value.slice(-199),
    { before, after, codeVersion: codeHistory.value.version },
  ];
  redoStack.value = [];
  applyLayoutPatch(after);
}

function undo(): void {
  const step = undoStack.value.at(-1);
  if (
    step &&
    (step.codeVersion === codeHistory.value.version ||
      !codeHistory.value.canUndo)
  ) {
    undoStack.value = undoStack.value.slice(0, -1);
    redoStack.value = [...redoStack.value, step];
    applyLayoutPatch(step.before);
    return;
  }

  editor.value?.undo();
}

function redo(): void {
  const step = redoStack.value.at(-1);
  if (
    step &&
    (step.codeVersion === codeHistory.value.version ||
      !codeHistory.value.canRedo)
  ) {
    redoStack.value = redoStack.value.slice(0, -1);
    undoStack.value = [...undoStack.value, step];
    applyLayoutPatch(step.after);
    return;
  }

  editor.value?.redo();
}

function onLayoutChange(patch: LayoutPatch): void {
  // The first move freezes the current auto layout so nothing jumps around
  // after a reload; afterwards only moved nodes are sent.
  const full: LayoutPatch = { ...patch };
  if (Object.keys(patch).some((key) => !isRerouteKey(key))) {
    const current = canvas.value?.getPositions() ?? positions.value;
    for (const [id, p] of Object.entries(current)) {
      if (!pinned.value[id] && !(id in full)) {
        full[id] = p;
      }
    }
  }

  recordLayout(full);
}

function resetLayout(ids: ReadonlyArray<string>): void {
  const patch: LayoutPatch = {};
  for (const id of ids) {
    if (pinned.value[id]) {
      patch[id] = null;
    }
  }

  if (Object.keys(patch).length === 0) {
    show('These nodes already use the automatic layout.');
    return;
  }

  recordLayout(patch);
}

function resetAllLayout(): void {
  const keys = Object.keys(pinned.value);
  if (keys.length === 0) {
    show('This file already uses the automatic layout.');
    return;
  }

  recordLayout(Object.fromEntries(keys.map((key) => [key, null])));
  show('Layout reset. Undo restores it.');
}

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
  void saveCamera(camera, route.path);
}

// ------------------------------------------------------- code <-> graph

function rangesOf(ids: ReadonlyArray<string>): SourceRange[] {
  if (!doc.value) {
    return [];
  }

  return ids
    .map((id) => findNode(doc.value as GraphDocument, id))
    .filter((n): n is GraphNode => n !== undefined)
    .map((n) => n.range)
    .filter((r) => r.end > r.start);
}

function onSelectionChange(ids: string[]): void {
  selection.value = ids;
  if (ids.length > 0) {
    selectedSymbolId.value = null;
  }

  const ranges = rangesOf(ids);
  editor.value?.setSelectedRanges(ranges);
  const first = ranges[0];
  if (first && codeVisible.value) {
    // Only its start: centering a whole function would hide where it begins.
    editor.value?.reveal({ start: first.start, end: first.start });
  }
}

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

/** Symbol selected in "My Script"; Details shows it instead of nodes. */
const selectedSymbolId = ref<string | null>(null);
const selectedSymbol = computed(
  () => doc.value?.symbols?.find((s) => s.id === selectedSymbolId.value) ?? null
);
// A symbol's kind can change (`let` → `const`): keep it selected by name.
watch(doc, (next) => {
  const id = selectedSymbolId.value;
  if (!id || !next?.symbols || next.symbols.some((s) => s.id === id)) {
    return;
  }

  const qualified = id.slice(id.indexOf(':') + 1);
  const same = next.symbols.find((s) => qualifiedName(s) === qualified);
  if (same) {
    selectedSymbolId.value = same.id;
  }
});

/**
 * The variable of a single selected Get / Set node, like UE shows the
 * variable's details for its nodes. Locals of the node's function come
 * first, `self.x` / `this.x` are members of the method's class.
 */
const nodeSymbol = computed(() => {
  const d = doc.value;
  const id = selection.value.length === 1 ? selection.value[0] : undefined;
  const node = d && id ? findNode(d, id) : undefined;
  if (
    !d?.symbols ||
    !node ||
    (node.kind !== 'getVar' && node.kind !== 'setVar')
  ) {
    return null;
  }

  let name =
    node.kind === 'setVar' ? node.title.replace(/^Set /, '') : node.title;
  const member = /^(?:self|this)\./.test(name);
  name = name.replace(/^(?:self|this)\./, '');
  if (!/^#?[A-Za-z_$][\w$]*$/.test(name)) {
    return null;
  }

  const fn = d.functions.find((f) => f.nodes.includes(node));
  const owner = fn
    ? d.symbols.find((s) => s.fnId === fn.id && s.kind !== 'class')
    : undefined;
  const isVariable = (s: ScriptSymbol): boolean =>
    s.name === name &&
    (s.kind === 'variable' || s.kind === 'constant' || s.kind === 'local');
  const local =
    !member && owner
      ? d.symbols.find(
          (s) =>
            isVariable(s) &&
            s.kind === 'local' &&
            s.scope === qualifiedName(owner)
        )
      : undefined;
  const classScope = owner?.kind === 'method' ? owner.scope : '';
  return (
    local ??
    (member
      ? d.symbols.find(
          (s) => isVariable(s) && s.kind !== 'local' && s.scope === classScope
        )
      : undefined) ??
    d.symbols.find(
      (s) => isVariable(s) && s.kind !== 'local' && s.scope === ''
    ) ??
    null
  );
});

/** Nodes using the selected symbol, highlighted like UE does. */
const symbolUses = computed(() =>
  selectedSymbol.value ? symbolNodes(doc.value, selectedSymbol.value) : []
);
watch(symbolUses, (ids) => canvas.value?.setHighlight(ids));

/** Function whose local variables "My Script" lists. */
const currentFunction = computed<string | null>(() => {
  const symbol = selectedSymbol.value;
  if (symbol?.kind === 'local') {
    return symbol.scope;
  }

  if (symbol?.kind === 'function' || symbol?.kind === 'method') {
    return qualifiedName(symbol);
  }

  const first = selection.value[0];
  const fn = first
    ? doc.value?.functions.find((f) => f.nodes.some((n) => n.id === first))
    : undefined;
  const owner = fn
    ? doc.value?.symbols?.find((s) => s.fnId === fn.id && s.kind !== 'class')
    : undefined;
  return owner ? qualifiedName(owner) : null;
});

function selectSymbol(id: string): void {
  canvas.value?.setSelection([]);
  selection.value = [];
  selectedSymbolId.value = id;
  const symbol = selectedSymbol.value;
  if (symbol) {
    editor.value?.setSelectedRanges([symbol.range]);
    if (codeVisible.value) {
      editor.value?.reveal({
        start: symbol.range.start,
        end: symbol.range.start,
      });
    }
  }
}

/** Double-click in "My Script": show the symbol in the graph. */
function openSymbol(id: string): void {
  const symbol = doc.value?.symbols?.find((s) => s.id === id);
  if (!symbol) {
    return;
  }

  if (symbol.fnId) {
    selectFunction(symbol.fnId);
    return;
  }

  const uses = symbolNodes(doc.value, symbol);
  if (uses.length > 0) {
    selectNodes(uses);
  }
}

function revealSymbol(id: string): void {
  const symbol = doc.value?.symbols?.find((s) => s.id === id);
  if (symbol) {
    void revealRange(symbol.nameRange);
  }
}

/** Edits from "My Script"; a renamed selection keeps being selected. */
function onScriptOp(op: GraphOp): void {
  if (op.type === 'renameSymbol' && selectedSymbolId.value === op.symbol) {
    selectedSymbolId.value = op.symbol.replace(/[^:.]+$/, op.name);
  }

  void onOp(op);
}

async function revealRange(range: SourceRange): Promise<void> {
  if (!codeVisible.value) {
    workbench.show('code');
    await nextTick();
  }

  editor.value?.reveal(range, true);
}

/** Selects nodes from outside the canvas (details panel, My Script). */
function selectNodes(ids: string[]): void {
  canvas.value?.selectNodes(ids);
}

function selectFunction(fnId: string): void {
  canvas.value?.selectFunction(fnId);
}

function onHoverChange(id: string | null): void {
  editor.value?.setHoveredRanges(id ? rangesOf([id]) : []);
}

function onCursor(offset: number): void {
  if (!doc.value || !graphVisible.value) {
    return;
  }

  const node = findNodeAtOffset(doc.value, offset);
  canvas.value?.setHighlight(node ? [node.id] : []);
  if (node) {
    canvas.value?.revealNodes([node.id]);
  }
}

async function revealSourceLine(line: number): Promise<void> {
  if (!codeVisible.value) {
    workbench.show('code');
    await nextTick();
  }

  editor.value?.revealLine(line);
}

async function onActivate(id: string): Promise<void> {
  const node = doc.value ? findNode(doc.value, id) : undefined;
  if (!node) {
    return;
  }

  if (!codeVisible.value) {
    workbench.show('code');
    await nextTick();
  }

  editor.value?.reveal(node.range, true);
}

async function onOp(op: GraphOp): Promise<void> {
  if (!editable.value) {
    return;
  }

  const result = await client.applyOp(text.value, props.path, op);
  if (!result.ok) {
    show(result.error, 'error');
    return;
  }

  if (result.edits.length === 0) {
    return;
  }

  // New nodes go where the wire was dropped or the menu was opened.
  if (
    (op.type === 'addNode' ||
      op.type === 'callWith' ||
      op.type === 'useValue' ||
      op.type === 'promote' ||
      op.type === 'extract') &&
    op.position
  ) {
    pendingPlacement = {
      world: op.position,
      known: allNodeIds(doc.value),
      matches: op.type === 'addNode' ? templateMatcher(op.template) : undefined,
    };
  }

  // Like Blueprints, editing must not move other nodes: pin the current
  // auto layout first (it looks the same, so no undo step). Otherwise a
  // node placed relative to an edited one would jump.
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

  editor.value?.applyEdits(result.edits);
}

useEventListener(window, 'keydown', (event: KeyboardEvent) => {
  const command = event.ctrlKey || event.metaKey;
  if (!command || event.key.toLowerCase() !== 'f' || !graphVisible.value) {
    return;
  }

  const active = document.activeElement;
  const typing =
    active instanceof HTMLInputElement ||
    active instanceof HTMLTextAreaElement ||
    (active instanceof HTMLElement && active.isContentEditable);
  if (!typing) {
    event.preventDefault();
    void canvas.value?.openSearch();
  }
});

// ---------------------------------------------------------- actions menu

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
  const graph = graphVisible.value;
  return [
    {
      label: 'Undo',
      icon: 'i-mdi-undo',
      shortcut: shortcut('Z'),
      disabled: !canUndo.value,
      action: undo,
    },
    {
      label: 'Redo',
      icon: 'i-mdi-redo',
      shortcut: shortcut('Z', true),
      disabled: !canRedo.value,
      action: redo,
    },
    ...(graph
      ? ([
          { type: 'separator' },
          {
            label: 'Find in graph…',
            icon: 'i-mdi-magnify',
            shortcut: shortcut('F'),
            action: () => void canvas.value?.openSearch(),
          },
          {
            label: 'Select all',
            icon: 'i-mdi-select-all',
            shortcut: shortcut('A'),
            action: () => canvas.value?.selectAll(),
          },
          {
            label: 'Zoom to selection',
            icon: 'i-mdi-image-filter-center-focus',
            shortcut: 'F',
            action: () => canvas.value?.frameSelection(),
          },
          {
            label: 'Zoom to fit all',
            icon: 'i-mdi-fit-to-screen-outline',
            shortcut: 'Home',
            action: () => canvas.value?.frameAll(),
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
            action: resetAllLayout,
          },
        ] satisfies MenuEntry[])
      : []),
  ];
});

// --------------------------------------------------------------- split

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

    <!-- File actions sit right of the editor tabs, like VS Code's. -->
    <Teleport :key="String(isMobile)" defer to="#workbench-editor-actions">
      <div
        data-ui="editor-actions-content"
        class="flex items-center gap-1 px-1"
      >
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
            @click="undo"
          >
            <span class="i-mdi-undo" />
          </button>
          <button
            type="button"
            class="btn-ghost px-1.5 py-1"
            :title="`Redo (${shortcut('Z', true)})`"
            aria-label="Redo"
            :disabled="!canRedo"
            @click="redo"
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
          @click="canvas?.openSearch()"
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

    <!-- The status bar is rendered by the Workbench after this toolbar. -->
    <Teleport defer to="#workbench-status">
      <button
        data-ui="status-problems"
        type="button"
        class="flex h-full items-center gap-1 rounded-sm px-1.5 hover:bg-zinc-800 hover:text-zinc-100"
        :class="
          problemCounts.errors > 0
            ? 'text-red-300'
            : problemCounts.warnings > 0
              ? 'text-amber-300'
              : ''
        "
        :title="`Problems (${shortcut('M', true)})`"
        :aria-label="`${problemCounts.errors} errors, ${problemCounts.warnings} warnings. Toggle problems`"
        :aria-pressed="workbench.isVisible('problems')"
        @click="workbench.toggle('problems')"
      >
        <span class="i-mdi-close-circle-outline" />{{ problemCounts.errors }}
        <span class="i-mdi-alert-outline ml-1" />{{ problemCounts.warnings }}
      </button>
      <span
        v-if="layoutStore && saving !== 'idle'"
        data-ui="status-layout"
        class="ml-auto flex items-center gap-1 px-1.5"
        :class="saving === 'error' ? 'text-red-400' : ''"
        role="status"
      >
        <span
          :class="
            saving === 'saving'
              ? 'i-mdi-loading animate-spin'
              : saving === 'saved'
                ? 'i-mdi-check'
                : 'i-mdi-alert-circle-outline'
          "
        />
        {{
          saving === 'saving'
            ? 'Saving layout…'
            : saving === 'saved'
              ? 'Layout saved'
              : 'Layout not saved'
        }}
      </span>
    </Teleport>

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
        <GraphCanvas
          ref="canvas"
          :doc="doc"
          :text="text"
          :positions="positions"
          :editable="editable"
          :initial-camera="initialCamera"
          :definition-of="describeDefinition"
          :problems="nodeProblems"
          :imports="importedNames"
          :types="typeSystem"
          @selection-change="onSelectionChange"
          @hover-change="onHoverChange"
          @layout-change="onLayoutChange"
          @reset-layout="resetLayout"
          @op="onOp"
          @activate="onActivate"
          @go-to-definition="goToDefinition"
          @camera-change="onCameraChange"
          @undo="undo"
          @redo="redo"
        />
        <button
          v-if="diagnostics.length > 0"
          type="button"
          class="absolute left-3 top-3 max-w-md rounded-md border border-red-900 bg-red-950/90 px-3 py-1.5 text-left text-xs text-red-200 hover:bg-red-950"
          @click="workbench.show('problems')"
        >
          {{ diagnostics.length }} syntax error{{
            diagnostics.length === 1 ? '' : 's'
          }}
          — the graph may be incomplete.
          <span class="text-red-300/80">{{ diagnostics[0]?.message }}</span>
        </button>
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
      <ProblemsPanel :problems="problems" :path="path" @select="showProblem" />
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
        :symbol-uses="symbolUses.length"
        :import-path="selectedImportPath"
        :types="typeSystem"
        :doc-text="docText"
        @select="selectNodes"
        @select-function="selectFunction"
        @activate="onActivate"
        @reveal="revealRange"
        @open-symbol="openSymbol"
        @open-import="openImport"
        @op="onScriptOp"
        @close="workbench.hide('details')"
      />
    </WorkbenchView>
  </div>
</template>
