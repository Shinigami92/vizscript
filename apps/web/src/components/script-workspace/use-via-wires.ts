import type {
  GraphDocument,
  GraphOp,
  PinRef,
  Positions,
  TextChange,
} from '@vizscript/core';
import {
  findNode,
  foldVias,
  renamedNodes,
  viaGets,
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
    return shown ? foldVias(shown, viaGets(deps.pinned.value)) : null;
  });

  /** Wired from a SET: the variable and the Gets it had before. */
  let pending: { variable: string; before: Set<string> } | null = null;

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
      const gets = from(op.pin);
      // Breaking the SET's wires removes the reads of the variable.
      return gets.length > 0 ? { type: 'deleteNodes', nodeIds: gets } : op;
    }

    if (op.type === 'moveWires') {
      const [get, ...rest] = from(op.from);
      return get && rest.length === 0
        ? { ...op, from: { node: get, pin: 'value' } }
        : op;
    }

    return op;
  }

  function beforeOp(op: GraphOp, doc: GraphDocument | null): void {
    pending = null;
    const source = sourceOf(op);
    const setter = source && doc ? findNode(doc, source.node) : undefined;
    if (
      !doc ||
      setter?.kind !== 'setVar' ||
      source?.pin !== 'out' ||
      !setter.title.startsWith('Set ')
    ) {
      return;
    }

    const variable = setter.title.slice('Set '.length);
    pending = {
      variable,
      before: new Set(
        doc.functions
          .flatMap((f) => f.nodes)
          .filter((n) => n.kind === 'getVar' && n.title === variable)
          .map((n) => n.id)
      ),
    };
  }

  function afterParse(
    previous: GraphDocument | undefined,
    next: GraphDocument,
    change?: TextChange
  ): Positions {
    const wired = pending;
    pending = null;
    if (!wired || !previous) {
      return {};
    }

    const rename = renamedNodes(previous, next, change);
    const before = new Set([...wired.before].map((id) => rename.get(id) ?? id));
    const patch: Positions = {};
    for (const fn of next.functions) {
      for (const node of fn.nodes) {
        if (
          node.kind === 'getVar' &&
          node.title === wired.variable &&
          !before.has(node.id) &&
          viaSetter(fn, node)
        ) {
          patch[viaKey(node.id)] = { x: 0, y: 0 };
        }
      }
    }

    return patch;
  }

  return { canvasDoc, throughVias, beforeOp, afterParse };
}
