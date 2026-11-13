import { edgeId } from './ids';
import type {
  EdgeKind,
  FunctionGraph,
  GraphDocument,
  GraphEdge,
  GraphNode,
  PinRef,
} from './ir';
import type { GraphOp } from './ops';
import type { TextChange } from './reconcile';
import { renamedNodes } from './reconcile';

/**
 * A change that exists only in the graph (UE lets a graph be in states that
 * don't compile yet; vizscript's code can't hold them): wires the code
 * can't follow yet, nodes it can't delete. Keyed by node and pin ids, like
 * layout entries, and written as code by `resolveOverlay` once the whole
 * graph is valid again.
 */
export type GraphEdit =
  | { type: 'removeEdge'; from: PinRef; to: PinRef }
  /** An exec-out or data-in that has a wire already loses it. */
  | { type: 'addEdge'; kind: EdgeKind; from: PinRef; to: PinRef }
  | { type: 'removeNode'; node: string }
  /**
   * Nodes with no place in the code yet (added where no code can go, like
   * GDScript's class body): they float until they are wired in, then
   * `code` is written there. Their ids start with `overlay:<id>/`.
   */
  | {
      type: 'addNodes';
      id: string;
      /** Function they belong to; wiring them into another moves them. */
      fnId: string;
      /** The code the nodes stand for (a statement, or a value). */
      code: string;
      nodes: GraphNode[];
      /** Wires between the nodes. */
      edges: GraphEdge[];
    };

/** An `addNodes` edit. */
export type FloatingNodes = Extract<GraphEdit, { type: 'addNodes' }>;

/** The id prefix of floating nodes (`overlay:<id>/`). */
export function floatingPrefix(id: string): string {
  return `overlay:${id}/`;
}

/** The `addNodes` id of a floating node's id. */
export function floatingGroup(nodeId: string): string | undefined {
  const match = /^overlay:([^/]+)\//.exec(nodeId);
  return match?.[1];
}

/** Graph-only edits of one file, in the order they were made. */
export interface GraphOverlay {
  edits: GraphEdit[];
}

export const EMPTY_OVERLAY: GraphOverlay = { edits: [] };

/** Why the graph can't be written as code yet. */
export interface OverlayIssue {
  node: string;
  message: string;
}

function functionOfNode(
  doc: GraphDocument,
  id: string
): FunctionGraph | undefined {
  return doc.functions.find((f) => f.nodes.some((n) => n.id === id));
}

function sameRef(a: PinRef, b: PinRef): boolean {
  return a.node === b.node && a.pin === b.pin;
}

function edgeKey(e: { from: PinRef; to: PinRef }): string {
  return edgeId(e.from, e.to);
}

/**
 * Drops floating nodes that were deleted again, with every edit of them:
 * they never reach the code.
 */
export function compactOverlay(overlay: GraphOverlay): GraphOverlay {
  const removed = new Set(
    overlay.edits.flatMap((e) =>
      e.type === 'removeNode' ? [floatingGroup(e.node)] : []
    )
  );
  removed.delete(undefined);
  if (removed.size === 0) {
    return overlay;
  }

  const gone = (id: string): boolean => removed.has(floatingGroup(id));
  return {
    edits: overlay.edits.filter((e) => {
      switch (e.type) {
        case 'addNodes': {
          return !removed.has(e.id);
        }

        case 'removeNode': {
          return !gone(e.node);
        }

        default: {
          return !gone(e.from.node) && !gone(e.to.node);
        }
      }
    }),
  };
}

/** Whether the overlay changes nothing. */
export function isEmptyOverlay(overlay: GraphOverlay | undefined): boolean {
  return !overlay || overlay.edits.length === 0;
}

/**
 * The graph as the user sees it: the parsed graph with the graph-only edits
 * applied. Wires that exist only here are marked `graphOnly`.
 */
