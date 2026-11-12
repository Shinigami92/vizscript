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
  ImportedDeclaration,
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
  boxColorEntries,
  boxColorIndex,
  boxColorKey,
  defaultExport,
  exportedSymbols,
  findDefinition,
  findNode,
  findNodeAtOffset,
  isExtraLayoutKey,
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
  languageOf,
  monacoLanguage,
} from '../graph/languages';
import type { LayoutStore } from '../graph/layout-store';
import { NpmTypes, packageName } from '../graph/npm-types';
import type { Problem } from '../graph/problems';
import { problemsByNode } from '../graph/problems';
import type { ExternalName } from '../graph/project-index';
import {
  candidateFiles,
  externalNames,
  godotRoot,
  libraryNames,
} from '../graph/project-index';
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
  /**
   * Reads another file of the repository (with unsaved changes), so
   * imported names get their declarations: call pins, types.
   */
  readFile?: (path: string) => Promise<string>;
  /**
   * The saved version of the file (last commit, file on disk, original
   * sample): Details offers to reset values to it (UE's ↶).
   */
  baseText?: string;
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
  /**
   * Select afterwards: all new nodes (pasted ones), or only the placed one
   * (the call of collapsed nodes), like UE.
   */
  select?: 'fresh' | 'added';
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

    case 'code': {
      // Pasted statements: the first one goes where the paste happened.
      return (n) => n.purity === 'impure';
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
    void updateImports(seq);
  }
}

// ------------------------------------------------- declarations of imports

/** What imported files export, by path (parsed once per workspace). */
const exportsByPath = new Map<string, Promise<ScriptSymbol[]>>();

function exportsOf(path: string): Promise<ScriptSymbol[]> {
  let exports = exportsByPath.get(path);
  if (!exports) {
    const read = props.readFile;
    exports = read
      ? read(path)
          .then(async (source) =>
            exportedSymbols(await client.parse(source, path), source)
          )
          .catch(() => [])
      : Promise.resolve([]);
    exportsByPath.set(path, exports);
  }

  return exports;
}

// ------------------------------------------------------- project index

/** Exports of the repository's files of this language (action menu). */
const projectExports = shallowRef<ReadonlyMap<string, ScriptSymbol[]>>(
  new Map()
);
let indexing = false;
/** Files read for the index: nearest folders first. */
const INDEX_LIMIT = 150;

/**
 * Reads the exports of other files the first time the action menu opens,
 * so it can offer their functions (using one adds the import).
 */
