import type {
  ContainerOp,
  FloatingNodes,
  GraphDocument,
  GraphEdit,
  GraphNode,
  GraphOp,
  GraphOverlay,
  ImportedDeclaration,
  InputPinMeta,
  NodeTemplate,
  OverlayIssue,
  PinRef,
  Point,
  Positions,
} from '@vizscript/core';
import {
  callViewKey,
  compactOverlay,
  EMPTY_OVERLAY,
  feedFloating,
  findNode,
  floatingGroup,
  floatingOutput,
  getMeta,
  isCutReceiver,
  isEmptyOverlay,
  sameFloatingNodes,
  splitLoose,
  withFedType,
} from '@vizscript/core';
import type { ComputedRef, Ref, ShallowRef } from 'vue';
import { computed, shallowRef } from 'vue';
import type { GraphClient } from '../../graph/graph-client';
import type { Problem } from '../../graph/problems';
import { useLooseNodes } from './use-loose-nodes';

export interface GraphOverlayDeps {
  /** The layout: loose graph-only nodes are stored with it. */
  pinned: ShallowRef<Positions>;
  /** Changes layout entries without an undo step. */
  patchLayout: (patch: Record<string, Point | null>) => void;
  path: () => string;
  text: Ref<string>;
  client: GraphClient;
  imports: () => ImportedDeclaration[];
  /** The graph as shown (parsed code plus overlay). */
  doc: ShallowRef<GraphDocument | null>;
  /** Writes the synced code (one undo step in the editor). */
  writeCode: (text: string) => void;
  /** The overlay changed: show it, store it with the draft. */
  changed: (overlay: GraphOverlay) => void;
  /** A user's graph-only edit, for undo. */
  record: (before: GraphOverlay, after: GraphOverlay) => void;
  /** The last recorded step also wrote code (one undo for both). */
  recordCode: () => void;
  /** Positions for new floating nodes (where they were dropped). */
  placeFloating: (
    edit: FloatingNodes,
    world: Point,
    fixed?: Positions,
    /** Lay the group out around its kept nodes instead of at `world`. */
    anchored?: boolean,
    /** Other layout entries of the new nodes (`~call|`). */
    extra?: Positions
  ) => void;
  /** Where a node is shown. */
  positionOf: (id: string) => Point | undefined;
  /** Floating nodes with a checker's types (the copy they were made in). */
  typeFloating: (edit: FloatingNodes, text: string) => Promise<FloatingNodes>;
  /** The language's container operations (`TypeSystemInfo.containerOps`). */
  containerOps: () => ReadonlyArray<ContainerOp> | undefined;
  /** The graph-only edits are about to be written (`wrote`: new code). */
  writing: (overlay: GraphOverlay, wrote: boolean) => void;
  /** Floating nodes were written as code: their nodes got these ids. */
  placed: (ids: Record<string, string>) => void;
  show: (message: string, kind?: 'info' | 'error') => void;
}

export interface FloatingOptions {
  /** An input the new value is wired into (a method's empty `this`). */
  wireTo?: PinRef;
  /** Floating nodes the new ones take over (with places and wires). */
  replaces?: ReadonlyArray<FloatingNodes>;
  /** A value of the code wired where the placeholder was written. */
  feed?: { from: PinRef; placeholder: string };
  /** The new nodes go around the ones taken over, not at `world`. */
  anchored?: boolean;
  /**
   * The new call is drawn as a call, also when it is a container
   * operation (`items.push(x)`, not ADD): the menu's call entries.
   */
  asCall?: boolean;
}