export function applyOverlay(
  doc: GraphDocument,
  overlay: GraphOverlay | undefined
): GraphDocument {
  if (isEmptyOverlay(overlay) || !overlay) {
    return doc;
  }

  const functions = doc.functions.map((fn) => ({
    ...fn,
    nodes: [...fn.nodes],
    edges: [...fn.edges],
  }));
  const byNode = (id: string): FunctionGraph | undefined =>
    functions.find((f) => f.nodes.some((n) => n.id === id));

  for (const edit of overlay.edits) {
    switch (edit.type) {
      case 'addNodes': {
        const fn =
          functions.find((f) => f.id === edit.fnId) ?? functions.at(-1);
        fn?.nodes.push(...edit.nodes.map((n) => ({ ...n, graphOnly: true })));
        fn?.edges.push(...edit.edges.map((e) => ({ ...e, graphOnly: true })));
        break;
      }

      case 'removeEdge': {
        const fn = byNode(edit.from.node);
        if (fn) {
          fn.edges = fn.edges.filter(
            (e) => !(sameRef(e.from, edit.from) && sameRef(e.to, edit.to))
          );
        }

        break;
      }

      case 'addEdge': {
        const fn = joinFunctions(functions, edit.from.node, edit.to.node);
        if (!fn) {
          break;
        }

        // Like the canvas: an exec output and a data input take one wire,
        // and a statement follows one other (the code can't fork or join).
        fn.edges = fn.edges.filter(
          (e) =>
            !(edit.kind === 'exec' && sameRef(e.from, edit.from)) &&
            !sameRef(e.to, edit.to)
        );
        fn.edges.push({
          id: edgeId(edit.from, edit.to),
          kind: edit.kind,
          from: { ...edit.from },
          to: { ...edit.to },
          graphOnly: true,
        });
        break;
      }

      case 'removeNode': {
        const fn = byNode(edit.node);
        const node = fn?.nodes.find((n) => n.id === edit.node);
        const group = floatingGroup(edit.node);
        if (fn && group !== undefined) {
          // Floating nodes are one piece of code: they go together.
          const prefix = floatingPrefix(group);
          fn.nodes = fn.nodes.filter((n) => !n.id.startsWith(prefix));
          fn.edges = fn.edges.filter(
            (e) =>
              !e.from.node.startsWith(prefix) && !e.to.node.startsWith(prefix)
          );
        } else if (fn && node) {
          // Like deleting the statement: what is inside it goes too.
          const gone = new Set(
            fn.nodes
              .filter(
                (n) =>
                  n.id === node.id ||
                  (!node.graphOnly &&
                    !n.graphOnly &&
                    n.kind !== 'entry' &&
                    n.range.start >= node.range.start &&
                    n.range.end <= node.range.end)
              )
              .map((n) => n.id)
          );
          fn.nodes = fn.nodes.filter((n) => !gone.has(n.id));
          fn.edges = fn.edges.filter(
            (e) => !gone.has(e.from.node) && !gone.has(e.to.node)
          );
        }

        break;
      }
    }
  }

  return { ...doc, functions: functions.map(markFloating) };
}

/** Floating nodes of a group in a function, by group. */
function floatingGroups(fn: FunctionGraph): Map<string, GraphNode[]> {
  const groups = new Map<string, GraphNode[]>();
  for (const node of fn.nodes) {
    const group = floatingGroup(node.id);
    if (group !== undefined) {
      groups.set(group, [...(groups.get(group) ?? []), node]);
    }
  }

  return groups;
}

/** Whether a group of floating nodes is wired to anything else. */
function wiredIn(fn: FunctionGraph, group: string): boolean {
  const prefix = floatingPrefix(group);
  return fn.edges.some(
    (e) => e.from.node.startsWith(prefix) !== e.to.node.startsWith(prefix)
  );
}

/** The group of a floating node that may still move to another function. */
function movableGroup(fn: FunctionGraph, nodeId: string): string | undefined {
  const group = floatingGroup(nodeId);
  return group !== undefined && !wiredIn(fn, group) ? group : undefined;
}

/** Marks the floating nodes not wired to anything (drawn outside frames). */
function markFloating(fn: FunctionGraph): FunctionGraph {
  const loose = new Set(
    [...floatingGroups(fn).keys()].filter((g) => !wiredIn(fn, g))
  );
  if (loose.size === 0) {
    return fn;
  }

  return {
    ...fn,
    nodes: fn.nodes.map((n) => {
      const group = floatingGroup(n.id);
      return group !== undefined && loose.has(group)
        ? { ...n, floating: true }
        : n;
    }),
  };
}

/**
 * The function a wire between two nodes goes in: theirs, or, when one end
 * is a group of floating nodes not wired to anything yet, the other end's
 * (the group moves there).
 */