async function indexProject(): Promise<void> {
  const files = props.files;
  if (indexing || !files || !props.readFile) {
    return;
  }

  indexing = true;
  const queue = candidateFiles(files, props.path, INDEX_LIMIT);
  const found = new Map<string, ScriptSymbol[]>();
  const worker = async (): Promise<void> => {
    for (let path = queue.shift(); path; path = queue.shift()) {
      const exports = await exportsOf(path);
      if (exports.length > 0) {
        found.set(path, exports);
        projectExports.value = new Map(found);
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
}

/** Functions and values of libraries for the action menu. */
const libraryExternals = shallowRef<ExternalName[]>([]);
let librariesIndexed = false;

/**
 * Python: the standard-library modules the backend knows. TypeScript: the
 * packages this file imports from (their other exports).
 */
async function indexLibraries(): Promise<void> {
  if (librariesIndexed) {
    return;
  }

  librariesIndexed = true;
  const language = languageOf(props.path);
  const modules =
    language === 'python'
      ? (await client.library(props.path)).modules
      : (doc.value?.symbols ?? [])
          .filter(
            (s) =>
              s.kind === 'import' &&
              s.module !== undefined &&
              packageName(s.module) === s.module
          )
          .map((s) => s.module ?? '');
  const found: ExternalName[] = [];
  for (const module of new Set(modules)) {
    found.push(
      ...libraryNames(
        module,
        await libraryExports(module),
        language === 'python' ? 'module' : 'named',
        props.path
      )
    );
    libraryExternals.value = [...found];
  }
}

function onActionMenu(): void {
  void indexProject();
  void indexLibraries();
}

const externals = computed(() => {
  const taken = new Set(
    (doc.value?.symbols ?? []).filter((s) => s.scope === '').map((s) => s.name)
  );
  return [
    ...(props.files
      ? externalNames(
          projectExports.value,
          doc.value,
          props.path,
          godotRoot(props.files, props.path)
        )
      : []),
    // Library names the file declares itself are left out; its imports of
    // a whole module (`import math`) are fine.
    ...libraryExternals.value.filter(
      (e) =>
        !taken.has(e.name) ||
        doc.value?.symbols?.some(
          (s) =>
            s.kind === 'import' &&
            s.name === e.name &&
            s.imported === '*' &&
            e.request.imported === '*'
        )
    ),
  ];
});

/** Declarations of the imported names, sent along with every parse. */
let importDeclarations: ImportedDeclaration[] = [];

// ---------------------------------------------------------- libraries

const npm = new NpmTypes((source, fileName) => client.parse(source, fileName));
const libraryCache = new Map<string, Promise<ScriptSymbol[]>>();

/**
 * Version range of an npm package in the nearest `package.json`: `latest`
 * when none lists it, `''` for packages of the repository (`workspace:`).
 */
async function packageRange(name: string): Promise<string> {
  const files = props.files;
  const read = props.readFile;
  if (!files || !read) {
    return 'latest';
  }

  const dirs = props.path.split('/').slice(0, -1);
  for (;;) {
    const manifest = [...dirs, 'package.json'].join('/');
    if (files.has(manifest)) {
      try {
        const json = JSON.parse(await read(manifest)) as Record<
          string,
          Record<string, string> | undefined
        >;
        const range =
          json.dependencies?.[name] ??
          json.devDependencies?.[name] ??
          json.peerDependencies?.[name];
        if (range !== undefined) {
          return /^(?:workspace|file|link|portal):/.test(range) ? '' : range;
        }
      } catch {
        // not JSON: look further up
      }
    }

    if (dirs.length === 0) {
      return 'latest';
    }

    dirs.pop();
  }
}

/**
 * Exports of a library module: Python's standard library (stubs of the
 * backend), npm packages (`.d.ts` files from jsDelivr).
 */
function libraryExports(module: string): Promise<ScriptSymbol[]> {
  let exports = libraryCache.get(module);
  if (!exports) {
    exports = (async (): Promise<ScriptSymbol[]> => {
      const language = languageOf(props.path);
      if (language === 'python' && !module.startsWith('.')) {
        const { stub } = await client.library(props.path, module);
        return stub
          ? exportedSymbols(
              await client.parse(stub.text, stub.fileName),
              stub.text
            )
          : [];
      }

      const name = packageName(module);
      if (language === 'typescript' && name === module) {
        const range = await packageRange(name);
        return range === '' ? [] : npm.exportsOf(name, range);
      }

      return [];
    })().catch(() => []);
    libraryCache.set(module, exports);
  }

  return exports;
}

async function declarationOf(
  symbol: ScriptSymbol
): Promise<ImportedDeclaration | undefined> {
  // A file of the repository, else a library.
  const target = importTarget(symbol);
  let exports: ScriptSymbol[];
  let named: string | undefined;
  if (target) {
    exports = await exportsOf(target.path);
    named = target.symbol;
  } else if (symbol.module) {
    exports = await libraryExports(symbol.module);
    named =
      symbol.imported === '*' || symbol.imported === 'default'
        ? undefined
        : symbol.imported;
  } else {
    return undefined;
  }

  if (exports.length === 0) {
    return undefined;
  }

  if (symbol.imported === 'default') {
    const declaration = defaultExport(exports);
    return declaration ? { name: symbol.name, declaration } : undefined;
  }

  if (named) {
    const declaration = exports.find((s) => s.name === named);
    return declaration ? { name: symbol.name, declaration } : undefined;
  }

  // A whole module: `ns.fn()`, `module.fn()`, `Script.new()`.
  return { name: symbol.name, members: exports };
}

/** Reads the imported files; parses again when their declarations change. */
async function updateImports(seq: number): Promise<void> {
  const imports = (doc.value?.symbols ?? []).filter((s) => s.kind === 'import');
  if (imports.length === 0 && importDeclarations.length === 0) {
    return;
  }

  const found = await Promise.all(imports.map((s) => declarationOf(s)));
  if (seq !== parseSeq) {
    return;
  }

  // Plain JSON: the declarations are posted to the worker.
  const next = JSON.parse(
    JSON.stringify(found.filter((d) => d !== undefined))
  ) as ImportedDeclaration[];
  if (JSON.stringify(next) !== JSON.stringify(importDeclarations)) {
    importDeclarations = next;
    void reparse();
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

  await selectNodes([target.nodeId]);
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
    ...boxColorEntries(pinned.value),
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
    next = await client.parse(source, props.path, importDeclarations);
  } catch (error) {
    show(`Parsing failed: ${(error as Error).message}`, 'error');
    return;
  }

  if (seq !== parseSeq) {
    return;
  }

  const previous = doc.value;
  // A renamed function keeps the focus (its id follows the name).
  const focused = focusFn.value;
  if (focused && previous && !next.functions.some((f) => f.id === focused)) {
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

  pinned.value = previous
    ? {
        ...reconcilePositions(previous, next, pinned.value),
        ...reconcileReroutes(previous, next, pinned.value),
        ...boxColorEntries(pinned.value),
      }
    : pinned.value;

  let selectAfter: string[] | undefined;
  if (pendingPlacement) {
    const { world, known, matches, select } = pendingPlacement;
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

    if (select === 'fresh' && fresh.length > 0) {
      selectAfter = fresh.map((n) => n.id);
    } else if (select === 'added' && added) {
      selectAfter = [added.id];
    }
  }

  doc.value = next;
  docText.value = source;
  relayout();
  if (props.files) {
    void updateReferences(seq);
  } else {
    // No repository (playground): libraries only.
    void updateImports(seq);
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
  if (Object.keys(patch).some((key) => !isExtraLayoutKey(key))) {
    const current = canvas.value?.getPositions() ?? positions.value;
    for (const [id, p] of Object.entries(current)) {
      if (!pinned.value[id] && !(id in full)) {
        full[id] = p;
      }
    }
  }

  recordLayout(full);
}

/** Colors of comment boxes are layout entries, undone like moves. */
function boxColorOf(boxId: string): number {
  return boxColorIndex(pinned.value, boxId);
}

function setBoxColor(boxId: string, index: number): void {
  recordLayout({ [boxColorKey(boxId)]: index > 0 ? { x: index, y: 0 } : null });
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
  lastCamera = camera;
  void saveCamera(camera, route.path);
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

// ------------------------------------------------------------ focus mode
//
// Like UE's graph tabs: one function on its own, with a breadcrumb and
// back / forward. `?fn=` keeps it for reloads and shared links.

const FOCUS_PARAM = 'fn';
const focusFn = ref<string | null>(
  typeof route.query[FOCUS_PARAM] === 'string' ? route.query[FOCUS_PARAM] : null
);
const focusBack = ref<Array<string | null>>([]);
const focusAhead = ref<Array<string | null>>([]);
/** The camera of each view (`''`: all functions), to come back to. */
const focusCameras = new Map<string, Camera>();
let lastCamera: Camera | null = null;

const focusedFunction = computed(() =>
  focusFn.value
    ? doc.value?.functions.find((f) => f.id === focusFn.value)
    : undefined
);

/** The document the graph shows: one function in focus mode. */
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

/** Shows one function (or all with `null`), remembered for Back. */
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

/** The function of a node, when focus mode hides it. */
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

  // Like UE: double-clicking a function opens its graph.
  if (symbol.fnId) {
    void focusFunction(symbol.fnId);
    return;
  }

  const uses = symbolNodes(doc.value, symbol);
  if (uses.length > 0) {
    void selectNodes(uses);
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
async function selectNodes(ids: string[]): Promise<void> {
  const fn = hiddenFunctionOf(ids);
  if (fn !== undefined) {
    await focusFunction(fn);
  }

  canvas.value?.selectNodes(ids);
}

function selectFunction(fnId: string): void {
  // In focus mode another function opens instead.
  if (focusFn.value && focusFn.value !== fnId) {
    void focusFunction(fnId);
    return;
  }

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

  const result = await client.applyOp(
    text.value,
    props.path,
    op,
    importDeclarations
  );
  if (!result.ok) {
    show(result.error, 'error');
    return;
  }

  if (result.edits.length === 0) {
    return;
  }

  // New nodes go where the wire was dropped or the menu was opened.
  const placed = op.type === 'withImport' ? op.op : op;
  if (
    (placed.type === 'addNode' ||
      placed.type === 'callWith' ||
      placed.type === 'useValue' ||
      placed.type === 'promote' ||
      placed.type === 'extract' ||
      placed.type === 'collapseToFunction') &&
    placed.position
  ) {
    let matches: ((node: GraphNode) => boolean) | undefined;
    if (placed.type === 'addNode') {
      matches = templateMatcher(placed.template);
    } else if (placed.type === 'collapseToFunction') {
      // The call of the new function (`name`, `this.name`, `self.name`).
      const name = placed.name;
      matches = (n) =>
        n.kind === 'call' && (n.title === name || n.title.endsWith(`.${name}`));
    }

    pendingPlacement = {
      world: placed.position,
      known: allNodeIds(doc.value),
      matches,
      select:
        placed.type === 'collapseToFunction'
          ? 'added'
          : placed.type === 'addNode' && placed.template.type === 'code'
            ? 'fresh'
            : undefined,
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
        <!-- UE's breadcrumb: back / forward and the shown function. -->
        <div
          v-if="
            focusedFunction || focusBack.length > 0 || focusAhead.length > 0
          "
          data-ui="graph-breadcrumb"
          class="absolute left-2 top-2 z-10 flex max-w-[calc(100%-1rem)] items-center gap-0.5 rounded-md border border-zinc-800 bg-zinc-950/90 px-1 py-0.5 text-xs shadow"
        >
          <button
            type="button"
            class="btn-ghost px-1"
            title="Back (Alt+←, mouse back button)"
            aria-label="Back"
            :disabled="focusBack.length === 0"
            @click="navigateFocus('back')"
          >
            <span class="i-mdi-arrow-left" />
          </button>
          <button
            type="button"
            class="btn-ghost px-1"
            title="Forward (Alt+→)"
            aria-label="Forward"
            :disabled="focusAhead.length === 0"
            @click="navigateFocus('forward')"
          >
            <span class="i-mdi-arrow-right" />
          </button>
          <button
            type="button"
            class="truncate rounded px-1.5 py-0.5 hover:bg-zinc-800"
            :class="focusedFunction ? 'text-zinc-400' : 'text-zinc-100'"
            title="Show all functions"
            @click="focusFunction(null)"
          >
            {{ path.split('/').at(-1) }}
          </button>
          <template v-if="focusedFunction">
            <span class="i-mdi-chevron-right shrink-0 text-zinc-600" />
            <span class="truncate px-1.5 font-semibold text-zinc-100">{{
              focusedFunction.name
            }}</span>
            <button
              type="button"
              class="btn-ghost px-1"
              title="Show all functions"
              aria-label="Show all functions"
              @click="focusFunction(null)"
            >
              <span class="i-mdi-close" />
            </button>
          </template>
        </div>
        <GraphCanvas
          ref="canvas"
          :doc="shownDoc"
          :text="text"
          :positions="positions"
          :editable="editable"
          :initial-camera="initialCamera"
          :definition-of="describeDefinition"
          :problems="nodeProblems"
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
          @activate="onActivate"
          @go-to-definition="goToDefinition"
          @camera-change="onCameraChange"
          @undo="undo"
          @redo="redo"
        />
        <button
          v-if="diagnostics.length > 0"
          type="button"
          class="absolute left-3 max-w-md rounded-md border border-red-900 bg-red-950/90 px-3 py-1.5 text-left text-xs text-red-200 hover:bg-red-950"
          :class="
            focusedFunction || focusBack.length > 0 || focusAhead.length > 0
              ? 'top-12'
              : 'top-3'
          "
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
        :symbol-uses="symbolUses.length"
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