export interface WorkspaceGraphOverlay {
  overlay: ShallowRef<GraphOverlay>;
  issues: ShallowRef<OverlayIssue[]>;
  outOfSync: ComputedRef<boolean>;
  /** Nodes drawn as "not in code" (graph-only, or named by an issue). */
  syncNodes: ComputedRef<Set<string>>;
  /** The issues as problems (Problems panel, node tooltips). */
  syncProblems: ComputedRef<Problem[]>;
  /** Keeps edits in the graph only; writes code once it is valid. */
  addEdits: (edits: ReadonlyArray<GraphEdit>) => void;
  /**
   * The overlay remapped to a new parse of the code (same edits, the code's
   * nodes under their new ids): its loose nodes are stored again, since
   * their wires name nodes of the code.
   */
  followCode: (overlay: GraphOverlay) => void;
  /**
   * Nodes with no place in the code yet: they float where they were dropped
   * until they are wired in.
   */
  addFloating: (
    template: NodeTemplate,
    world: Point,
    fnId: string | undefined,
    options?: FloatingOptions
  ) => Promise<void>;
  /**
   * A node made from a dragged value (`.log()`, "Call … with this value")
   * floats unwired, like UE's: a floating value joins it (the same Get),
   * a value of the code is wired to it in the graph. `false` when it is
   * written as code instead (a lone value of a value of the code).
   */
  floatValueUse: (
    op: Extract<GraphOp, { type: 'useValue' | 'callWith' }>,
    placeholder: string
  ) => Promise<boolean>;
  /** A value for an input of a floating node; `false` for code's nodes. */
  floatInput: (op: Extract<GraphOp, { type: 'setInput' }>) => Promise<boolean>;
  /**
   * A value wired into the empty `this` of a floating call (`round()`):
   * the call is made again with it (`Math.round()`), so it gets the typed
   * pins of what it calls. `false` for other wires.
   */
  floatReceiver: (
    op: { from: PinRef; to: PinRef },
    placeholder: string
  ) => Promise<boolean>;
  /**
   * A value for a method's empty `this` (its wire broken in the graph): its
   * nodes are added in the graph and wired in (a parameter from the entry
   * node). `false` for other inputs.
   */
  fillCutReceiver: (
    op: Extract<GraphOp, { type: 'setInput' }>,
    before: () => void
  ) => Promise<boolean>;
  /** Replaces the overlay (draft loaded, undo, remapped after a parse). */
  setOverlay: (overlay: GraphOverlay) => void;
  discard: () => void;
  /** Writes the overlay as code when the graph is valid. */
  resolve: () => Promise<void>;
  /** Loose nodes stored with the layout, made again (after loading). */
  restoreLoose: () => Promise<void>;
}

/**
 * Graph-only edits (UE lets a graph be in states that don't compile yet):
 * kept as an overlay on the parsed graph, shown as "not in code", and
 * written as code automatically once the whole graph is valid again.
 */
