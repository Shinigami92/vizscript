import type {
  GraphDocument,
  GraphOp,
  GraphOverlay,
  PinRef,
  Point,
  Positions,
  TextChange,
} from '@vizscript/core';
import {
  adjacentVias,
  findNode,
  foldVias,
  joinKey,
  keptWrapped,
  nodeKey,
  pureSignature,
  renamedNodes,
  viaGets,
  viaJoins,
  viaKey,
  viaSetter,
  wrappedVias,
} from '@vizscript/core';
import type { ComputedRef, ShallowRef } from 'vue';
import { computed } from 'vue';
import type { PureJoin } from './pure-join-ops';
import { fanOut, isPureCopy, pureJoins, withCopyParts } from './pure-join-ops';

export interface ViaWires {
  /** The graph as drawn: remembered Gets as wires from their SET. */
  canvasDoc: ComputedRef<GraphDocument | null>;
  /** An op on a wire drawn from a SET acts on the Get it stands for. */
  throughVias: (op: GraphOp) => GraphOp;
  /** Problems of hidden Gets go to the node their wire feeds. */
  viaProblems: <T>(
    problems: ReadonlyMap<string, ReadonlyArray<T>>
  ) => ReadonlyMap<string, ReadonlyArray<T>>;
  /**
   * Graph-only edits are written as code: Gets wired by them stay nodes,
   * not wires from their SET. The entries once the code is parsed, or now
   * when the code stays the same (`wrote` false).
   */
  keepWired: (overlay: GraphOverlay, wrote: boolean) => Positions;
  /**
   * Floating nodes were written as code (their ids → the written nodes'):
   * the inputs `keepWired` noted follow them.
   */
  placedNodes: (ids: Readonly<Record<string, string>>) => void;
  /** Notes an op that wires a SET's output somewhere (before it runs). */
  beforeOp: (op: GraphOp, doc: GraphDocument | null) => void;
  /** The op wasn't written: forgets what `beforeOp` noted. */
  cancelOp: () => void;
  /** The `~via|` entries of the Gets that op made (after the re-parse). */
  afterParse: (
    previous: GraphDocument | undefined,
    next: GraphDocument,
    change?: TextChange
  ) => Positions;
}

/** The pin an op takes its value from, if it wires one somewhere. */
function sourceOf(op: GraphOp): PinRef | undefined {
  switch (op.type) {
    case 'connect': {
      return op.from;
    }

    case 'useValue':
    case 'callWith': {
      return op.pin;
    }

    // Wires moved onto an output: it feeds them now.
    case 'moveWires': {
      return op.to;
    }

    default: {
      return undefined;
    }
  }
}

/**
 * `~via|` entries for Gets that were drawn as wires from their SET before
 * an edit and would be Get nodes after it (no longer right after it).
 */
function stillDrawn(
  next: GraphDocument,
  before: ReadonlySet<string>,
  rename: ReadonlyMap<string, string>,
  layout: Positions
): Positions {
  const ids = new Set([...before].map((id) => rename.get(id) ?? id));
  const adjacent = adjacentVias(next, layout);
  const patch: Positions = {};
  for (const fn of next.functions) {
    for (const node of fn.nodes) {
      if (ids.has(node.id) && !adjacent.has(node.id) && viaSetter(fn, node)) {
        patch[viaKey(node.id)] = { x: 0, y: 0 };
      }
    }
  }

  return patch;
}

/**
 * `~via|` entries keeping the Gets that feed these inputs as nodes where
 * the graph would draw them as wires from their SET.
 */
