import type {
  FloatingNodes,
  GraphDocument,
  GraphEdit,
  GraphNode,
  GraphOp,
  GraphOverlay,
  ImportedDeclaration,
  LayoutPatch,
  Point,
  TextChange,
} from '@vizscript/core';
import type { LooseCode } from '@vizscript/core';
import {
  floatingGroup,
  floatingPrefix,
  looseCode,
  renamedNodes,
} from '@vizscript/core';
import type { Ref } from 'vue';
import type { GraphClient } from '../../graph/graph-client';

/** Ops after which nodes the user didn't delete may leave the code. */
const KEEPING = new Set<GraphOp['type']>([
  'deleteNodes',
  'disconnect',
  'disconnectNode',
  'connect',
  'moveWires',
  'clearArguments',
  'setInput',
]);

interface Noted {
  previous: GraphDocument;
  text: string;
  deleted: Set<string>;
  /** Nodes not drawn (Gets shown as wires, joined copies). */
  hidden: Set<string>;
  places: Record<string, Point>;
}

export interface KeptNodes {
  /** Notes the graph before an op that may leave nodes behind. */
  beforeOp: (op: GraphOp) => void;
  /** The op wasn't written: forgets what `beforeOp` noted. */
  cancelOp: () => void;
  /**
   * After the op's code is parsed: the nodes it took out of the code that
   * the user didn't delete stay as loose graph-only nodes (UE keeps them,
   * unconnected), in one undo step with the op.
   */
  afterParse: (next: GraphDocument, change: TextChange | undefined) => void;
  /**
   * Deletes nodes of loose groups, keeping the rest of each group; `false`
   * when a node isn't loose.
   */
  deleteLoose: (nodeIds: ReadonlyArray<string>) => Promise<boolean>;
}

/** Pairs nodes made again from code with the nodes they stand for. */
function pairNodes(
  previous: ReadonlyArray<GraphNode>,
  made: ReadonlyArray<GraphNode>
): Map<string, string> {
  const result = new Map<string, string>();
  const taken = new Set<string>();
  const ordered = made.toSorted((a, b) => a.range.start - b.range.start);
  for (const node of previous) {
    const match = ordered.find(
      (n) => !taken.has(n.id) && n.kind === node.kind && n.title === node.title
    );
    if (match) {
      taken.add(match.id);
      result.set(node.id, match.id);
    }
  }

  return result;
}