function joinFunctions(
  functions: FunctionGraph[],
  from: string,
  to: string
): FunctionGraph | undefined {
  const of = (id: string): FunctionGraph | undefined =>
    functions.find((f) => f.nodes.some((n) => n.id === id));
  const a = of(from);
  const b = of(to);
  if (!a || !b || a === b) {
    return a;
  }

  for (const [node, source, target] of [
    [from, a, b],
    [to, b, a],
  ] as const) {
    const group = movableGroup(source, node);
    if (group !== undefined) {
      const prefix = floatingPrefix(group);
      const moved = (id: string): boolean => id.startsWith(prefix);
      target.nodes.push(...source.nodes.filter((n) => moved(n.id)));
      target.edges.push(...source.edges.filter((e) => moved(e.from.node)));
      source.nodes = source.nodes.filter((n) => !moved(n.id));
      source.edges = source.edges.filter((e) => !moved(e.from.node));
      return target;
    }
  }

  return undefined;
}

function hasExecIn(node: GraphNode): boolean {
  return node.pins.some((p) => p.kind === 'exec' && p.direction === 'in');
}

/** Nodes reachable along exec wires from the function's entry nodes. */
function reachable(fn: FunctionGraph): Set<string> {
  const next = new Map<string, string[]>();
  for (const e of fn.edges) {
    if (e.kind === 'exec') {
      next.set(e.from.node, [...(next.get(e.from.node) ?? []), e.to.node]);
    }
  }

  const seen = new Set<string>();
  const stack = fn.nodes.filter((n) => n.kind === 'entry').map((n) => n.id);
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || seen.has(id)) {
      continue;
    }

    seen.add(id);
    stack.push(...(next.get(id) ?? []));
  }

  return seen;
}

/** Nodes on an exec cycle (code runs top to bottom; loops are nodes). */
function cycleNodes(fn: FunctionGraph): Set<string> {
  const next = new Map<string, string[]>();
  for (const e of fn.edges) {
    if (e.kind === 'exec') {
      next.set(e.from.node, [...(next.get(e.from.node) ?? []), e.to.node]);
    }
  }

  const state = new Map<string, 'open' | 'done'>();
  const cyclic = new Set<string>();
  const path: string[] = [];
  const visit = (id: string): void => {
    state.set(id, 'open');
    path.push(id);
    for (const to of next.get(id) ?? []) {
      const s = state.get(to);
      if (s === 'open') {
        for (const n of path.slice(path.indexOf(to))) {
          cyclic.add(n);
        }
      } else if (s === undefined) {
        visit(to);
      }
    }

    path.pop();
    state.set(id, 'done');
  };

  for (const node of fn.nodes) {
    if (!state.has(node.id)) {
      visit(node.id);
    }
  }

  return cyclic;
}

/**
 * What keeps the shown graph from being code: statements cut off from the
 * flow that the code still runs, statements entered from two places, exec
 * cycles. Statements already unreachable in the code (after a `return`)
 * are not issues.
 */
export function overlayIssues(
  parsed: GraphDocument,
  shown: GraphDocument
): OverlayIssue[] {
  const issues: OverlayIssue[] = [];
  for (const fn of shown.functions) {
    const before = parsed.functions.find((f) => f.id === fn.id);
    const wasReachable = before ? reachable(before) : new Set<string>();
    const isReachable = reachable(fn);
    const cyclic = cycleNodes(fn);
    const incoming = new Map<string, number>();
    for (const e of fn.edges) {
      if (e.kind === 'exec') {
        incoming.set(e.to.node, (incoming.get(e.to.node) ?? 0) + 1);
      }
    }

    for (const node of fn.nodes) {
      if (!hasExecIn(node) || node.kind === 'entry') {
        continue;
      }

      if (cyclic.has(node.id)) {
        issues.push({
          node: node.id,
          message: 'Execution runs in a circle; code runs top to bottom.',
        });
      } else if ((incoming.get(node.id) ?? 0) > 1) {
        issues.push({
          node: node.id,
          message: 'Execution enters this node from more than one place.',
        });
      } else if (
        floatingGroup(node.id) !== undefined &&
        !isReachable.has(node.id) &&
        !fn.edges.some(
          (e) =>
            e.kind === 'exec' &&
            e.to.node === node.id &&
            floatingGroup(e.from.node) === floatingGroup(node.id)
        )
      ) {
        issues.push({
          node: node.id,
          message: 'Not in the code yet: wire its exec input into the flow.',
        });
      } else if (
        !isReachable.has(node.id) &&
        wasReachable.has(node.id) &&
        !incoming.has(node.id)
      ) {
        // The head of a cut-off chain; the nodes after it follow it.
        issues.push({
          node: node.id,
          message:
            'Not connected to the flow: wire its exec input, or delete it.',
        });
      }
    }

    issues.push(...valueIssues(fn));
  }

  return issues;
}