function keptGets(
  next: GraphDocument,
  inputs: ReadonlyArray<WiredGet>,
  rename: ReadonlyMap<string, string>,
  layout: () => Positions
): Positions {
  if (inputs.length === 0) {
    return {};
  }

  const adjacent = adjacentVias(next, layout());
  const patch: Positions = {};
  for (const { input, at, from } of inputs) {
    // The code copied the value wired in (a Get, `item.quantity`): the copy
    // is drawn as the node it was wired from (one node, two wires).
    const joined = joinedCopy(next, { host: from, input }, rename);
    if (Object.keys(joined).length > 0) {
      Object.assign(patch, joined);
      continue;
    }

    const node = rename.get(input.node) ?? input.node;
    const source = next.functions
      .flatMap((f) => f.edges)
      .find((e) => e.to.node === node && e.to.pin === input.pin)?.from.node;
    if (source && adjacent.has(source)) {
      patch[nodeKey(source)] = { x: 0, y: 0 };
      // Where the Get was dropped (its read had no place of its own).
      if (at) {
        patch[source] = at;
      }
    }
  }

  return patch;
}

/**
 * A Get or pure node of graph-only edits wired into an input, and where
 * it was.
 */
interface WiredGet {
  input: PinRef;
  at: Point | undefined;
  from: string;
}

/**
 * The join of the copy of a pure node (or Get) the code got when it was
 * wired or used somewhere: the node now wired into `input`, or else a new
 * node (not in `known`) computing the same expression as its host.
 */
function joinedCopy(
  next: GraphDocument,
  copied: { host: string; input?: PinRef; known?: ReadonlySet<string> },
  rename: ReadonlyMap<string, string>
): Positions {
  const host = rename.get(copied.host) ?? copied.host;
  const input = copied.input
    ? {
        node: rename.get(copied.input.node) ?? copied.input.node,
        pin: copied.input.pin,
      }
    : undefined;
  for (const fn of next.functions) {
    const copy = input
      ? fn.edges.find((e) => e.to.node === input.node && e.to.pin === input.pin)
          ?.from.node
      : fn.nodes.find(
          (n) =>
            n.id !== host &&
            !copied.known?.has(n.id) &&
            pureSignature(fn, n.id) === pureSignature(fn, host)
        )?.id;
    const signature = copy ? pureSignature(fn, copy) : undefined;
    if (
      copy &&
      copy !== host &&
      signature !== undefined &&
      signature === pureSignature(fn, host)
    ) {
      return { [joinKey(copy, host)]: { x: 0, y: 0 } };
    }
  }

  return {};
}

/** The nodes of `previous`, by their ids after an edit. */
function knownAfter(
  previous: GraphDocument,
  rename: ReadonlyMap<string, string>
): Set<string> {
  return new Set(
    previous.functions.flatMap((f) =>
      f.nodes.map((n) => rename.get(n.id) ?? n.id)
    )
  );
}

/** The Gets of a variable. */
function readsOf(doc: GraphDocument, variable: string): Set<string> {
  return new Set(
    doc.functions
      .flatMap((f) => f.nodes)
      .filter((n) => n.kind === 'getVar' && n.title === variable)
      .map((n) => n.id)
  );
}

/**
 * UE wires a SET's output straight into inputs. The code reads the
 * variable there (a Get node); a Get made by wiring from a SET is
 * remembered in the layout and drawn as that wire (`foldVias` in core).
 */
