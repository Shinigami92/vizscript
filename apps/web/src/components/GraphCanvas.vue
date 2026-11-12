<script setup lang="ts">
import type {
  AlignMode,
  Camera,
  CommentTarget,
  ContextTarget,
  GraphViewEvents,
} from '@vizscript/canvas';
import {
  DARK_THEME,
  GraphView,
  LIGHT_THEME,
  MAX_ZOOM,
  MIN_ZOOM,
} from '@vizscript/canvas';
import type {
  DataType,
  FlowTemplate,
  GraphDocument,
  GraphNode,
  GraphOp,
  InputPinMeta,
  LayoutPatch,
  NodeTemplate,
  Pin,
  PinRef,
  Point,
  Positions,
  ScriptSymbol,
  StatementMeta,
  TypeSystemInfo,
} from '@vizscript/core';
import {
  ARG_PIN,
  endOfFunction,
  getMeta,
  isTypeCompatible,
  qualifiedName,
  referenceName,
  uniqueName,
} from '@vizscript/core';
import { useEventListener, usePreferredReducedMotion } from '@vueuse/core';
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
import { indexDocument, pinEdges } from '../graph/doc-index';
import type { Problem, ProblemSeverity } from '../graph/problems';
import { worstSeverity } from '../graph/problems';
import type { ExternalName } from '../graph/project-index';
import { signature } from '../graph/project-index';
import { isMac, shortcut } from '../graph/source';
import { SYMBOL_DRAG_MIME, symbolNodes, topLevelGraph } from '../graph/symbols';
import type { ActionEntry } from './ActionMenu.vue';
import ActionMenu from './ActionMenu.vue';
import type { MenuEntry } from './ContextMenu.vue';
import ContextMenu from './ContextMenu.vue';
import GraphSearch from './GraphSearch.vue';
import NodeTooltip from './NodeTooltip.vue';

const props = defineProps<{
  doc: GraphDocument | null;
  positions: Positions;
  editable: boolean;
  text: string;
  initialCamera?: Camera | null;
  /** Describes where "Go to definition" of a node leads, if anywhere. */
  definitionOf?: (nodeId: string) => string | undefined;
  /** Problems per node, shown as ERROR / WARNING banners. */
  problems?: ReadonlyMap<string, ReadonlyArray<Problem>>;
  /** Names imported into the file (offered in the action menu). */
  imports?: ReadonlyArray<string>;
  /** Operators and values of the language (action menu). */
  types?: TypeSystemInfo | null;
  /** Names of other files; using one adds its import. */
  externals?: ReadonlyArray<ExternalName>;
}>();

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
const ZOOM_STEP = 1.25;
const canvas = useTemplateRef<HTMLCanvasElement>('canvas');
const view = shallowRef<GraphView>();
const index = computed(() => indexDocument(props.doc));
const selection = ref<string[]>([]);

// ------------------------------------------------------- inline literal

const literal = ref<GraphViewEvents['editLiteral'] | null>(null);
const literalValue = ref('');
const literalInput = useTemplateRef<HTMLInputElement>('literalInput');

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

function editComment(target: CommentTarget): void {
  closeMenu();
  view.value?.editComment(target);
}

/** Asks for a title and wraps the nodes' code in a region. */
function createCommentBox(ids: ReadonlyArray<string>, client: Point): void {
  if (!props.editable || ids.length === 0) {
    return;
  }

  openMenu({
    world: { x: 0, y: 0 },
    client,
    target: { kind: 'node', nodeId: ids[0] ?? '' },
  });
  void ask({
    label: 'Comment box title',
    placeholder: 'Comment',
    allowEmpty: true,
    submit: (title) =>
      emitOp({ type: 'addCommentBox', nodes: [...ids], title }),
  });
}

// --------------------------------------------------------------- tooltip

const pointer = { x: 0, y: 0 };
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

type MenuState = GraphViewEvents['contextMenu'];
const menu = ref<MenuState | null>(null);

/** A one-field form that replaces the menu list (names, expressions). */
interface Prompt {
  label: string;
  placeholder: string;
  value: string;
  /** Submit an empty value too (otherwise Enter does nothing). */
  allowEmpty?: boolean;
  submit: (value: string) => void;
}

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

async function ask(
  options: Omit<Prompt, 'value'> & { value?: string }
): Promise<void> {
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

/** Emits an op built from the menu state and closes the menu. */
// ------------------------------------------------- drop from "My Script"

/** Get / Set menu of a variable dropped into the graph (like UE). */
const dropMenu = ref<{ x: number; y: number; entries: MenuEntry[] } | null>(
  null
);

function onDragOver(event: DragEvent): void {
  if (props.editable && event.dataTransfer?.types.includes(SYMBOL_DRAG_MIME)) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }
}

/** `this.x` / `self.x` for members used inside a method of their class. */
function memberAccess(
  symbol: ScriptSymbol,
  owner: ScriptSymbol | undefined,
  language: string
): string | undefined {
  const isMember =
    symbol.scope !== '' &&
    symbol.kind !== 'local' &&
    !(language === 'gdscript' && symbol.scope === '');
  if (!isMember) {
    return symbol.name;
  }

  if (owner?.kind !== 'method' || owner.scope !== symbol.scope) {
    return undefined;
  }

  return `${language === 'typescript' ? 'this' : 'self'}.${symbol.name}`;
}

/**
 * Where new code for a point of the graph goes: the end of the function
 * whose frame contains it (else the module). `undefined` in a GDScript
 * file's top level, which is its class body.
 */