export function useKeptNodes(deps: {
  parsedDoc: () => GraphDocument | null;
  drawnDoc: () => GraphDocument | null;
  text: Ref<string>;
  path: () => string;
  client: GraphClient;
  imports: () => ImportedDeclaration[];
  placeholder: () => string;
  positionOf: (id: string) => Point | undefined;
  typeFloating: (edit: FloatingNodes, text: string) => Promise<FloatingNodes>;
  overlay: () => GraphOverlay;
  /** Shows them, recorded as one undo step with the op's code. */
  keep: (
    before: GraphOverlay,
    after: GraphOverlay,
    layout: LayoutPatch
  ) => void;
  /** Replaces loose groups (one undo step of the graph). */
  replace: (
    before: GraphOverlay,
    after: GraphOverlay,
    layout: LayoutPatch
  ) => void;
}): KeptNodes {
  let noted: Noted | null = null;
  let groups = 0;

  function beforeOp(op: GraphOp): void {
    const previous = deps.parsedDoc();
    noted = null;
    if (!previous || !KEEPING.has(op.type)) {
      return;
    }

    const drawn = new Set(
      deps.drawnDoc()?.functions.flatMap((f) => f.nodes.map((n) => n.id)) ?? []
    );
    const all = previous.functions.flatMap((f) => f.nodes);
    const places: Record<string, Point> = {};
    for (const node of all) {
      const at = deps.positionOf(node.id);
      if (at) {
        places[node.id] = at;
      }
    }

    noted = {
      previous,
      text: deps.text.value,
      deleted: new Set(op.type === 'deleteNodes' ? op.nodeIds : []),
      hidden: new Set(all.filter((n) => !drawn.has(n.id)).map((n) => n.id)),
      places,
    };
  }

  async function keep(
    from: Noted,
    next: GraphDocument,
    change: TextChange | undefined
  ): Promise<void> {
    const rename = renamedNodes(from.previous, next, change);
    const ids = new Set(
      next.functions.flatMap((f) => f.nodes.map((n) => n.id))
    );
    const lost = new Set(
      from.previous.functions
        .flatMap((f) => f.nodes)
        .filter(
          (n) =>
            n.kind !== 'entry' &&
            !from.deleted.has(n.id) &&
            !from.hidden.has(n.id) &&
            !ids.has(rename.get(n.id) ?? n.id)
        )
        .map((n) => n.id)
    );
    if (lost.size === 0) {
      return;
    }

    const parts = looseCode(
      from.text,
      from.previous,
      lost,
      from.deleted,
      deps.placeholder()
    );
    const source = deps.text.value;
    const nodes = new Map(
      from.previous.functions.flatMap((f) => f.nodes.map((n) => [n.id, n]))
    );
    const made = await floatParts(
      parts,
      source,
      (id) => nodes.get(id),
      (id) => from.places[id],
      (id) => rename.get(id) ?? id
    );
    if (made.edits.length > 0 && deps.text.value === source) {
      const before = deps.overlay();
      deps.keep(
        before,
        { edits: [...before.edits, ...made.edits] },
        made.layout
      );
    }
  }

  /**
   * Loose groups made from parts of code (`looseCode`): each node keeps
   * the place of the node it stands for (`nodeOf`, `placeOf`), and inputs
   * the code fed stay wired (`codeNode`: the code node's id now).
   */
  async function floatParts(
    parts: ReadonlyArray<LooseCode>,
    source: string,
    nodeOf: (id: string) => GraphNode | undefined,
    placeOf: (id: string) => Point | undefined,
    codeNode: (id: string) => string,
    /** The function they are shown with (else the part's). */
    fnId?: string
  ): Promise<{
    edits: GraphEdit[];
    layout: LayoutPatch;
    pairs: Map<string, string>;
  }> {
    const placeholder = deps.placeholder();
    const edits: GraphEdit[] = [];
    const layout: LayoutPatch = {};
    const all = new Map<string, string>();
    for (const part of parts) {
      const id = `${Date.now().toString(36)}k${(groups++).toString(36)}`;
      const result = await deps.client.floatingNodes(
        source,
        deps.path(),
        part.statement
          ? { type: 'code', code: part.code }
          : { type: 'value', expression: part.code },
        part.fnId,
        id,
        deps.imports()
      );
      if (!result.ok || deps.text.value !== source) {
        continue;
      }

      if (fnId) {
        result.edit.fnId = fnId;
      }

      const edit = await deps.typeFloating(result.edit, result.text);
      edits.push(edit);
      // Each node keeps its place.
      const pairs = pairNodes(
        part.nodes.flatMap((n) => nodeOf(n) ?? []),
        edit.nodes
      );
      for (const [old, made] of pairs) {
        all.set(old, made);
        const at = placeOf(old);
        if (at) {
          layout[made] = at;
        }
      }

      // The values of the code it read stay wired (graph-only).
      const holes = edit.nodes
        .flatMap((n) =>
          n.pins
            .filter(
              (p) => p.direction === 'in' && p.literal?.raw === placeholder
            )
            .map((p) => ({ node: n.id, pin: p.id, at: p.range?.start ?? 0 }))
        )
        .toSorted((a, b) => a.at - b.at);
      for (const [i, feed] of part.feeds.entries()) {
        const hole = holes[i];
        if (feed && hole) {
          edits.push({
            type: 'addEdge',
            kind: 'data',
            from: { node: codeNode(feed.node), pin: feed.pin },
            to: { node: hole.node, pin: hole.pin },
          });
        }
      }
    }

    return { edits, layout, pairs: all };
  }

  /**
   * Deleting nodes of loose groups deletes just them: the rest of each
   * group stays, as groups made again without them (in a copy of the code
   * with the group written in, like the code's own nodes).
   */
  async function deleteLoose(nodeIds: ReadonlyArray<string>): Promise<boolean> {
    const overlay = deps.overlay();
    const touched = new Map<string, FloatingNodes>();
    for (const id of nodeIds) {
      const group = overlay.edits.find(
        (e): e is FloatingNodes =>
          e.type === 'addNodes' && e.id === floatingGroup(id)
      );
      if (!group) {
        return false;
      }

      touched.set(group.id, group);
    }

    const source = deps.text.value;
    const placeholder = deps.placeholder();
    const gone = new Set(nodeIds);
    const edits: GraphEdit[] = [];
    const layout: LayoutPatch = {};
    const moved = new Map<string, string>();
    for (const group of touched.values()) {
      if (group.nodes.every((n) => gone.has(n.id))) {
        continue;
      }

      const scratch = await deps.client.floatingNodes(
        source,
        deps.path(),
        group.nodes.some((n) => n.pins.some((p) => p.kind === 'exec'))
          ? { type: 'code', code: group.code }
          : { type: 'value', expression: group.code },
        group.fnId,
        'scratch',
        deps.imports()
      );
      if (!scratch.ok) {
        return false;
      }
      const copy = await deps.client.parse(
        scratch.text,
        deps.path(),
        deps.imports()
      );
      const prefix = floatingPrefix('scratch');
      const toCopy = new Map(
        [...pairNodes(group.nodes, scratch.edit.nodes)].map(([old, made]) => [
          old,
          made.slice(prefix.length),
        ])
      );
      const fromCopy = new Map([...toCopy].map(([old, c]) => [c, old]));
      const ids = (staying: boolean): Set<string> =>
        new Set(
          group.nodes
            .filter((n) => gone.has(n.id) !== staying)
            .flatMap((n) => toCopy.get(n.id) ?? [])
        );
      const parts = looseCode(
        scratch.text,
        copy,
        ids(true),
        ids(false),
        placeholder
      );
      const groupNodes = new Map(group.nodes.map((n) => [n.id, n]));
      const made = await floatParts(
        parts,
        source,
        (id) => {
          const old = fromCopy.get(id);
          const node = old ? groupNodes.get(old) : undefined;
          return node ? { ...node, id } : undefined;
        },
        (id) => {
          const old = fromCopy.get(id);
          return old ? deps.positionOf(old) : undefined;
        },
        (id) => id,
        group.fnId
      );
      edits.push(...made.edits);
      Object.assign(layout, made.layout);
      for (const [c, m] of made.pairs) {
        const old = fromCopy.get(c);
        if (old) {
          moved.set(old, m);
        }
      }
    }

    // Wires from the code into the groups follow their nodes.
    const removed = new Set(touched.keys());
    const kept = overlay.edits.flatMap((e): GraphEdit[] => {
      if (e.type === 'addNodes') {
        return removed.has(e.id) ? [] : [e];
      }

      if (e.type !== 'addEdge') {
        return [e];
      }

      const from = moved.get(e.from.node) ?? e.from.node;
      const to = moved.get(e.to.node) ?? e.to.node;
      const stale = [from, to].some(
        (n) => gone.has(n) || removed.has(floatingGroup(n) ?? '')
      );
      return stale
        ? []
        : [
            {
              ...e,
              from: { ...e.from, node: from },
              to: { ...e.to, node: to },
            },
          ];
    });
    deps.replace(overlay, { edits: [...kept, ...edits] }, layout);
    return true;
  }

  function afterParse(
    next: GraphDocument,
    change: TextChange | undefined
  ): void {
    const from = noted;
    noted = null;
    if (from) {
      void keep(from, next, change);
    }
  }

  /** The edit wasn't written: what `beforeOp` noted is dropped. */
  function cancelOp(): void {
    noted = null;
  }

  return { beforeOp, cancelOp, afterParse, deleteLoose };
}