export function useGraphOverlay(
  deps: GraphOverlayDeps,
  initial: GraphOverlay | undefined
): WorkspaceGraphOverlay {
  const overlay = shallowRef<GraphOverlay>(initial ?? EMPTY_OVERLAY);
  const issues = shallowRef<OverlayIssue[]>([]);
  /**
   * Loose graph-only nodes (wired to nothing of the code) aren't part of
   * the program: only the rest holds the code back.
   */
  const split = computed(() => splitLoose(overlay.value));
  const outOfSync = computed(() => !isEmptyOverlay(split.value.active));
  /** The last change was the user's graph edit (its undo step takes code). */
  let userEdit = false;
  let told = false;
  let seq = 0;

  const looseNodes = useLooseNodes({
    ...deps,
    overlay: () => overlay.value,
    setOverlay: (next) => setOverlay(next),
  });

  function setOverlay(next: GraphOverlay): void {
    overlay.value = next;
    looseNodes.store(next);
    if (isEmptyOverlay(next)) {
      issues.value = [];
      told = false;
    }

    deps.changed(next);
  }

  function addEdits(edits: ReadonlyArray<GraphEdit>): void {
    const before = overlay.value;
    // Floating nodes deleted again leave nothing behind.
    const after = compactOverlay({ edits: [...before.edits, ...edits] });
    deps.record(before, after);
    userEdit = true;
    if (!told) {
      told = true;
      deps.show(
        'Kept in the graph only: the code follows once the graph is valid again.'
      );
    }

    setOverlay(after);
    void resolve();
  }

  let groups = 0;
  async function addFloating(
    template: NodeTemplate,
    world: Point,
    fnId: string | undefined,
    options: FloatingOptions = {}
  ): Promise<void> {
    const { wireTo, replaces, feed, anchored, asCall } = options;
    const group = `${Date.now().toString(36)}${(groups++).toString(36)}`;
    const result = await deps.client.floatingNodes(
      deps.text.value,
      deps.path(),
      template,
      fnId,
      group,
      deps.imports()
    );
    if (!result.ok) {
      deps.show(result.error, 'error');
      return;
    }

    let edit = await deps.typeFloating(result.edit, result.text);
    const edits: GraphEdit[] = [];
    if (feed) {
      const fed = feedFloating(edit, feed.placeholder, feed.from);
      if (!fed) {
        deps.show('The value cannot be wired into the new node.', 'error');
        return;
      }

      // Typed by the value it is wired to: the menu's ADD is ADD at once.
      const source = deps.doc.value
        ? findNode(deps.doc.value, feed.from.node)?.pins.find(
            (p) => p.id === feed.from.pin
          )
        : undefined;
      edit =
        source && fed.edge.type === 'addEdge'
          ? withFedType(fed.edit, fed.edge.to, source, deps.containerOps())
          : fed.edit;
      edits.push(fed.edge);
    }

    // Nodes taken over keep their places (the same Get, not a second one)
    // and their graph-only wires.
    const fixed: Positions = {};
    const taken = new Map<string, string>();
    for (const replaced of replaces ?? []) {
      for (const [from, to] of sameFloatingNodes(replaced, edit)) {
        if ([...taken.values()].includes(to)) {
          continue;
        }

        taken.set(from, to);
        const p = deps.positionOf(from);
        if (p) {
          fixed[to] = p;
        }
      }
    }

    const groupNodes = new Set(
      (replaces ?? []).flatMap((g) => g.nodes.map((n) => n.id))
    );
    const rewired = overlay.value.edits.flatMap((e): GraphEdit[] => {
      if (
        e.type !== 'addEdge' ||
        (!groupNodes.has(e.from.node) && !groupNodes.has(e.to.node))
      ) {
        return [];
      }

      const from = groupNodes.has(e.from.node)
        ? taken.get(e.from.node)
        : e.from.node;
      const to = groupNodes.has(e.to.node) ? taken.get(e.to.node) : e.to.node;
      // Wires inside the replaced groups are part of the new one.
      const inside = groupNodes.has(e.from.node) && groupNodes.has(e.to.node);
      return from && to && !inside
        ? [{ ...e, from: { ...e.from, node: from }, to: { ...e.to, node: to } }]
        : [];
    });

    deps.placeFloating(
      edit,
      world,
      fixed,
      anchored,
      asCall ? callViews(edit) : undefined
    );
    const out = wireTo ? floatingOutput(edit) : undefined;
    addEdits([
      // Removing one node of a floating group drops all of it.
      ...(replaces ?? []).flatMap((g) =>
        g.nodes[0] ? [{ type: 'removeNode' as const, node: g.nodes[0].id }] : []
      ),
      edit,
      ...edits,
      ...rewired,
      ...(out && wireTo
        ? [
            {
              type: 'addEdge' as const,
              kind: 'data' as const,
              from: out,
              to: wireTo,
            },
          ]
        : []),
    ]);
  }

  /**
   * The new call of `edit` (its outermost one) drawn as a call when it is
   * a container operation of the language (`~call|`).
   */
  function callViews(edit: FloatingNodes): Positions | undefined {
    const names = new Set(
      (deps.containerOps() ?? [])
        .filter((o) => o.form !== 'operator')
        .map((o) => o.name)
    );
    const outer = edit.nodes
      .filter((n) => n.kind === 'call')
      .reduce<GraphNode | undefined>(
        (best, n) =>
          !best ||
          n.range.end - n.range.start > best.range.end - best.range.start
            ? n
            : best,
        undefined
      );
    return outer && names.has(outer.title)
      ? { [callViewKey(outer.id)]: { x: 0, y: 0 } }
      : undefined;
  }

  /** The name of a function's input at `ref`, if it is one. */
  function inputName(ref: PinRef): string | undefined {
    const doc = deps.doc.value;
    const node = doc ? findNode(doc, ref.node) : undefined;
    const pin = node?.pins.find((p) => p.id === ref.pin);
    return node?.kind === 'entry' &&
      pin?.kind === 'data' &&
      /^[A-Za-z_$][\w$]*$/.test(pin.name)
      ? pin.name
      : undefined;
  }

  async function floatValueUse(
    op: Extract<GraphOp, { type: 'useValue' | 'callWith' }>,
    placeholder: string
  ): Promise<boolean> {
    const shown = deps.doc.value;
    const fnId = shown?.functions.find((f) =>
      f.nodes.some((n) => n.id === op.pin.node)
    )?.id;
    const write = (value: string): string =>
      op.type === 'callWith'
        ? `${op.callee}(${value})`
        : op.expression.replaceAll('$value', value);
    const world = op.position ?? { x: 0, y: 0 };
    const asCall = op.type === 'callWith' || op.container !== true;
    const name = floatingGroup(op.pin.node);
    if (name !== undefined) {
      const group = overlay.value.edits.find(
        (e): e is FloatingNodes => e.type === 'addNodes' && e.id === name
      );
      // A floating value: one group with the new node (the same Get). A
      // statement not wired into the flow yet (`new Error()`) too.
      if (!group || execWired(group)) {
        return false;
      }

      await addFloating(
        { type: 'value', expression: write(group.code.replace(/;\s*$/, '')) },
        world,
        fnId ?? group.fnId,
        { replaces: [group], asCall }
      );
      return true;
    }

    // Only calls float; a lone value of the code's value (`.length`) is
    // written as code.
    if (op.type === 'useValue' && !/\)\s*$/.test(op.expression)) {
      return false;
    }

    // A function's input is written by its name (`items.push('')`): the
    // new nodes are wired to it and typed by it like code (the checker
    // names `push`'s value pin), with no placeholder to feed.
    const input = inputName(op.pin);
    if (input !== undefined) {
      await addFloating(
        { type: 'value', expression: write(input) },
        world,
        fnId,
        {
          asCall,
        }
      );
      return true;
    }

    await addFloating(
      { type: 'value', expression: write(placeholder) },
      world,
      fnId,
      {
        feed: { from: op.pin, placeholder },
        asCall,
      }
    );
    return true;
  }

  /** Whether a floating group is wired into the flow (graph-only). */
  function execWired(group: FloatingNodes): boolean {
    const ids = new Set(group.nodes.map((n) => n.id));
    return overlay.value.edits.some(
      (e) =>
        e.type === 'addEdge' &&
        e.kind === 'exec' &&
        (ids.has(e.from.node) || ids.has(e.to.node))
    );
  }

  /**
   * A value for an input of a floating node (a new `new Error()` for a
   * floating Throw): the group is made again with it written in place of
   * the input's value. `false` for inputs of the code's nodes.
   */
  async function floatInput(
    op: Extract<GraphOp, { type: 'setInput' }>
  ): Promise<boolean> {
    const name = floatingGroup(op.pin.node);
    const group = overlay.value.edits.find(
      (e): e is FloatingNodes => e.type === 'addNodes' && e.id === name
    );
    const node = group?.nodes.find((n) => n.id === op.pin.node);
    const raw = node?.pins.find((p) => p.id === op.pin.pin)?.literal?.raw;
    if (!group || !node || raw === undefined) {
      return false;
    }

    // The value's text in the node's code (pins point into the copy the
    // group was made in): only when it is there once.
    const own = group.code.slice(node.range.start, node.range.end);
    const at = own.indexOf(raw);
    if (at === -1 || own.indexOf(raw, at + 1) !== -1) {
      return false;
    }

    const start = node.range.start + at;
    const code = `${group.code.slice(0, start)}${op.expression}${group.code.slice(start + raw.length)}`;
    const statement = group.nodes.some((n) =>
      n.pins.some((p) => p.kind === 'exec')
    );
    await addFloating(
      statement ? { type: 'code', code } : { type: 'value', expression: code },
      // Laid out around the node it was set on, which keeps its place.
      deps.positionOf(node.id) ?? op.position ?? { x: 0, y: 0 },
      group.fnId,
      { replaces: [group], anchored: true }
    );
    return true;
  }

  async function floatReceiver(
    op: { from: PinRef; to: PinRef },
    placeholder: string
  ): Promise<boolean> {
    const name = floatingGroup(op.to.node);
    const call = overlay.value.edits.find(
      (e): e is FloatingNodes => e.type === 'addNodes' && e.id === name
    );
    const node = call?.nodes.find((n) => n.id === op.to.node);
    const pin = node?.pins.find((p) => p.id === op.to.pin);
    const meta = pin ? getMeta<InputPinMeta>(pin) : undefined;
    if (
      !call ||
      node?.kind !== 'call' ||
      !pin ||
      pin.range ||
      meta?.insertInitAt === undefined ||
      floatingGroup(op.from.node) === name
    ) {
      return false;
    }

    // `round();` → `$value.round()`, the receiver where it goes.
    const code = call.code.replace(/;?\s*$/, '');
    const at = node.range.start;
    const expression = `${code.slice(0, at)}${meta.insertPrefix ?? ''}$value${meta.insertSuffix ?? ''}${code.slice(at)}`;
    const world = deps.positionOf(node.id) ?? { x: 0, y: 0 };
    const sourceName = floatingGroup(op.from.node);
    const source = overlay.value.edits.find(
      (e): e is FloatingNodes => e.type === 'addNodes' && e.id === sourceName
    );
    if (source) {
      // A floating value: one group with both (the same Get).
      if (source.nodes.some((n) => n.pins.some((p) => p.kind === 'exec'))) {
        return false;
      }

      const value = source.code.replace(/;?\s*$/, '');
      await addFloating(
        { type: 'value', expression: expression.replace('$value', value) },
        world,
        call.fnId,
        { replaces: [call, source] }
      );
      return true;
    }

    await addFloating(
      { type: 'value', expression: expression.replace('$value', placeholder) },
      world,
      call.fnId,
      { replaces: [call], feed: { from: op.from, placeholder } }
    );
    return true;
  }

  async function fillCutReceiver(
    op: Extract<GraphOp, { type: 'setInput' }>,
    before: () => void
  ): Promise<boolean> {
    const shown = deps.doc.value;
    if (!shown || !isCutReceiver(shown, op.pin)) {
      return false;
    }

    const fn = shown.functions.find((f) =>
      f.nodes.some((n) => n.id === op.pin.node)
    );
    before();
    // A parameter is wired from the entry node (it has no Get node).
    const entry = fn?.nodes.find((n) => n.kind === 'entry');
    const param = entry?.pins.find(
      (p) =>
        p.kind === 'data' &&
        p.direction === 'out' &&
        p.name === op.expression.trim()
    );
    if (entry && param) {
      addEdits([
        {
          type: 'addEdge',
          kind: 'data',
          from: { node: entry.id, pin: param.id },
          to: op.pin,
        },
      ]);
    } else {
      await addFloating(
        { type: 'value', expression: op.expression },
        op.position ?? { x: 0, y: 0 },
        fn?.id,
        { wireTo: op.pin }
      );
    }

    return true;
  }

  function discard(): void {
    const { loose, active } = split.value;
    if (isEmptyOverlay(active)) {
      return;
    }

    // Loose nodes stay: they don't hold the code back.
    deps.record(overlay.value, loose);
    userEdit = false;
    setOverlay(loose);
  }

  async function resolve(): Promise<void> {
    const current = overlay.value;
    const { loose, active } = split.value;
    const source = deps.text.value;
    if (isEmptyOverlay(active)) {
      issues.value = [];
      return;
    }

    const mine = ++seq;
    const result = await deps.client.resolveOverlay(
      source,
      deps.path(),
      active,
      deps.imports()
    );
    // Something changed meanwhile: a newer resolve runs.
    if (
      mine !== seq ||
      overlay.value !== current ||
      deps.text.value !== source
    ) {
      return;
    }

    if (result.status === 'pending') {
      issues.value = result.issues;
      return;
    }

    const wrote = result.text !== source;
    deps.writing(active, wrote);

    if (result.placed) {
      deps.placed(result.placed);
    }

    if (wrote) {
      deps.writeCode(result.text);
    }

    if (userEdit && wrote) {
      deps.recordCode();
    }

    userEdit = false;
    // Written: what stays graph-only is the loose nodes.
    setOverlay(loose);
  }

  const syncNodes = computed(() => {
    const ids = new Set(issues.value.map((i) => i.node).filter(Boolean));
    for (const fn of deps.doc.value?.functions ?? []) {
      for (const n of fn.nodes) {
        if (n.graphOnly) {
          ids.add(n.id);
        }
      }
    }

    return ids;
  });

  const syncProblems = computed((): Problem[] => {
    const doc = deps.doc.value;
    const text = deps.text.value;
    return issues.value.flatMap((issue) => {
      const node = doc && issue.node ? findNode(doc, issue.node) : undefined;
      const range = node?.range ?? { start: 0, end: 0 };
      const before = text.slice(0, range.start).split('\n');
      return [
        {
          message: `Graph not in sync: ${issue.message}`,
          severity: 'warning',
          range,
          line: before.length,
          column: (before.at(-1)?.length ?? 0) + 1,
          source: 'graph',
        },
      ];
    });
  });

  return {
    overlay,
    issues,
    outOfSync,
    syncNodes,
    syncProblems,
    addEdits,
    followCode: (next) => {
      overlay.value = next;
      looseNodes.store(next);
    },
    addFloating,
    floatValueUse,
    floatReceiver,
    floatInput,
    fillCutReceiver,
    setOverlay,
    discard,
    resolve,
    restoreLoose: () => looseNodes.restore(),
  };
}