/** Floating values (no exec pins) must be wired into an input. */
function valueIssues(fn: FunctionGraph): OverlayIssue[] {
  const issues: OverlayIssue[] = [];
  for (const [group, nodes] of floatingGroups(fn)) {
    if (nodes.some(hasExecIn)) {
      continue;
    }

    const prefix = floatingPrefix(group);
    const used = fn.edges.some(
      (e) =>
        e.kind === 'data' &&
        e.from.node.startsWith(prefix) &&
        !e.to.node.startsWith(prefix)
    );
    const root = nodes.find(
      (n) => !fn.edges.some((e) => e.from.node === n.id && e.to.node !== n.id)
    );
    if (!used && root) {
      issues.push({
        node: root.id,
        message: 'Not in the code yet: wire its output into an input.',
      });
    }
  }

  return issues;
}

/**
 * The graph-only edits for an op the code can't follow yet; `undefined`
 * for ops that aren't graph edits (commands and settings keep their error).
 */
export function graphEditsFor(
  doc: GraphDocument,
  op: GraphOp
): GraphEdit[] | undefined {
  switch (op.type) {
    case 'connect': {
      const fn = functionOfNode(doc, op.from.node);
      const from = fn?.nodes
        .find((n) => n.id === op.from.node)
        ?.pins.find((p) => p.id === op.from.pin);
      const target = functionOfNode(doc, op.to.node);
      const to = target?.nodes
        .find((n) => n.id === op.to.node)
        ?.pins.find((p) => p.id === op.to.pin);
      // Floating nodes not wired yet move to the function they are wired to.
      const joins =
        target === fn ||
        (fn !== undefined && movableGroup(fn, op.from.node) !== undefined) ||
        (target !== undefined &&
          movableGroup(target, op.to.node) !== undefined);
      if (
        !fn ||
        !from ||
        !to ||
        !joins ||
        from.kind !== to.kind ||
        from.direction !== 'out' ||
        to.direction !== 'in'
      ) {
        return undefined;
      }

      return [{ type: 'addEdge', kind: from.kind, from: op.from, to: op.to }];
    }

    case 'disconnect': {
      const fn = functionOfNode(doc, op.pin.node);
      const edges = (fn?.edges ?? []).filter(
        (e) => sameRef(e.from, op.pin) || sameRef(e.to, op.pin)
      );
      return edges.length > 0 ? edges.map(removeEdge) : undefined;
    }

    case 'disconnectNode': {
      const fn = functionOfNode(doc, op.node);
      const edges = (fn?.edges ?? []).filter(
        (e) => e.from.node === op.node || e.to.node === op.node
      );
      return edges.length > 0 ? edges.map(removeEdge) : undefined;
    }

    case 'moveWires': {
      const fn = functionOfNode(doc, op.from.node);
      if (!fn || functionOfNode(doc, op.to.node) !== fn) {
        return undefined;
      }

      const edges = fn.edges.filter(
        (e) =>
          e.kind === 'data' &&
          (sameRef(e.from, op.from) || sameRef(e.to, op.from))
      );
      if (edges.length === 0) {
        return undefined;
      }

      return edges.flatMap((e): GraphEdit[] => [
        removeEdge(e),
        sameRef(e.from, op.from)
          ? { type: 'addEdge', kind: 'data', from: op.to, to: e.to }
          : { type: 'addEdge', kind: 'data', from: e.from, to: op.to },
      ]);
    }

    case 'deleteNodes': {
      const nodes = op.nodeIds.filter((id) => {
        const node = functionOfNode(doc, id)?.nodes.find((n) => n.id === id);
        return node !== undefined && node.kind !== 'entry';
      });
      return nodes.length > 0
        ? nodes.map((node) => ({ type: 'removeNode', node }))
        : undefined;
    }

    default: {
      return undefined;
    }
  }
}

