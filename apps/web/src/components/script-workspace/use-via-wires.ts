import type {
  GraphDocument,
  GraphOp,
  PinRef,
  Positions,
  TextChange,
} from '@vizscript/core';
import {
  adjacentVias,
  findNode,
  foldVias,
  joinKey,
  renamedNodes,
  viaGets,
  viaJoins,
  viaKey,
  viaSetter,
} from '@vizscript/core';
import type { ComputedRef, ShallowRef } from 'vue';
import { computed } from 'vue';

export interface ViaWires {
  /** The graph as drawn: remembered Gets as wires from their SET. */
  canvasDoc: ComputedRef<GraphDocument | null>;
  /** An op on a wire drawn from a SET acts on the Get it stands for. */
  throughVias: (op: GraphOp) => GraphOp;
  /** Problems of hidden Gets go to the node their wire feeds. */
  viaProblems: <T>(
    problems: ReadonlyMap<string, ReadonlyArray<T>>
  ) => ReadonlyMap<string, ReadonlyArray<T>>;
  /** Notes an op that wires a SET's output somewhere (before it runs). */
  beforeOp: (op: GraphOp, doc: GraphDocument | null) => void;
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
  rename: ReadonlyMap<string, string>
): Positions {
  const ids = new Set([...before].map((id) => rename.get(id) ?? id));
  const adjacent = adjacentVias(next);
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
  pinned: ShallowRef<Positions>;
}): ViaWires {
  const canvasDoc = computed(() => {
    const shown = deps.shownDoc.value;
    return shown
      ? foldVias(shown, viaGets(deps.pinned.value), viaJoins(deps.pinned.value))
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
    if (!drawn) {
      return op;
    }

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
        return { type: 'deleteNodes', nodeIds: [into.via] };
      }

      const gets = from(op.pin);
      const own = drawn.functions
        .flatMap((f) => f.edges)
        .some(
          (e) =>
            !e.via && e.from.node === op.pin.node && e.from.pin === op.pin.pin
        );
      // Breaking the SET's wires removes the reads of the variable.
      return gets.length > 0 && !own
        ? { type: 'deleteNodes', nodeIds: gets }
        : op;
    }

    // A deleted Get takes the reads joined into it along (its wires).
    if (op.type === 'deleteNodes') {
      const joined = vias
        .filter((e) => e.via && op.nodeIds.includes(e.from.node))
        .map((e) => e.via ?? '');
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

    const result = new Map(problems);
    for (const edge of edges) {
      const own = edge.via ? problems.get(edge.via) : undefined;
      if (own) {
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

  function beforeOp(op: GraphOp, doc: GraphDocument | null): void {
    pending = null;
    drawnBefore = doc ? adjacentVias(doc) : null;
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

  function afterParse(
    previous: GraphDocument | undefined,
    next: GraphDocument,
    change?: TextChange
  ): Positions {
    const wired = pending;
    const drawn = drawnBefore;
    pending = null;
    drawnBefore = null;
    if (!previous || (!wired && !drawn)) {
      return {};
    }

    const rename = renamedNodes(previous, next, change);
    const patch: Positions = drawn ? stillDrawn(next, drawn, rename) : {};
    if (!wired) {
      return patch;
    }

    const before = new Set([...wired.before].map((id) => rename.get(id) ?? id));
    const host = wired.host
      ? (rename.get(wired.host) ?? wired.host)
      : undefined;
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

    return patch;
  }

  return { canvasDoc, throughVias, viaProblems, beforeOp, afterParse };
}