export function useViaWires(deps: {
  shownDoc: ComputedRef<GraphDocument | null>;
  /** The graph of the code alone (no graph-only edits). */
  parsedDoc: Readonly<ShallowRef<GraphDocument | null>>;
  pinned: ShallowRef<Positions>;
  /**
   * The generated layout of a graph (no saved positions): reads it wraps
   * to a new row are drawn as one Get, not as wires back from their SET.
   */
  autoLayout: (doc: GraphDocument) => Positions;
}): ViaWires {
  const shownLayout = computed(() => {
    const shown = deps.shownDoc.value;
    return shown ? deps.autoLayout(shown) : {};
  });
  const canvasDoc = computed(() => {
    const shown = deps.shownDoc.value;
    return shown
      ? foldVias(
          shown,
          viaGets(deps.pinned.value),
          viaJoins(deps.pinned.value),
          shownLayout.value
        )
      : null;
  });

  /**
   * Wired from a SET or a Get: the variable, the Gets it had before, and
   * the Get wired from (the new read is drawn from it, like UE's node).
   */
  let pending: { variable: string; before: Set<string>; host?: string } | null =
    null;

  function throughVias(op: GraphOp): GraphOp {
    const drawn = canvasDoc.value;
    const shown = deps.shownDoc.value;
    if (!drawn || !shown) {
      return op;
    }

    const joins = pureJoins(shown, drawn);
    const result = viaOp(op, drawn, joins);
    // An edit of a joined pure node is written at its copies too.
    return result === op ? fanOut(op, joins) : result;
  }

  function viaOp(
    op: GraphOp,
    drawn: GraphDocument,
    joins: ReadonlyArray<PureJoin>
  ): GraphOp {
    const shown = deps.shownDoc.value;

    const vias = drawn.functions
      .flatMap((f) => f.edges)
      .filter((e) => e.via !== undefined);
    const from = (pin: PinRef): string[] => [
      ...new Set(
        vias
          .filter((e) => e.from.node === pin.node && e.from.pin === pin.pin)
          .map((e) => e.via ?? '')
      ),
    ];
    if (op.type === 'disconnect') {
      // A wire drawn in place of a Get: breaking it removes that read.
      const into = vias.find(
        (e) => e.to.node === op.pin.node && e.to.pin === op.pin.pin
      );
      if (into?.via) {
        // A joined pure copy goes with its wire, without leaving its
        // inputs behind as statements.
        return isPureCopy(shown, into.via)
          ? { ...op, drop: true }
          : { type: 'deleteNodes', nodeIds: [into.via] };
      }

      const gets = from(op.pin).filter((id) => !isPureCopy(shown, id));
      const own = drawn.functions
        .flatMap((f) => f.edges)
        .some(
          (e) =>
            !e.via && e.from.node === op.pin.node && e.from.pin === op.pin.pin
        );
      // Breaking a joined node's wires takes its copies along.
      const copies: GraphOp[] = vias
        .filter(
          (e) =>
            e.from.node === op.pin.node &&
            e.from.pin === op.pin.pin &&
            e.via !== undefined &&
            isPureCopy(shown, e.via)
        )
        .map((e) => ({ type: 'disconnect', pin: e.to, drop: true }));
      // Breaking the SET's wires removes the reads of the variable.
      // The pin's own wires, if it has any besides the joined ones.
      const rest: GraphOp | undefined =
        gets.length > 0 && !own
          ? { type: 'deleteNodes', nodeIds: gets }
          : own || copies.length === 0
            ? op
            : undefined;
      return copies.length > 0
        ? { type: 'all', ops: [...(rest ? [rest] : []), ...copies] }
        : (rest ?? op);
    }

    // Wired over a wire drawn in place of a Get: that read goes (it was
    // a wire, not a node to keep).
    if (op.type === 'connect') {
      const into = vias.find(
        (e) => e.to.node === op.to.node && e.to.pin === op.to.pin
      );
      return into ? { ...op, drop: true } : op;
    }

    // A deleted Get takes the reads joined into it along (its wires), a
    // joined pure node its copies with their parts.
    if (op.type === 'deleteNodes') {
      const joined = withCopyParts(
        joins,
        vias
          .filter((e) => e.via && op.nodeIds.includes(e.from.node))
          .map((e) => e.via ?? '')
      );
      return joined.length > 0
        ? { ...op, nodeIds: [...new Set([...op.nodeIds, ...joined])] }
        : op;
    }

    if (op.type === 'moveWires') {
      const host = drawn.functions
        .flatMap((f) => f.nodes)
        .find((n) => n.id === op.from.node);
      const [get, ...rest] = from(op.from);
      return get && rest.length === 0 && host?.kind !== 'getVar'
        ? { ...op, from: { node: get, pin: 'value' } }
        : op;
    }

    return op;
  }

  function viaProblems<T>(
    problems: ReadonlyMap<string, ReadonlyArray<T>>
  ): ReadonlyMap<string, ReadonlyArray<T>> {
    const drawn = canvasDoc.value;
    const edges = drawn
      ? drawn.functions.flatMap((f) => f.edges).filter((e) => e.via)
      : [];
    if (edges.length === 0) {
      return problems;
    }

    const shown = deps.shownDoc.value;
    const joins = drawn && shown ? pureJoins(shown, drawn) : [];
    const result = new Map(problems);
    for (const edge of edges) {
      // A joined copy: also the problems of its parts.
      const hidden = edge.via ? withCopyParts(joins, [edge.via]) : [];
      const own = hidden.flatMap((id) => problems.get(id) ?? []);
      if (own.length > 0) {
        result.set(edge.to.node, [...(result.get(edge.to.node) ?? []), ...own]);
      }
    }

    return result;
  }

  /**
   * Gets drawn as wires from their SET before an edit (right after it):
   * they stay wires afterwards, like UE's wires don't change when the
   * graph around them does.
   */
  let drawnBefore: Set<string> | null = null;
  /**
   * Reads sharing one Get before an edit (wrapped to a new row): they
   * keep it while their nodes stay where they are drawn.
   */
  let wrappedBefore: Map<string, string> | null = null;
  /** Inputs a Get was wired into by graph-only edits just written. */
  let wiredInputs: WiredGet[] = [];
  /**
   * Wired from a pure node (not a Get): the code copies its expression
   * into the input; the copy is drawn as that node (a join, like UE).
   */
  let wiredCopy: { host: string; input?: PinRef } | null = null;

  function keepWired(overlay: GraphOverlay, wrote: boolean): Positions {
    const shown = deps.shownDoc.value;
    const inputs = overlay.edits.flatMap((e) =>
      e.type === 'addEdge' &&
      e.kind === 'data' &&
      shown &&
      findNode(shown, e.from.node)?.purity === 'pure'
        ? [
            {
              input: e.to,
              at: deps.pinned.value[e.from.node],
              from: e.from.node,
            },
          ]
        : []
    );
    const parsed = deps.parsedDoc.value;
    if (wrote || !parsed) {
      wiredInputs = inputs;
      // Written as code: the graph stays drawn as it is (like an op).
      noteDrawn(wrote ? deps.shownDoc.value : null);
      return {};
    }

    return keptGets(parsed, inputs, new Map(), () => deps.autoLayout(parsed));
  }

  function placedNodes(ids: Readonly<Record<string, string>>): void {
    wiredInputs = wiredInputs.map((w) => ({
      ...w,
      input: { ...w.input, node: ids[w.input.node] ?? w.input.node },
    }));
  }

  /** What the graph draws before an edit, kept by `afterParse`. */
  function noteDrawn(doc: GraphDocument | null): void {
    const layout = doc
      ? doc === deps.shownDoc.value
        ? shownLayout.value
        : deps.autoLayout(doc)
      : {};
    drawnBefore = doc ? adjacentVias(doc, layout) : null;
    // What the user wired or kept wins over the shared Get (`foldVias`).
    const remembered = viaGets(deps.pinned.value);
    const joins = viaJoins(deps.pinned.value);
    wrappedBefore = doc
      ? new Map(
          [...wrappedVias(doc, layout)].filter(
            ([id]) => !remembered.has(id) && !joins.has(id)
          )
        )
      : null;
  }

  function beforeOp(op: GraphOp, doc: GraphDocument | null): void {
    pending = null;
    const wiredFrom =
      doc && op.type === 'connect' ? findNode(doc, op.from.node) : undefined;
    // Used in a new expression: the code copies a pure value or Get.
    const usedFrom =
      doc && (op.type === 'useValue' || op.type === 'callWith')
        ? findNode(doc, op.pin.node)
        : undefined;
    wiredCopy =
      op.type === 'connect' &&
      wiredFrom?.purity === 'pure' &&
      wiredFrom.kind !== 'getVar'
        ? { host: wiredFrom.id, input: op.to }
        : usedFrom?.purity === 'pure'
          ? { host: usedFrom.id }
          : null;
    noteDrawn(doc);
    const source = sourceOf(op);
    const setter = source && doc ? findNode(doc, source.node) : undefined;
    // Wired from a Get: the new read joins it (UE uses the same node).
    if (doc && op.type === 'connect' && setter?.kind === 'getVar') {
      pending = {
        variable: setter.title,
        before: readsOf(doc, setter.title),
        host: setter.id,
      };
      return;
    }

    // The wires of a Get moved to another Get of the variable: the reads
    // join that one; the Get they left stays, alone.
    const target =
      doc && op.type === 'moveWires' ? findNode(doc, op.to.node) : undefined;
    const moved =
      doc && op.type === 'moveWires' ? findNode(doc, op.from.node) : undefined;
    if (
      doc &&
      target?.kind === 'getVar' &&
      moved?.kind === 'getVar' &&
      target.title === moved.title
    ) {
      pending = {
        variable: target.title,
        before: readsOf(doc, target.title),
        host: target.id,
      };
      return;
    }

    if (
      !doc ||
      setter?.kind !== 'setVar' ||
      source?.pin !== 'out' ||
      !setter.title.startsWith('Set ')
    ) {
      return;
    }

    const variable = setter.title.slice('Set '.length);
    pending = { variable, before: readsOf(doc, variable) };
  }

  /** The edit wasn't written: what `beforeOp` noted is dropped. */
  function cancelOp(): void {
    pending = null;
    drawnBefore = null;
    wrappedBefore = null;
    wiredInputs = [];
    wiredCopy = null;
  }

  function afterParse(
    previous: GraphDocument | undefined,
    next: GraphDocument,
    change?: TextChange
  ): Positions {
    const wired = pending;
    const drawn = drawnBefore;
    const wrapped = wrappedBefore;
    const inputs = wiredInputs;
    const copied = wiredCopy;
    pending = null;
    drawnBefore = null;
    wrappedBefore = null;
    wiredInputs = [];
    wiredCopy = null;
    if (
      !previous ||
      (!wired && !drawn && !wrapped?.size && inputs.length === 0 && !copied)
    ) {
      return {};
    }

    const rename = renamedNodes(previous, next, change);
    let layout: Positions | undefined;
    const nextLayout = (): Positions => (layout ??= deps.autoLayout(next));
    const patch: Positions = {
      ...keptGets(next, inputs, rename, nextLayout),
      ...(drawn ? stillDrawn(next, drawn, rename, nextLayout()) : {}),
      ...(wrapped?.size
        ? keptWrapped(wrapped, next, rename, nextLayout())
        : {}),
      ...(copied
        ? joinedCopy(
            next,
            { ...copied, known: knownAfter(previous, rename) },
            rename
          )
        : {}),
    };
    if (!wired) {
      return patch;
    }

    const before = new Set([...wired.before].map((id) => rename.get(id) ?? id));
    const host = wired.host
      ? (rename.get(wired.host) ?? wired.host)
      : undefined;
    // The Get wired from stays the node it is (not a wire from its SET).
    const keep =
      host !== undefined && adjacentVias(next, nextLayout()).has(host);
    for (const fn of next.functions) {
      for (const node of fn.nodes) {
        if (
          node.kind !== 'getVar' ||
          node.title !== wired.variable ||
          before.has(node.id) ||
          node.id === host
        ) {
          continue;
        }

        if (host && fn.nodes.some((n) => n.id === host)) {
          patch[joinKey(node.id, host)] = { x: 0, y: 0 };
        } else if (!host && viaSetter(fn, node)) {
          patch[viaKey(node.id)] = { x: 0, y: 0 };
        }
      }
    }

    if (host && keep) {
      patch[nodeKey(host)] = { x: 0, y: 0 };
    }

    return patch;
  }

  return {
    canvasDoc,
    throughVias,
    viaProblems,
    keepWired,
    placedNodes,
    beforeOp,
    cancelOp,
    afterParse,
  };
}