function removeEdge(e: GraphEdge): GraphEdit {
  return { type: 'removeEdge', from: e.from, to: e.to };
}

/** Nodes an edit refers to. */
export function overlayEditNodes(edit: GraphEdit): string[] {
  switch (edit.type) {
    case 'removeNode': {
      return [edit.node];
    }

    case 'addNodes': {
      return edit.nodes.map((n) => n.id);
    }

    default: {
      return [edit.from.node, edit.to.node];
    }
  }
}

/**
 * Follows the overlay through a re-parse (an edit of the code, or code the
 * overlay was written into): node ids move like positions do. Edits whose
 * nodes are gone are dropped and counted.
 */
export function remapOverlay(
  previous: GraphDocument,
  next: GraphDocument,
  overlay: GraphOverlay,
  change?: TextChange
): { overlay: GraphOverlay; dropped: number } {
  if (isEmptyOverlay(overlay)) {
    return { overlay, dropped: 0 };
  }

  const renamed = renamedNodes(previous, next, change);
  const present = new Set(
    next.functions.flatMap((f) => f.nodes.map((n) => n.id))
  );
  // Floating nodes keep their ids while they float.
  for (const edit of overlay.edits) {
    if (edit.type === 'addNodes') {
      for (const node of edit.nodes) {
        present.add(node.id);
      }
    }
  }

  const map = (id: string): string | undefined => {
    const to = renamed.get(id) ?? id;
    return present.has(to) ? to : undefined;
  };
  const ref = (r: PinRef): PinRef | undefined => {
    const node = map(r.node);
    return node ? { node, pin: r.pin } : undefined;
  };

  const edits: GraphEdit[] = [];
  let dropped = 0;
  for (const edit of overlay.edits) {
    if (edit.type === 'addNodes') {
      // A renamed function: the nodes follow it (else the last one).
      const fnId =
        renamedFunction(previous, next, edit.fnId, renamed) ?? edit.fnId;
      edits.push({ ...edit, fnId });
      continue;
    }

    if (edit.type === 'removeNode') {
      const node = map(edit.node);
      if (node) {
        edits.push({ type: 'removeNode', node });
      } else {
        dropped++;
      }

      continue;
    }

    const from = ref(edit.from);
    const to = ref(edit.to);
    if (from && to) {
      edits.push({ ...edit, from, to });
    } else {
      dropped++;
    }
  }

  return { overlay: { edits }, dropped };
}

/** The id of a function after a re-parse, through its entry node. */
function renamedFunction(
  previous: GraphDocument,
  next: GraphDocument,
  fnId: string,
  renamed: Map<string, string>
): string | undefined {
  const entry = previous.functions
    .find((f) => f.id === fnId)
    ?.nodes.find((n) => n.kind === 'entry');
  const to = entry ? (renamed.get(entry.id) ?? entry.id) : undefined;
  return to
    ? next.functions.find((f) => f.nodes.some((n) => n.id === to))?.id
    : undefined;
}

/**
 * How the shown graph differs from the parsed one, for writing it as code:
 * wires to add and to remove, nodes to delete.
 */
export function overlayDiff(
  parsed: GraphDocument,
  shown: GraphDocument
): {
  added: GraphEdge[];
  removed: GraphEdge[];
  deletedNodes: string[];
} {
  const added: GraphEdge[] = [];
  const removed: GraphEdge[] = [];
  const deletedNodes: string[] = [];
  for (const fn of parsed.functions) {
    const target = shown.functions.find((f) => f.id === fn.id);
    if (!target) {
      continue;
    }

    const before = new Set(fn.edges.map(edgeKey));
    const after = new Set(target.edges.map(edgeKey));
    const kept = new Set(target.nodes.map((n) => n.id));
    deletedNodes.push(
      ...fn.nodes.filter((n) => !kept.has(n.id)).map((n) => n.id)
    );
    added.push(...target.edges.filter((e) => !before.has(edgeKey(e))));
    removed.push(
      ...fn.edges.filter(
        (e) =>
          !after.has(edgeKey(e)) && kept.has(e.from.node) && kept.has(e.to.node)
      )
    );
  }

  return { added, removed, deletedNodes };
}
