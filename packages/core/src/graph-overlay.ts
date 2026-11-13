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
  | { type: 'removeNode'; node: string };

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
        const fn = byNode(edit.from.node);
        if (!fn || byNode(edit.to.node) !== fn) {
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
        if (fn && node) {
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

  return { ...doc, functions };
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
      const to = fn?.nodes
        .find((n) => n.id === op.to.node)
        ?.pins.find((p) => p.id === op.to.pin);
      if (
        !fn ||
        !from ||
        !to ||
        functionOfNode(doc, op.to.node) !== fn ||
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
  return edit.type === 'removeNode'
    ? [edit.node]
    : [edit.from.node, edit.to.node];
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