function placeAt(
  world: Point
):
  | { fnId: string; anchor: { after: PinRef } | { before: PinRef } }
  | undefined {
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

// ------------------------------------------- operators and value nodes

/** Fills `$1`, `$2` … of an expression template (`first` goes into `$1`). */
function fillTemplate(template: string, first?: string): string {
  const placeholder = props.types?.placeholder ?? 'undefined';
  return template.replaceAll(/\$(\d)/g, (_, n: string) =>
    n === '1' && first !== undefined ? first : placeholder
  );
}

const EXPRESSION_ICONS: Record<string, string> = {
  Math: 'i-mdi-calculator-variant-outline text-emerald-400',
  Comparison: 'i-mdi-scale-balance text-red-300',
  Logic: 'i-mdi-gate-and text-red-300',
  Text: 'i-mdi-format-text text-pink-400',
  Values: 'i-mdi-numeric text-zinc-400',
};

/**
 * Operator and value actions (UE: `+`, Make Literal String …) for a wire
 * dropped from a data pin, or for empty space (`from` undefined).
 */
function expressionActions(state: MenuState): ActionEntry[] {
  const expressions = props.types?.expressions ?? [];
  const source = state.from;
  const found = source ? pinOf(source) : undefined;
  return expressions.flatMap((expression): ActionEntry[] => {
    const base = {
      label: expression.label,
      category: expression.category,
      icon: EXPRESSION_ICONS[expression.category],
      keywords: `${expression.keywords ?? ''} ${expression.template}`,
      hint: fillTemplate(expression.template, '·').replaceAll(
        props.types?.placeholder ?? 'undefined',
        '·'
      ),
    };

    if (source && found?.pin.direction === 'out') {
      // The dragged value goes into the first input.
      if (!expression.template.includes('$1')) {
        return [];
      }

      return [
        {
          ...base,
          action: () =>
            emitOp({
              type: 'useValue',
              pin: source,
              expression: fillTemplate(expression.template, '$value'),
              position: { ...state.world },
            }),
        },
      ];
    }

    if (source && found) {
      // Into an input: replaces its value.
      return [
        {
          ...base,
          fits: isTypeCompatible(expression.result ?? 'any', found.pin.type),
          action: () =>
            emitOp({
              type: 'setInput',
              pin: source,
              expression: fillTemplate(expression.template),
            }),
        },
      ];
    }

    // Empty space: a lone value at the end of the function under it.
    return [
      {
        ...base,
        action: () => {
          const place = placeAt(state.world);
          if (!place) {
            show('Add it inside a function.');
            return;
          }

          emitOp({
            type: 'addNode',
            template: {
              type: 'value',
              expression: fillTemplate(expression.template),
            },
            ...place.anchor,
            position: { ...state.world },
          });
        },
      },
    ];
  });
}

function onDrop(event: DragEvent): void {
  const id = event.dataTransfer?.getData(SYMBOL_DRAG_MIME);
  const v = view.value;
  const doc = props.doc;
  if (!id || !v || !doc || !props.editable) {
    return;
  }

  event.preventDefault();
  const symbol = doc.symbols?.find((s) => s.id === id);
  if (!symbol) {
    return;
  }

  const world = v.worldAt(event.clientX, event.clientY);
  const place = placeAt(world);
  if (!place) {
    show('Drop it into a function.');
    return;
  }

  const { fnId, anchor } = place;

  const owner = doc.symbols?.find(
    (s) => s.fnId === fnId && (s.kind === 'function' || s.kind === 'method')
  );
  const add = (template: NodeTemplate): void =>
    emitOp({ type: 'addNode', template, ...anchor, position: world });

  if (
    symbol.kind === 'function' ||
    symbol.kind === 'method' ||
    symbol.kind === 'signal'
  ) {
    const callee =
      symbol.kind === 'signal'
        ? `${symbol.name}.emit`
        : memberAccess(symbol, owner, doc.language);
    if (!callee) {
      show(`Methods of ${symbol.scope} can be dropped into its own methods.`);
      return;
    }

    // Like a new call node: its inputs show as pins (from the signature)
    // that fill in the arguments when they get a value or a wire.
    add({ type: 'call', callee });
    return;
  }

  if (symbol.kind === 'import') {
    // Without the module's declarations it may be a function or a value.
    const name = symbol.name;
    const call =
      symbol.imported === '*'
        ? symbol.modifiers.some((m) => m === 'preload' || m === 'load')
          ? `${name}.new`
          : undefined
        : name;
    const get = (): void => add({ type: 'value', expression: name });
    const kind = symbol.importedKind;
    if (kind === 'function' && !event.ctrlKey && !event.metaKey) {
      // Known from its file: a call node with the function's inputs.
      add({ type: 'call', callee: name });
      return;
    }

    if (
      event.ctrlKey ||
      event.metaKey ||
      !call ||
      kind === 'variable' ||
      kind === 'constant'
    ) {
      get();
      return;
    }

    dropMenu.value = {
      x: event.clientX,
      y: event.clientY,
      entries: [
        { type: 'header', label: name },
        {
          label: `Call ${call}()`,
          icon: 'i-mdi-function',
          action: () => add({ type: 'call', callee: call }),
        },
        {
          label: `Get ${name}`,
          icon: 'i-mdi-arrow-right-bold-box-outline',
          shortcut: isMac ? '⌘ drag' : 'Ctrl drag',
          action: get,
        },
      ],
    };
    return;
  }

  if (
    symbol.kind === 'local' &&
    owner &&
    qualifiedName(owner) !== symbol.scope
  ) {
    show(`${symbol.name} is a local variable of ${symbol.scope}.`);
    return;
  }

  const name = memberAccess(symbol, owner, doc.language);
  if (!name) {
    show(`Members of ${symbol.scope} can be dropped into its own methods.`);
    return;
  }

  const get = (): void => add({ type: 'value', expression: name });
  const set = (): void => add({ type: 'setVar', name, declaration: 'none' });
  // UE: Ctrl-drag gets, Alt-drag sets, otherwise ask.
  if (event.ctrlKey || event.metaKey) {
    get();
  } else if (event.altKey && symbol.kind !== 'constant') {
    set();
  } else {
    dropMenu.value = {
      x: event.clientX,
      y: event.clientY,
      entries: [
        { type: 'header', label: name },
        {
          label: `Get ${name}`,
          icon: 'i-mdi-arrow-right-bold-box-outline',
          shortcut: isMac ? '⌘ drag' : 'Ctrl drag',
          action: get,
        },
        {
          label: `Set ${name}`,
          icon: 'i-mdi-arrow-left-bold-box-outline',
          shortcut: isMac ? '⌥ drag' : 'Alt drag',
          disabled: symbol.kind === 'constant',
          action: set,
        },
      ],
    };
  }
}

/** A value picked for an input from the action menu goes where it opened. */
function withPosition(op: GraphOp, world: Point): GraphOp {
  if (op.type === 'withImport') {
    return { ...op, op: withPosition(op.op, world) };
  }

  return op.type === 'setInput' && !op.position
    ? { ...op, position: world }
    : op;
}

function emitOp(op: GraphOp): void {
  const open = menu.value;
  const placed = open?.from ? withPosition(op, { ...open.world }) : op;
  closeMenu();
  // Ops are posted to a worker: strip reactive proxies (ops are plain JSON).
  emit('op', JSON.parse(JSON.stringify(placed)) as GraphOp);
  canvas.value?.focus();
}

function pinOf(pinRef: PinRef): { node: GraphNode; pin: Pin } | undefined {
  const node = index.value.nodes.get(pinRef.node)?.node;
  const pin = node?.pins.find((p) => p.id === pinRef.pin);
  return node && pin ? { node, pin } : undefined;
}

/** An op using a name of another file, with that name's import. */
function withImport(external: ExternalName, op: GraphOp): GraphOp {
  return { type: 'withImport', import: { ...external.request }, op };
}

const ICON_IMPORT = 'i-mdi-file-import-outline text-sky-400';

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

interface Variable {
  name: string;
  type: string;
}

/** A variable a function can read and set (UE: Get / Set in the menu). */
interface ScopeVariable {
  /** As written in the function (`score`, `this.speed`, `self.hp`). */
  expression: string;
  dataType: DataType;
  /** Type as written, for the hint. */
  type: string;
  constant: boolean;
}

/**
 * Variables of a function: its parameters and locals, the fields of its
 * class and the module's variables.
 */
function scopeVariables(fnId: string | undefined): ScopeVariable[] {
  const doc = props.doc;
  if (!doc || !fnId) {
    return [];
  }

  const symbols = doc.symbols ?? [];
  const owner = symbols.find(
    (s) => s.fnId === fnId && (s.kind === 'function' || s.kind === 'method')
  );
  const scope = owner ? qualifiedName(owner) : undefined;
  const found = new Map<string, ScopeVariable>();
  const add = (variable: ScopeVariable): void => {
    if (!found.has(variable.expression)) {
      found.set(variable.expression, variable);
    }
  };

  for (const param of owner?.params ?? []) {
    if (!param.rest) {
      add({
        expression: param.name,
        dataType: param.dataType,
        type: param.type?.text ?? String(param.dataType),
        constant: false,
      });
    }
  }

  for (const symbol of symbols) {
    const local = symbol.kind === 'local' && symbol.scope === scope;
    if (!local && symbol.kind !== 'variable' && symbol.kind !== 'constant') {
      continue;
    }

    const expression = local
      ? symbol.name
      : memberAccess(symbol, owner, doc.language);
    if (expression) {
      add({
        expression,
        dataType: symbol.dataType,
        type: symbol.type?.text ?? String(symbol.dataType),
        constant:
          symbol.kind === 'constant' ||
          symbol.modifiers.includes('const') ||
          symbol.modifiers.includes('readonly'),
      });
    }
  }

  return [...found.values()].toSorted((a, b) =>
    a.expression.localeCompare(b.expression)
  );
}

/** First parameter and result types of a function of the file. */
function callSignature(callee: string): {
  first?: DataType;
  returns?: DataType;
  detail?: string;
} {
  const name = callee.replace(/^(?:this|self)\./, '');
  const symbol = props.doc?.symbols?.find(
    (s) =>
      s.name === name &&
      s.params !== undefined &&
      (s.kind === 'function' || s.kind === 'method' || s.kind === 'import')
  );
  if (!symbol) {
    return {};
  }

  // UE's action tooltip: the signature, then the description.
  const typed = signature(symbol, props.text);
  const about = symbol.fnId
    ? props.doc?.functions
        .find((f) => f.id === symbol.fnId)
        ?.nodes.find((n) => n.kind === 'entry')?.comment?.text
    : undefined;
  return typed.detail && about
    ? { ...typed, detail: `${typed.detail}\n\n${about}` }
    : typed;
}

/** UE's Context Sensitive: does a value of `from` fit into `to`? */
function fitsType(
  from: DataType | undefined,
  to: DataType | undefined
): boolean | undefined {
  return from === undefined || to === undefined
    ? undefined
    : isTypeCompatible(from, to);
}

/** Variables that can be read in the function of `nodeId`, with types. */
function variablesNear(nodeId: string): Variable[] {
  const fn = index.value.nodes.get(nodeId)?.fn;
  const found = new Map<string, string>();
  const add = (name: string, type: string): void => {
    if (/^[A-Za-z_$][\w$]*$/.test(name) && !found.has(name)) {
      found.set(name, type);
    }
  };

  for (const node of fn?.nodes ?? []) {
    const out = node.pins.find(
      (p) => p.kind === 'data' && p.direction === 'out'
    );
    if (node.kind === 'entry' || node.kind === 'forEach') {
      for (const pin of node.pins) {
        if (pin.kind === 'data' && pin.direction === 'out') {
          add(pin.name.replace(/^\*+/, ''), String(pin.type));
        }
      }
    } else if (Array.isArray(node.meta?.declares)) {
      // Declarations name what they bind (including destructuring).
      const names = (node.meta.declares as unknown[]).filter(
        (n): n is string => typeof n === 'string'
      );
      for (const name of names) {
        add(name, names.length === 1 ? String(out?.type ?? 'any') : 'any');
      }
    } else if (
      node.kind === 'setVar' &&
      /^Set [A-Za-z_$][\w$]*$/.test(node.title)
    ) {
      add(node.title.slice(4), String(out?.type ?? 'any'));
    }
  }

  return [...found]
    .map(([name, type]) => ({ name, type }))
    .toSorted((a, b) => a.name.localeCompare(b.name));
}

const IDENTIFIER_PATH = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

/** Functions worth offering: called in this file, defined, or imported. */
const callables = computed(() => {
  const names = new Set<string>();
  for (const fn of props.doc?.functions ?? []) {
    // Not the file's top-level graph ("Module").
    const topLevel = fn.range.start === 0 && fn.range.end >= props.text.length;
    if (!topLevel && /^[A-Za-z_$][\w$]*$/.test(fn.name)) {
      names.add(fn.name);
    }

    for (const node of fn.nodes) {
      if (node.kind === 'call' && IDENTIFIER_PATH.test(node.title)) {
        names.add(node.title);
      }
    }
  }

  for (const name of props.imports ?? []) {
    names.add(name);
  }

  // The file's own names first, then built-ins (`console.log`, `print`).
  const own = [...names].toSorted((a, b) => a.localeCompare(b));
  return [
    ...own,
    ...(props.types?.globals ?? []).filter((name) => !names.has(name)),
  ];
});

/** Names of other files and libraries not offered as callables already. */
const externalNames = computed(() => {
  // Once per callee (a library may declare a name twice, e.g. as a type).
  const known = new Set(callables.value);
  return (props.externals ?? []).filter((e) => {
    if (known.has(e.callee)) {
      return false;
    }

    known.add(e.callee);
    return true;
  });
});

function suggestName(pin: Pin): string {
  if (/^[A-Za-z_$][\w$]*$/.test(pin.name)) {
    return pin.name;
  }

  // `&"parameters/move/blend_amount"` → `blend_amount`
  const words = (pin.literal?.value ?? '').match(/[A-Za-z_][\w]*/g);
  return words?.at(-1) ?? 'value';
}

/** UE's "Promote to variable": store an output's value in a new variable. */
function promoteTo(
  source: PinRef,
  pin: Pin,
  world: Point,
  value = /^[A-Za-z_$][\w$]*$/.test(pin.name) ? pin.name : ''
): void {
  void ask({
    label: 'Variable name',
    placeholder: 'value',
    value,
    submit: (name) =>
      emitOp({ type: 'promote', pin: source, name, position: { ...world } }),
  });
}

/** "Extract to variable…": declare the input's value before its statement. */
function extractEntry(source: PinRef, pin: Pin, world: Point): MenuEntry {
  return {
    label: 'Extract to variable…',
    icon: 'i-mdi-variable text-sky-400',
    disabled: !pin.range,
    action: () =>
      void ask({
        label: 'Variable name',
        placeholder: 'value',
        value: suggestName(pin),
        submit: (name) =>
          emitOp({
            type: 'extract',
            pin: source,
            name,
            position: { ...world },
          }),
      }),
  };
}

/** UE's alignment tools for two or more selected nodes. */
const ALIGN_ENTRIES: ReadonlyArray<{
  label: string;
  icon: string;
  mode: AlignMode;
  keys?: string;
}> = [
  {
    label: 'Align top',
    icon: 'i-mdi-align-vertical-top',
    mode: 'top',
    keys: 'Shift+W',
  },
  {
    label: 'Align middle',
    icon: 'i-mdi-align-vertical-center',
    mode: 'middle',
    keys: 'Alt+Shift+W',
  },
  {
    label: 'Align bottom',
    icon: 'i-mdi-align-vertical-bottom',
    mode: 'bottom',
    keys: 'Shift+S',
  },
  {
    label: 'Align left',
    icon: 'i-mdi-align-horizontal-left',
    mode: 'left',
    keys: 'Shift+A',
  },
  {
    label: 'Align center',
    icon: 'i-mdi-align-horizontal-center',
    mode: 'center',
    keys: 'Alt+Shift+S',
  },
  {
    label: 'Align right',
    icon: 'i-mdi-align-horizontal-right',
    mode: 'right',
    keys: 'Shift+D',
  },
  {
    label: 'Distribute horizontally',
    icon: 'i-mdi-distribute-horizontal-center',
    mode: 'distributeHorizontally',
  },
  {
    label: 'Distribute vertically',
    icon: 'i-mdi-distribute-vertical-center',
    mode: 'distributeVertically',
  },
];

/** Actions for a wire dropped on empty space (like Blueprints). */
const ICON_CALL = 'i-mdi-function-variant text-sky-400';
const ICON_VARIABLE = 'i-mdi-alpha-x-box-outline text-sky-400';
const ICON_SET = 'i-mdi-arrow-left-bold-box-outline text-sky-400';

const JUMPS: ReadonlySet<FlowTemplate> = new Set([
  'throw',
  'break',
  'continue',
]);

const FLOW_ENTRIES: Record<
  FlowTemplate,
  { label: string; icon: string; keywords: string }
> = {
  forEach: {
    label: 'For Each loop',
    icon: 'i-mdi-repeat',
    keywords: 'for of in each array list iterate loop',
  },
  forRange: {
    label: 'For loop (counter)',
    icon: 'i-mdi-counter',
    keywords: 'for range index count loop',
  },
  while: {
    label: 'While loop',
    icon: 'i-mdi-sync',
    keywords: 'while loop condition repeat',
  },
  switch: {
    label: 'Switch / match',
    icon: 'i-mdi-call-split',
    keywords: 'switch match case select',
  },
  try: {
    label: 'Try / catch',
    icon: 'i-mdi-shield-outline',
    keywords: 'try catch except error exception',
  },
  throw: {
    label: 'Throw error',
    icon: 'i-mdi-alert-octagon-outline',
    keywords: 'throw raise error exception',
  },
  break: {
    label: 'Break',
    icon: 'i-mdi-debug-step-out',
    keywords: 'break exit loop stop',
  },
  continue: {
    label: 'Continue',
    icon: 'i-mdi-debug-step-over',
    keywords: 'continue next skip loop',
  },
};

/** Add-node actions at an exec pin (or, without one, at the end). */
function addNodeActions(state: MenuState, after: boolean): ActionEntry[] {
  const fnId = state.from
    ? index.value.nodes.get(state.from.node)?.fn.id
    : placeAt(state.world)?.fnId;
  return [
    // UE's Get / Set of every variable; a Get from an exec pin makes no
    // sense (it has no exec pins).
    ...scopeVariables(fnId).flatMap((variable): ActionEntry[] => [
      ...(state.from
        ? []
        : [
            {
              label: `Get ${variable.expression}`,
              category: 'Variables',
              icon: ICON_VARIABLE,
              hint: variable.type,
              keywords: 'get read',
              action: () =>
                addNode(
                  { type: 'value', expression: variable.expression },
                  state
                ),
            },
          ]),
      ...(variable.constant
        ? []
        : [
            {
              label: `Set ${variable.expression}`,
              category: 'Variables',
              icon: ICON_SET,
              hint: variable.type,
              keywords: 'set assign write',
              action: () =>
                addNode(
                  {
                    type: 'setVar',
                    name: variable.expression,
                    declaration: 'none',
                  },
                  state
                ),
            },
          ]),
    ]),
    ...callables.value.map((callee): ActionEntry => ({
      label: callee,
      category: 'Call function',
      icon: ICON_CALL,
      detail: callSignature(callee).detail,
      action: () => addNode({ type: 'call', callee }, state),
    })),
    ...externalNames.value.map((external): ActionEntry => ({
      label: external.callee,
      category: 'Call function',
      icon: ICON_IMPORT,
      detail: external.detail,
      hint: external.where,
      keywords: `${external.path} import`,
      action: () =>
        addNode({ type: 'call', callee: external.callee }, state, (op) =>
          withImport(external, op)
        ),
    })),
    {
      label: 'Branch (if)',
      category: 'Flow control',
      icon: 'i-mdi-source-branch',
      keywords: 'if condition',
      action: () => addNode({ type: 'branch' }, state),
    },
    ...(after
      ? [
          {
            label: 'Return',
            category: 'Flow control',
            icon: 'i-mdi-keyboard-return text-purple-400',
            action: () => addNode({ type: 'return' }, state),
          },
        ]
      : []),
    // UE's For Each Loop, For Loop, While Loop, Switch …, in the language's
    // syntax; jumps (break, throw) only after a statement, like Return.
    ...(props.types?.flow ?? [])
      .filter((flow) => after || !JUMPS.has(flow))
      // On empty space the node goes to the end of the function, never
      // into a loop: no break / continue there.
      .filter(
        (flow) =>
          state.from !== undefined || (flow !== 'break' && flow !== 'continue')
      )
      .map((flow): ActionEntry => ({
        ...FLOW_ENTRIES[flow],
        category: 'Flow control',
        action: () => addNode({ type: 'flow', flow }, state),
      })),
    {
      label: 'Declare variable…',
      category: 'Variables',
      icon: 'i-mdi-variable text-sky-400',
      keywords: 'let const var set',
      // The search text found this entry, so it is no name ("Declare
      // variable foo" from the typed entries is).
      action: () =>
        void ask({
          label: 'Variable name',
          placeholder: 'value',
          value: '',
          submit: (name) =>
            addNode({ type: 'setVar', name, declaration: 'const' }, state),
        }),
    },
  ];
}

const ICON_MEMBER = 'i-mdi-code-braces text-sky-400';

/**
 * Fields and methods of a value's type, like UE's "Target is …" actions:
 * the fields of an interface or object type of the file, the public members
 * of a class of the file.
 */
function memberEntries(
  pin: Pin,
  source: PinRef,
  state: MenuState
): ActionEntry[] {
  const typeName = String(pin.type);
  const symbols = props.doc?.symbols ?? [];
  const declared = /^[A-Za-z_$][\w$]*$/.test(typeName)
    ? symbols.find(
        (s) =>
          s.name === typeName &&
          s.scope === '' &&
          (s.kind === 'type' || s.kind === 'class')
      )
    : undefined;
  if (!declared) {
    return [];
  }

  const scope = qualifiedName(declared);
  const members =
    declared.kind === 'class'
      ? symbols
          .filter(
            (s) =>
              s.scope === scope &&
              (s.kind === 'variable' ||
                s.kind === 'constant' ||
                s.kind === 'method') &&
              s.name !== 'constructor' &&
              !s.name.startsWith('#') &&
              !s.modifiers.includes('static') &&
              !s.modifiers.includes('private')
          )
          .map((s) => ({
            name: s.name,
            type: s.type?.text ?? String(s.dataType),
            method: s.kind === 'method',
          }))
      : (declared.fields ?? []).map((f) => ({
          name: f.name,
          type: f.type?.text ?? String(f.dataType),
          method: f.method === true,
        }));
  return members.map((member): ActionEntry => ({
    label: member.method ? `.${member.name}()` : `.${member.name}`,
    category: `Members of ${typeName}`,
    icon: member.method ? ICON_CALL : ICON_MEMBER,
    ...(member.method ? {} : { hint: member.type }),
    keywords: `${member.name} get member property field`,
    action: () =>
      emitOp({
        type: 'useValue',
        pin: source,
        expression: member.method
          ? `$value.${member.name}()`
          : `$value.${member.name}`,
        position: { ...state.world },
      }),
  }));
}

/** The searchable actions for a dropped wire or the empty graph. */
function actionEntries(state: MenuState): ActionEntry[] {
  const v = view.value;
  if (!state.from) {
    return [
      ...(props.editable ? addNodeActions(state, true) : []),
      ...(props.editable ? expressionActions(state) : []),
      ...(props.editable
        ? [
            {
              label: 'Paste here',
              category: 'Graph',
              icon: 'i-mdi-content-paste',
              hint: shortcut('V'),
              keywords: 'clipboard insert',
              action: () => void pasteFromClipboard(state.world),
            },
          ]
        : []),
      ...(props.editable && selection.value.length > 0
        ? [
            {
              // UE's "Add Comment…" around the selected nodes.
              label: 'Add comment box around selection…',
              category: 'Graph',
              icon: 'i-mdi-comment-multiple-outline',
              hint: 'C',
              keywords: 'comment box region group',
              action: () =>
                createCommentBox([...selection.value], state.client),
            },
          ]
        : []),
      {
        label: 'Find…',
        category: 'Graph',
        icon: 'i-mdi-magnify',
        hint: shortcut('F'),
        action: () => void openSearch(),
      },
      {
        label: 'Select all',
        category: 'Graph',
        icon: 'i-mdi-select-all',
        hint: shortcut('A'),
        action: () => v?.selectAll(),
      },
      {
        label: 'Zoom to fit all',
        category: 'Graph',
        icon: 'i-mdi-fit-to-screen-outline',
        hint: 'Home',
        action: () => v?.frameAll(),
      },
    ];
  }

  const source = state.from;
  const found = pinOf(source);
  if (!found || !props.editable) {
    return [];
  }

  const { node, pin } = found;
  if (pin.kind === 'exec') {
    return addNodeActions(state, pin.direction === 'out');
  }

  if (pin.direction === 'out') {
    const named = node.kind === 'setVar' || node.kind === 'entry';
    return [
      ...memberEntries(pin, source, state),
      ...callables.value.map((callee): ActionEntry => ({
        label: `${callee}(value)`,
        category: 'Call function with this value',
        icon: ICON_CALL,
        detail: callSignature(callee).detail,
        keywords: callee,
        fits: fitsType(pin.type, callSignature(callee).first),
        action: () =>
          emitOp({
            type: 'callWith',
            pin: source,
            callee,
            position: { ...state.world },
          }),
      })),
      ...externalNames.value
        .filter((external) => external.kind === 'function')
        .map((external): ActionEntry => ({
          label: `${external.callee}(value)`,
          category: 'Call function with this value',
          icon: ICON_IMPORT,
          detail: external.detail,
          hint: external.where,
          fits: fitsType(pin.type, external.first),
          keywords: `${external.callee} ${external.path} import`,
          action: () =>
            emitOp(
              withImport(external, {
                type: 'callWith',
                pin: source,
                callee: external.callee,
                position: { ...state.world },
              })
            ),
        })),
      // Set a variable to this value (`score = value`).
      ...scopeVariables(index.value.nodes.get(source.node)?.fn.id)
        .filter((variable) => !variable.constant)
        .map((variable): ActionEntry => ({
          label: `Set ${variable.expression}`,
          category: 'Variables',
          icon: ICON_SET,
          hint: variable.type,
          keywords: 'set assign store',
          fits: isTypeCompatible(pin.type, variable.dataType),
          action: () =>
            emitOp({
              type: 'useValue',
              pin: source,
              expression: `${variable.expression} = $value`,
              position: { ...state.world },
            }),
        })),
      ...(named
        ? []
        : [
            {
              label: 'Store in variable…',
              category: 'Variables',
              icon: 'i-mdi-variable text-sky-400',
              keywords: 'promote const let',
              action: () => promoteTo(source, pin, state.world),
            },
          ]),
      ...expressionActions(state),
    ];
  }

  const extract = extractEntry(source, pin, state.world);
  return [
    ...variablesNear(node.id).map((variable): ActionEntry => ({
      label: variable.name,
      category: 'Variables',
      icon: ICON_VARIABLE,
      hint: variable.type,
      keywords: 'get',
      fits: isTypeCompatible(variable.type, pin.type),
      action: () =>
        emitOp({ type: 'setInput', pin: source, expression: variable.name }),
    })),
    // Fields and module variables too (the near ones come first).
    ...scopeVariables(index.value.nodes.get(node.id)?.fn.id)
      .filter(
        (variable) =>
          !variablesNear(node.id).some(
            (near) => near.name === variable.expression
          )
      )
      .map((variable): ActionEntry => ({
        label: variable.expression,
        category: 'Variables',
        icon: ICON_VARIABLE,
        hint: variable.type,
        keywords: 'get',
        fits: isTypeCompatible(variable.dataType, pin.type),
        action: () =>
          emitOp({
            type: 'setInput',
            pin: source,
            expression: variable.expression,
          }),
      })),
    ...callables.value.map((callee): ActionEntry => ({
      label: `${callee}()`,
      category: 'Call function',
      icon: ICON_CALL,
      detail: callSignature(callee).detail,
      keywords: callee,
      fits: fitsType(callSignature(callee).returns, pin.type),
      action: () =>
        emitOp({ type: 'setInput', pin: source, expression: `${callee}()` }),
    })),
    ...externalNames.value.map((external): ActionEntry => {
      const expression =
        external.kind === 'function'
          ? `${external.callee}()`
          : external.expression;
      return {
        label: expression,
        category: external.kind === 'function' ? 'Call function' : 'Variables',
        icon: ICON_IMPORT,
        detail: external.detail,
        hint: external.where,
        fits:
          external.kind === 'function'
            ? fitsType(external.returns, pin.type)
            : undefined,
        keywords: `${external.name} ${external.path} import`,
        action: () =>
          emitOp(
            withImport(external, { type: 'setInput', pin: source, expression })
          ),
      };
    }),
    ...expressionActions(state),
    ...(extract.type === undefined || extract.type === 'item'
      ? extract.disabled
        ? []
        : [
            {
              label: extract.label,
              category: 'Value',
              icon: extract.icon,
              action: () => extract.action(),
            },
          ]
      : []),
    {
      label: 'Replace with value…',
      category: 'Value',
      icon: 'i-mdi-form-textbox',
      keywords: 'literal expression',
      action: () =>
        void ask({
          label: 'New value or expression',
          placeholder: pin.type === 'string' ? '"text"' : '42',
          value: pin.range
            ? props.text.slice(pin.range.start, pin.range.end)
            : '',
          submit: (expression) =>
            emitOp({ type: 'setInput', pin: source, expression }),
        }),
    },
  ];
}

/** Actions made from the search text: call or use exactly what was typed. */
function suggestActions(state: MenuState, query: string): ActionEntry[] {
  const found = state.from ? pinOf(state.from) : undefined;
  const source = state.from;
  const reserved = new Set(props.types?.keywords ?? []).has(
    query.split('.')[0] ?? query
  );
  // Names the menu offers already ("greeter()") need no typed twin.
  const known =
    callables.value.includes(query) ||
    externalNames.value.some((e) => e.callee === query);
  const callable = IDENTIFIER_PATH.test(query) && !reserved && !known;
  const declarable = /^[A-Za-z_$][\w$]*$/.test(query) && !reserved;
  if (!props.editable) {
    return [];
  }

  if (!found || !source || found.pin.kind === 'exec') {
    return [
      ...(callable
        ? [
            {
              label: `Call ${query}()`,
              category: 'Typed',
              icon: ICON_CALL,
              action: () => addNode({ type: 'call', callee: query }, state),
            },
          ]
        : []),
      ...(declarable
        ? [
            {
              label: `Declare variable ${query}`,
              category: 'Typed',
              icon: 'i-mdi-variable text-sky-400',
              action: () =>
                addNode(
                  { type: 'setVar', name: query, declaration: 'const' },
                  state
                ),
            },
          ]
        : []),
    ];
  }

  if (found.pin.direction === 'out') {
    return callable
      ? [
          {
            label: `Call ${query}(value)`,
            category: 'Typed',
            icon: ICON_CALL,
            action: () =>
              emitOp({
                type: 'callWith',
                pin: source,
                callee: query,
                position: { ...state.world },
              }),
          },
        ]
      : [];
  }

  // A value written by hand: not an operator alone ("+"), not a variable
  // the menu lists anyway.
  const listed = scopeVariables(
    index.value.nodes.get(found.node.id)?.fn.id
  ).some((v) => v.expression === query);
  return [
    ...(/[\w$'"`]/.test(query) &&
    !listed &&
    (!reserved || VALUE_WORDS.has(query))
      ? [
          {
            label: `Use ${query}`,
            category: 'Typed',
            icon: 'i-mdi-form-textbox',
            action: () =>
              emitOp({ type: 'setInput', pin: source, expression: query }),
          },
        ]
      : []),
    ...(callable
      ? [
          {
            label: `Call ${query}()`,
            category: 'Typed',
            icon: ICON_CALL,
            action: () =>
              emitOp({
                type: 'setInput',
                pin: source,
                expression: `${query}()`,
              }),
          },
        ]
      : []),
  ];
}

/** Reserved words that are values (`Use true`), unlike `return`. */
const VALUE_WORDS: ReadonlySet<string> = new Set([
  'true',
  'false',
  'null',
  'undefined',
  'this',
  'True',
  'False',
  'None',
  'self',
]);

/** Title of the action menu, like "Actions taking a string". */
function actionTitle(state: MenuState): string {
  const found = state.from ? pinOf(state.from) : undefined;
  if (!found) {
    return 'All actions';
  }

  if (found.pin.kind === 'exec') {
    return found.pin.direction === 'out' ? 'Add node after' : 'Add node before';
  }

  return found.pin.direction === 'out'
    ? `Actions taking ${String(found.pin.type)}`
    : `Actions providing ${String(found.pin.type)}`;
}

/** Copies the code of nodes (like Ctrl+C); false when there is none. */
async function copyCode(ids: ReadonlyArray<string>): Promise<boolean> {
  const { code } = selectionCode(ids);
  if (!code) {
    show('These nodes have no source code to copy.');
    return false;
  }

  try {
    await navigator.clipboard.writeText(code);
    return true;
  } catch {
    show('The clipboard is not available.', 'error');
    return false;
  }
}

async function cutNodes(ids: ReadonlyArray<string>): Promise<void> {
  if (await copyCode(ids)) {
    emitOp({ type: 'deleteNodes', nodeIds: [...ids] });
  }
}

/** "Paste": after the node when it is a statement, else at the point. */
async function pasteFromClipboard(
  world: Point,
  nodeId?: string
): Promise<void> {
  let code = '';
  try {
    code = await navigator.clipboard.readText();
  } catch {
    show('The clipboard is not available.', 'error');
    return;
  }

  if (!code.trim()) {
    show('The clipboard is empty.');
    return;
  }

  const node = nodeId ? index.value.nodes.get(nodeId)?.node : undefined;
  pasteCode(
    code,
    world,
    node?.purity === 'impure' ? continuation(node) : undefined
  );
}

/**
 * UE's "Find References": selects every Get / Set of the node's variable
 * or every call of its function (the Details panel lists them).
 */
function findReferences(nodeId: string): void {
  const doc = props.doc;
  const entry = index.value.nodes.get(nodeId);
  const name = entry ? referenceName(entry.node) : undefined;
  if (!doc || !entry || !name) {
    return;
  }

  const bare = name.replace(/^(?:this|self)\./, '');
  const isCall = entry.node.kind === 'call';
  const kinds = isCall
    ? ['function', 'method', 'import']
    : ['variable', 'constant', 'local', 'import'];
  const candidates = (doc.symbols ?? []).filter(
    (s) => s.name === bare && kinds.includes(s.kind)
  );
  const owner = doc.symbols?.find(
    (s) => s.fnId === entry.fn.id && s.kind !== 'class'
  );
  const symbol =
    candidates.find(
      (s) => s.kind === 'local' && owner && s.scope === qualifiedName(owner)
    ) ?? candidates.find((s) => s.kind !== 'local');
  const found = symbol
    ? symbolNodes(doc, symbol)
    : doc.functions
        .flatMap((f) => f.nodes)
        .filter((n) => referenceName(n) === name)
        .map((n) => n.id);
  const ids = found.includes(nodeId) ? found : [nodeId, ...found];
  selectNodes(ids);
  show(
    `${ids.length} ${ids.length === 1 ? 'reference' : 'references'} of ${name}`
  );
}

/** "Replace with…": other variables for a Get / Set, functions for a call. */
function replaceEntries(nodeId: string): ActionEntry[] {
  const entry = index.value.nodes.get(nodeId);
  const current = entry ? referenceName(entry.node) : undefined;
  if (!entry || !current) {
    return [];
  }

  const replace = (name: string): GraphOp => ({
    type: 'replaceReference',
    node: nodeId,
    name,
  });
  if (entry.node.kind === 'call') {
    return [
      ...callables.value
        .filter((callee) => callee !== current)
        .map((callee): ActionEntry => ({
          label: callee,
          category: 'Functions',
          icon: ICON_CALL,
          detail: callSignature(callee).detail,
          keywords: callee,
          action: () => emitOp(replace(callee)),
        })),
      ...externalNames.value
        .filter((e) => e.kind === 'function' && e.callee !== current)
        .map((external): ActionEntry => ({
          label: external.callee,
          category: 'Functions',
          icon: ICON_IMPORT,
          detail: external.detail,
          hint: external.where,
          keywords: `${external.callee} ${external.path} import`,
          action: () => emitOp(withImport(external, replace(external.callee))),
        })),
    ];
  }

  const isSet = entry.node.kind === 'setVar';
  const pin = entry.node.pins.find(
    (p) => p.kind === 'data' && p.direction === (isSet ? 'in' : 'out')
  );
  return scopeVariables(entry.fn.id)
    .filter((v) => v.expression !== current && !(isSet && v.constant))
    .map((variable): ActionEntry => ({
      label: variable.expression,
      category: 'Variables',
      icon: isSet ? ICON_SET : ICON_VARIABLE,
      hint: variable.type,
      keywords: variable.expression,
      ...(pin
        ? {
            fits: isSet
              ? isTypeCompatible(pin.type, variable.dataType)
              : isTypeCompatible(variable.dataType, pin.type),
          }
        : {}),
      action: () => emitOp(replace(variable.expression)),
    }));
}

function replaceTitle(nodeId: string): string {
  const node = index.value.nodes.get(nodeId)?.node;
  return `Replace ${node ? (referenceName(node) ?? node.title) : ''} with`;
}

function replaceSuggest(nodeId: string, query: string): ActionEntry[] {
  const name = query.trim();
  return /^[A-Za-z_$#][\w$]*(?:\.[A-Za-z_$#][\w$]*)*$/.test(name)
    ? [
        {
          label: `Replace with ${name}`,
          category: 'Typed',
          icon: 'i-mdi-swap-horizontal',
          action: () =>
            emitOp({ type: 'replaceReference', node: nodeId, name }),
        },
      ]
    : [];
}

// --------------------------------------------- copy, cut, paste, duplicate

/** Clipboard type that tells which language copied nodes are in. */
const NODES_MIME = 'application/x-vizscript-nodes';

/**
 * The code of the selected nodes, like UE copies nodes: whole statements
 * (with their pure inputs, which are part of them), outermost first, each
 * with its line's indentation so nested lines keep their place.
 */
function selectionCode(ids: ReadonlyArray<string>): {
  code: string;
  statements: GraphNode[];
} {
  const nodes = ids
    .map((id) => index.value.nodes.get(id)?.node)
    .filter((n): n is GraphNode => n !== undefined);
  const ranges = nodes
    .map((node) => ({
      node,
      range: getMeta<StatementMeta>(node).stmt ?? node.range,
    }))
    .filter(({ range }) => range.end > range.start);
  const outer = ranges
    .filter(
      (a) =>
        !ranges.some(
          (b) =>
            b !== a &&
            b.range.start <= a.range.start &&
            a.range.end <= b.range.end &&
            (b.range.start < a.range.start || b.range.end > a.range.end)
        )
    )
    .toSorted((a, b) => a.range.start - b.range.start);
  const code = outer
    .map(({ range }) => {
      const lineStart = props.text.lastIndexOf('\n', range.start - 1) + 1;
      const before = props.text.slice(lineStart, range.start);
      const indent = /^[ \t]*$/.test(before) ? before : '';
      return indent + props.text.slice(range.start, range.end);
    })
    .join('\n');
  return {
    code,
    statements: outer
      .map(({ node }) => node)
      .filter((n) => n.purity === 'impure'),
  };
}

function canvasHasFocus(): boolean {
  return document.activeElement === canvas.value;
}

function onCopy(event: ClipboardEvent, cut = false): void {
  if (!canvasHasFocus() || selection.value.length === 0) {
    return;
  }

  const { code } = selectionCode(selection.value);
  if (!code) {
    return;
  }

  event.preventDefault();
  event.clipboardData?.setData('text/plain', code);
  event.clipboardData?.setData(
    NODES_MIME,
    JSON.stringify({ language: props.doc?.language ?? '' })
  );
  if (cut && props.editable) {
    emitOp({ type: 'deleteNodes', nodeIds: [...selection.value] });
  }
}

/** Exec output that continues after a statement (`completed` of blocks). */
function continuation(node: GraphNode): PinRef | undefined {
  const out =
    node.pins.find(
      (p) => p.kind === 'exec' && p.direction === 'out' && p.id === 'completed'
    ) ??
    node.pins.find(
      (p) => p.kind === 'exec' && p.direction === 'out' && p.id === 'then'
    );
  return out ? { node: node.id, pin: out.id } : undefined;
}

/** Where the pointer is in the graph, else the middle of the view. */
function pointerWorld(): Point | undefined {
  const v = view.value;
  const rect = canvas.value?.getBoundingClientRect();
  if (!v || !rect) {
    return undefined;
  }

  const inside =
    pointer.x >= rect.left &&
    pointer.x <= rect.right &&
    pointer.y >= rect.top &&
    pointer.y <= rect.bottom;
  return inside
    ? v.worldAt(pointer.x, pointer.y)
    : v.worldAt(rect.left + rect.width / 2, rect.top + rect.height / 2);
}

/**
 * Inserts code as nodes: after the selected statement, else at the end of
 * the function under the pointer, where the pointer is.
 */
function pasteCode(code: string, world: Point, after?: PinRef): void {
  const template: NodeTemplate = { type: 'code', code };
  if (after) {
    emitOp({ type: 'addNode', template, after, position: world });
    return;
  }

  const place = placeAt(world);
  if (!place) {
    show('Paste inside a function.');
    return;
  }

  emitOp({ type: 'addNode', template, ...place.anchor, position: world });
}

function onPaste(event: ClipboardEvent): void {
  if (!canvasHasFocus() || !props.editable) {
    return;
  }

  const code = event.clipboardData?.getData('text/plain') ?? '';
  const world = pointerWorld();
  if (!code.trim() || !world) {
    return;
  }

  event.preventDefault();
  try {
    const from = JSON.parse(
      event.clipboardData?.getData(NODES_MIME) || '{}'
    ) as { language?: string };
    if (from.language && from.language !== props.doc?.language) {
      show(`Pasted ${from.language} code into a ${props.doc?.language} file.`);
    }
  } catch {
    // not copied from a graph
  }

  // After the selected statement when the pointer is in its function,
  // else at the end of the function under the pointer.
  const only = selection.value.length === 1 ? selection.value[0] : undefined;
  const entry = only ? index.value.nodes.get(only) : undefined;
  const sameFunction = entry?.fn.id === view.value?.functionAt(world);
  pasteCode(
    code,
    world,
    entry?.node.purity === 'impure' && sameFunction
      ? continuation(entry.node)
      : undefined
  );
}

/** Asks for a name and collapses the nodes into a new function. */
function collapseToFunction(ids: ReadonlyArray<string>): void {
  const doc = props.doc;
  if (!doc) {
    return;
  }

  const snake = doc.language === 'python' || doc.language === 'gdscript';
  const positions = view.value?.getPositions() ?? {};
  const first = ids
    .map((id) => positions[id])
    .filter((p): p is Point => p !== undefined)
    .reduce<Point | undefined>((a, b) => (!a || b.x < a.x ? b : a), undefined);
  openMenu({
    world: { x: 0, y: 0 },
    client: { x: pointer.x, y: pointer.y },
    target: { kind: 'node', nodeId: ids[0] ?? '' },
  });
  void ask({
    label: 'Name of the new function',
    placeholder: snake ? 'new_function' : 'newFunction',
    value: uniqueName(doc, '', snake ? 'new_function' : 'newFunction'),
    submit: (name) =>
      emitOp({
        type: 'collapseToFunction',
        nodes: [...ids],
        name,
        ...(first ? { position: { ...first } } : {}),
      }),
  });
}

/** UE's Ctrl+D: a copy of the selection right after it. */
function duplicateSelection(): void {
  if (!props.editable || selection.value.length === 0) {
    return;
  }

  const { code, statements } = selectionCode(selection.value);
  const last = statements.at(-1);
  const positions = view.value?.getPositions() ?? {};
  const origin = positions[selection.value[0] ?? ''];
  if (!code) {
    return;
  }

  const world = origin
    ? { x: origin.x + 40, y: origin.y + 40 }
    : pointerWorld();
  if (world) {
    pasteCode(code, world, last ? continuation(last) : undefined);
  }
}

useEventListener(document, 'copy', (event) => onCopy(event));
useEventListener(document, 'cut', (event) => onCopy(event, true));
useEventListener(document, 'paste', onPaste);

function targetEntries(target: ContextTarget, state: MenuState): MenuEntry[] {
  const v = view.value;
  if (!v) {
    return [];
  }

  switch (target.kind) {
    case 'background': {
      // Shown by the searchable action menu.
      return [];
    }

    case 'node': {
      const ids = selection.value.includes(target.nodeId)
        ? selection.value
        : [target.nodeId];
      const first = index.value.nodes.get(target.nodeId);
      const definition =
        ids.length === 1 ? props.definitionOf?.(target.nodeId) : undefined;
      const deletable = ids.some(
        (id) => index.value.nodes.get(id)?.node.kind !== 'entry'
      );
      const reference =
        ids.length === 1 && first ? referenceName(first.node) : undefined;
      return [
        {
          type: 'header',
          label:
            ids.length > 1 ? `${ids.length} nodes` : (first?.node.title ?? ''),
        },
        {
          label: 'Jump to code',
          icon: 'i-mdi-code-tags',
          shortcut: 'Double-click',
          action: () => emit('activate', target.nodeId),
        },
        ...(definition
          ? [
              {
                label: `Go to definition (${definition})`,
                icon: 'i-mdi-arrow-top-right',
                shortcut: 'F12',
                action: () => emit('goToDefinition', target.nodeId),
              },
            ]
          : []),
        // The node's own actions first, then the generic editing ones.
        ...(props.editable && ids.length === 1 && first?.node.kind === 'call'
          ? [
              {
                // UE's "Add pin": one more argument to wire or fill in.
                label: 'Add argument pin',
                icon: 'i-mdi-plus-circle-outline',
                action: () =>
                  emitOp({ type: 'addArgument', node: target.nodeId }),
              },
            ]
          : []),
        ...(reference
          ? [
              {
                // UE's "Find References".
                label: `Find references of ${reference}`,
                icon: 'i-mdi-magnify-scan',
                action: () => findReferences(target.nodeId),
              },
            ]
          : []),
        ...(reference && props.editable
          ? [
              {
                // UE's "Replace References" / "Replace with".
                label:
                  first?.node.kind === 'call'
                    ? 'Replace function…'
                    : 'Replace variable…',
                icon: 'i-mdi-swap-horizontal',
                action: () => {
                  replacing.value = target.nodeId;
                },
              },
            ]
          : []),
        ...(props.editable && ids.length === 1
          ? [
              {
                // UE's "Break Node Link(s)".
                label: 'Break node links',
                icon: 'i-mdi-link-variant-off',
                disabled: !first?.fn.edges.some(
                  (e) =>
                    e.kind === 'data' &&
                    (e.from.node === target.nodeId ||
                      e.to.node === target.nodeId)
                ),
                action: () =>
                  emitOp({ type: 'disconnectNode', node: target.nodeId }),
              },
            ]
          : []),
        { type: 'separator' },
        ...(props.editable
          ? [
              {
                label: 'Cut',
                icon: 'i-mdi-content-cut',
                shortcut: shortcut('X'),
                disabled: !deletable,
                action: () => void cutNodes(ids),
              },
            ]
          : []),
        {
          label: 'Copy',
          icon: 'i-mdi-content-copy',
          shortcut: shortcut('C'),
          action: () =>
            void copyCode(ids).then(
              (copied) => copied && show('Code copied to the clipboard.')
            ),
        },
        ...(props.editable
          ? [
              {
                label: 'Paste',
                icon: 'i-mdi-content-paste',
                shortcut: shortcut('V'),
                action: () =>
                  void pasteFromClipboard(
                    state.world,
                    ids.length === 1 ? target.nodeId : undefined
                  ),
              },
              {
                label: 'Duplicate',
                icon: 'i-mdi-content-duplicate',
                shortcut: shortcut('D'),
                action: () => duplicateSelection(),
              },
            ]
          : []),
        ...(props.editable
          ? [
              {
                // UE's "Collapse to Function".
                label: 'Collapse to function…',
                icon: 'i-mdi-function-variant',
                // Only inside named functions and methods for now.
                disabled: !props.doc?.symbols?.some(
                  (sym) =>
                    sym.fnId === first?.fn.id &&
                    (sym.kind === 'function' || sym.kind === 'method')
                ),
                action: () => collapseToFunction(ids),
              },
            ]
          : []),
        { type: 'separator' },
        {
          label: 'Zoom to selection',
          icon: 'i-mdi-image-filter-center-focus',
          shortcut: 'F',
          action: () => v.frameSelection(),
        },
        {
          label: `Select all of ${first?.fn.name ?? 'function'}`,
          icon: 'i-mdi-selection-multiple',
          disabled: !first,
          action: () => first && v.selectFunction(first.fn.id),
        },
        {
          label: 'Reset position',
          icon: 'i-mdi-auto-fix',
          action: () => emit('resetLayout', ids),
        },
        // UE's alignment section (positions only, the code stays).
        { type: 'header', label: 'Alignment' },
        {
          label: 'Straighten connections',
          icon: 'i-mdi-ray-start-end',
          shortcut: 'Q',
          action: () => v.alignSelection('straighten'),
        },
        ...(ids.length > 1
          ? ALIGN_ENTRIES.map((entry) => ({
              label: entry.label,
              icon: entry.icon,
              shortcut: entry.keys
                ? isMac
                  ? entry.keys.replace('Alt+', '⌥').replace('Shift+', '⇧')
                  : entry.keys
                : undefined,
              action: () => v.alignSelection(entry.mode),
            }))
          : []),
        ...(props.editable
          ? [
              { type: 'separator' as const },
              {
                label: first?.node.comment ? 'Edit comment…' : 'Add comment…',
                icon: 'i-mdi-comment-text-outline',
                shortcut: first?.node.comment ? 'Double-click' : undefined,
                action: () =>
                  editComment({ kind: 'node', nodeId: target.nodeId }),
              },
              ...(first?.node.comment
                ? [
                    {
                      label: 'Remove comment',
                      icon: 'i-mdi-comment-remove-outline',
                      action: () =>
                        emitOp({
                          type: 'setComment',
                          node: target.nodeId,
                          text: '',
                        }),
                    },
                  ]
                : []),
              {
                label: 'Create comment box…',
                icon: 'i-mdi-comment-multiple-outline',
                shortcut: 'C',
                action: () => createCommentBox(ids, state.client),
              },
              { type: 'separator' as const },
              {
                label: ids.length > 1 ? 'Delete nodes' : 'Delete',
                icon: 'i-mdi-delete-outline',
                shortcut: 'Del',
                danger: true,
                disabled: !deletable,
                action: () =>
                  emit('op', { type: 'deleteNodes', nodeIds: [...ids] }),
              },
            ]
          : []),
      ];
    }

    case 'pin': {
      const entry = index.value.nodes.get(target.pin.node);
      const pin = entry?.node.pins.find((p) => p.id === target.pin.pin);
      if (!entry || !pin) {
        return [];
      }

      const edges = pinEdges(index.value, entry.node.id, pin);
      const peers = edges.map((e) =>
        pin.direction === 'in' ? e.from.node : e.to.node
      );
      const source = { ...toRaw(target.pin) };
      const argument =
        entry.node.kind === 'call' && pin.range && ARG_PIN.test(pin.id)
          ? pin.range
          : undefined;
      const fallback = getMeta<InputPinMeta>(pin).defaultValue;
      const current = pin.range
        ? props.text.slice(pin.range.start, pin.range.end)
        : undefined;
      return [
        {
          type: 'header',
          label: `${pin.name || (pin.kind === 'exec' ? 'Exec' : 'Value')} · ${
            pin.kind === 'exec' ? 'exec' : String(pin.type)
          }`,
        },
        ...(pin.literal && edges.length === 0 && props.editable
          ? [
              {
                label: 'Edit value',
                icon: 'i-mdi-pencil-outline',
                shortcut: 'Double-click',
                action: () => v.editLiteral(entry.node.id, pin.id),
              },
            ]
          : []),
        ...(argument &&
        fallback !== undefined &&
        edges.length === 0 &&
        current !== fallback &&
        props.editable
          ? [
              {
                // UE's "Reset to default value": the last argument (or a
                // keyword one) is left out, others get the default written.
                label: `Reset to default (${fallback})`,
                icon: 'i-mdi-restore',
                action: () =>
                  emitOp(
                    pin.name.endsWith('=') ||
                      !entry.node.pins.some(
                        (p) =>
                          ARG_PIN.test(p.id) &&
                          p.range !== undefined &&
                          p.range.start > argument.start
                      )
                      ? { type: 'removeArgument', pin: source }
                      : { type: 'setInput', pin: source, expression: fallback }
                  ),
              },
            ]
          : []),
        ...(pin.kind === 'data' && pin.direction === 'in' && props.editable
          ? [extractEntry(source, pin, state.world)]
          : []),
        ...(pin.kind === 'data' &&
        pin.direction === 'out' &&
        entry.node.kind !== 'setVar' &&
        entry.node.kind !== 'entry' &&
        props.editable
          ? [
              {
                label: 'Promote to variable…',
                icon: 'i-mdi-variable text-sky-400',
                action: () => promoteTo(source, pin, state.world),
              },
            ]
          : []),
        {
          label:
            pin.direction === 'in'
              ? 'Select connected source'
              : 'Select connected targets',
          icon: 'i-mdi-ray-start-arrow',
          disabled: peers.length === 0,
          action: () => selectNodes([...new Set(peers)]),
        },
        ...(props.editable
          ? [
              {
                label: edges.length > 1 ? 'Break all links' : 'Break link',
                icon: 'i-mdi-link-variant-off',
                shortcut: 'Alt+Click',
                disabled:
                  pin.kind === 'exec' ||
                  (pin.direction === 'in' ? !pin.range : edges.length === 0),
                action: () => emit('op', { type: 'disconnect', pin: source }),
              },
              // UE's "Break link to …": one wire of several.
              ...(edges.length > 1
                ? edges.map((edge) => {
                    const peer = pin.direction === 'in' ? edge.from : edge.to;
                    const node = index.value.nodes.get(peer.node)?.node;
                    const name = node?.pins.find(
                      (p) => p.id === peer.pin
                    )?.name;
                    return {
                      label: `Break link to ${node?.title ?? 'node'}${name ? ` · ${name}` : ''}`,
                      icon: 'i-mdi-link-variant-minus',
                      disabled: edge.kind === 'exec',
                      action: () =>
                        emit('op', {
                          type: 'disconnect',
                          pin: { ...toRaw(edge.to) },
                        }),
                    };
                  })
                : []),
              ...(argument
                ? [
                    {
                      // UE's "Remove pin" (for added pins).
                      label: 'Remove argument pin',
                      icon: 'i-mdi-minus-circle-outline',
                      danger: true,
                      action: () =>
                        emitOp({ type: 'removeArgument', pin: source }),
                    },
                  ]
                : []),
            ]
          : []),
      ];
    }

    case 'wire': {
      const edge = target.edge;
      const knots = v.getReroutes(edge.id).length;
      return [
        {
          type: 'header',
          label: edge.kind === 'exec' ? 'Execution wire' : 'Data wire',
        },
        {
          label: 'Add reroute node',
          icon: 'i-mdi-circle-medium',
          shortcut: 'Double-click',
          action: () => v.addReroute(edge.id, state.world),
        },
        {
          label: 'Remove reroute nodes',
          icon: 'i-mdi-vector-polyline-remove',
          disabled: knots === 0,
          action: () => v.clearReroutes(edge.id),
        },
        { type: 'separator' },
        {
          label: 'Select source node',
          icon: 'i-mdi-ray-start',
          action: () => selectNodes([edge.from.node]),
        },
        {
          label: 'Select target node',
          icon: 'i-mdi-ray-end',
          action: () => selectNodes([edge.to.node]),
        },
        ...(props.editable
          ? [
              { type: 'separator' as const },
              {
                label: 'Break link',
                icon: 'i-mdi-link-variant-off',
                disabled: edge.kind === 'exec',
                action: () =>
                  emit('op', {
                    type: 'disconnect',
                    pin: { ...toRaw(edge.to) },
                  }),
              },
            ]
          : []),
      ];
    }

    case 'knot': {
      return [
        { type: 'header', label: 'Reroute node' },
        {
          label: 'Remove reroute node',
          icon: 'i-mdi-close-circle-outline',
          shortcut: 'Alt+Click',
          action: () => v.removeReroute(target.edgeId, target.index),
        },
        {
          label: 'Remove all on this wire',
          icon: 'i-mdi-vector-polyline-remove',
          action: () => v.clearReroutes(target.edgeId),
        },
      ];
    }

    case 'comment': {
      const fn = props.doc?.functions.find((f) => f.id === target.fnId);
      const box = fn?.comments?.find((b) => b.id === target.boxId);
      if (!box) {
        return [];
      }

      return [
        { type: 'header', label: box.title || 'Comment box' },
        {
          label: 'Select nodes',
          icon: 'i-mdi-selection-multiple',
          action: () => v.setSelection(box.nodes),
        },
        {
          label: 'Frame comment box',
          icon: 'i-mdi-image-filter-center-focus',
          action: () => {
            v.setSelection(box.nodes);
            v.frameSelection();
          },
        },
        {
          label: 'Jump to code',
          icon: 'i-mdi-code-tags',
          action: () => box.nodes[0] && emit('activate', box.nodes[0]),
        },
        ...(props.editable
          ? [
              { type: 'separator' as const },
              {
                label: 'Rename…',
                icon: 'i-mdi-rename-outline',
                shortcut: 'Double-click',
                action: () => editComment({ kind: 'box', boxId: box.id }),
              },
              {
                label: 'Remove comment box',
                icon: 'i-mdi-comment-remove-outline',
                danger: true,
                action: () => emitOp({ type: 'deleteCommentBox', box: box.id }),
              },
            ]
          : []),
      ];
    }

    case 'function': {
      const fn = props.doc?.functions.find((f) => f.id === target.fnId);
      const entryNode = fn?.nodes.find((n) => n.kind === 'entry');
      return [
        { type: 'header', label: fn?.name ?? 'Function' },
        {
          label: 'Open on its own',
          icon: 'i-mdi-arrow-expand',
          shortcut: 'Double-click',
          action: () => emit('openFunction', target.fnId),
        },
        {
          label: 'Select all nodes',
          icon: 'i-mdi-selection-multiple',
          action: () => v.selectFunction(target.fnId),
        },
        {
          label: 'Frame function',
          icon: 'i-mdi-image-filter-center-focus',
          action: () => {
            v.selectFunction(target.fnId);
            v.frameSelection();
          },
        },
        {
          label: 'Jump to code',
          icon: 'i-mdi-code-tags',
          disabled: !entryNode,
          action: () => entryNode && emit('activate', entryNode.id),
        },
        {
          label: 'Reset layout of function',
          icon: 'i-mdi-auto-fix',
          action: () => emit('resetLayout', fn?.nodes.map((n) => n.id) ?? []),
        },
      ];
    }
  }
}

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
  const result = new Map<string, ProblemSeverity>();
  for (const [id, list] of props.problems ?? []) {
    const severity = worstSeverity(list);
    if (severity) {
      result.set(id, severity);
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

function onKeydown(event: KeyboardEvent): void {
  const command = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  if (event.target !== canvas.value) {
    return;
  }

  if (
    event.altKey &&
    (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
  ) {
    event.preventDefault();
    emit('navigate', event.key === 'ArrowLeft' ? 'back' : 'forward');
    return;
  }

  if (command && key === 'z') {
    event.preventDefault();
    if (event.shiftKey) {
      emit('redo');
    } else {
      emit('undo');
    }
  } else if (command && key === 'y') {
    event.preventDefault();
    emit('redo');
  } else if (command && key === 'f') {
    event.preventDefault();
    void openSearch();
  } else if (command && key === 'd') {
    event.preventDefault();
    duplicateSelection();
  } else if (event.key === 'F12' && selection.value.length === 1) {
    event.preventDefault();
    emit('goToDefinition', selection.value[0] ?? '');
  } else if (
    key === 'c' &&
    !command &&
    !event.altKey &&
    !event.shiftKey &&
    selection.value.length > 0
  ) {
    // Like UE: C puts a comment box around the selection.
    event.preventDefault();
    createCommentBox(selection.value, { x: pointer.x, y: pointer.y });
  } else if (event.key === 'ContextMenu' || (event.shiftKey && key === 'f10')) {
    // Keyboard access to the context menu of the selection.
    event.preventDefault();
    const rect = canvas.value?.getBoundingClientRect();
    const first = selection.value[0];
    openMenu({
      world: { x: 0, y: 0 },
      client: { x: (rect?.left ?? 0) + 40, y: (rect?.top ?? 0) + 40 },
      target: first ? { kind: 'node', nodeId: first } : { kind: 'background' },
    });
  }
}

/**
 * UE's node hotkeys: hold a key and click empty space for a node there,
 * at the end of the function under the pointer.
 */
const HOTKEYS: Record<string, { template: NodeTemplate; flow?: FlowTemplate }> =
  {
    b: { template: { type: 'branch' } },
    l: { template: { type: 'flow', flow: 'forEach' }, flow: 'forEach' },
    r: { template: { type: 'return' } },
  };
const heldKey = ref<string | null>(null);

function onHotkeyDown(event: KeyboardEvent): void {
  const key = event.key.toLowerCase();
  if (
    event.target === canvas.value &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey &&
    key in HOTKEYS
  ) {
    heldKey.value = key;
  }
}

function onHotkeyUp(event: KeyboardEvent): void {
  if (event.key.toLowerCase() === heldKey.value) {
    heldKey.value = null;
  }
}

useEventListener(window, 'blur', () => {
  heldKey.value = null;
});

function onPointerDownCapture(event: PointerEvent): void {
  const hotkey = heldKey.value ? HOTKEYS[heldKey.value] : undefined;
  const v = view.value;
  if (!hotkey || !v || !props.editable || event.button !== 0) {
    return;
  }

  const world = v.worldAt(event.clientX, event.clientY);
  if (
    !v.isEmptyAt(world) ||
    (hotkey.flow && !(props.types?.flow ?? []).includes(hotkey.flow))
  ) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  addNode(hotkey.template, {
    world,
    client: { x: event.clientX, y: event.clientY },
    target: { kind: 'background' },
  });
}

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

    <!-- Zoom controls: they only change the view of the graph. -->
    <div
      class="absolute right-3 bottom-3 z-10 flex items-center rounded-md border border-zinc-800 bg-zinc-900/90 text-zinc-300 shadow-lg backdrop-blur"
      data-ui="zoom-controls"
      role="group"
      aria-label="Zoom"
    >
      <button
        type="button"
        class="flex h-7 w-7 items-center justify-center rounded-l-md hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40"
        title="Zoom out"
        aria-label="Zoom out"
        :disabled="zoom <= MIN_ZOOM + 1e-3"
        @click="view?.zoomBy(1 / ZOOM_STEP)"
      >
        <span class="i-mdi-minus" />
      </button>
      <button
        type="button"
        class="h-7 min-w-12 px-1 text-xs tabular-nums hover:bg-zinc-800 hover:text-zinc-100"
        title="Reset zoom to 100%"
        aria-label="Reset zoom to 100%"
        @click="view?.setZoom(1)"
      >
        {{ Math.round(zoom * 100) }}%
      </button>
      <button
        type="button"
        class="flex h-7 w-7 items-center justify-center hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40"
        title="Zoom in"
        aria-label="Zoom in"
        :disabled="zoom >= MAX_ZOOM - 1e-3"
        @click="view?.zoomBy(ZOOM_STEP)"
      >
        <span class="i-mdi-plus" />
      </button>
      <button
        type="button"
        class="flex h-7 w-7 items-center justify-center rounded-r-md border-l border-zinc-800 hover:bg-zinc-800 hover:text-zinc-100"
        title="Zoom to fit all nodes (Home)"
        aria-label="Zoom to fit all nodes"
        @click="view?.frameAll()"
      >
        <span class="i-mdi-fit-to-page-outline" />
      </button>
    </div>

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
