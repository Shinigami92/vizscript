import type { StatementMeta } from './edit-meta';
import { getMeta } from './edit-meta';
import type {
  FloatingNodes,
  GraphEdit,
  GraphOverlay,
  OverlayIssue,
} from './graph-overlay';
import {
  applyOverlay,
  compactOverlay,
  floatingGroup,
  isEmptyOverlay,
  overlayDiff,
  overlayIssues,
  remapOverlay,
} from './graph-overlay';
import type { FunctionGraph, GraphDocument, GraphEdge, PinRef } from './ir';
import type { GraphOp } from './ops';
import { applyTextEdits } from './ops';
import type { OverlayBackend } from './overlay-snippets';
import { placedNodes, withPlacedGroup } from './overlay-snippets';
import { renamedNodes } from './reconcile';

export type OverlayResolution =
  /**
   * The graph is code again: `text` (maybe unchanged) holds it all.
   * `placed`: the ids floating nodes got once written (for their layout).
   */
  | { status: 'synced'; text: string; placed?: Record<string, string> }
  /** The graph can't be code yet; the code stays as it is. */
  | { status: 'pending'; issues: OverlayIssue[] };

/** Exec wires in the order the code runs (entry first, pins in order). */
function execOrder(fn: FunctionGraph): GraphEdge[] {
  const out = new Map<string, GraphEdge[]>();
  for (const e of fn.edges) {
    if (e.kind === 'exec') {
      out.set(e.from.node, [...(out.get(e.from.node) ?? []), e]);
    }
  }

  const pinOrder = (e: GraphEdge): number => {
    const node = fn.nodes.find((n) => n.id === e.from.node);
    return node?.pins.findIndex((p) => p.id === e.from.pin) ?? 0;
  };
  const ordered: GraphEdge[] = [];
  const seen = new Set<string>();
  const visit = (id: string): void => {
    if (seen.has(id)) {
      return;
    }

    seen.add(id);
    for (const e of (out.get(id) ?? []).toSorted(
      (a, b) => pinOrder(a) - pinOrder(b)
    )) {
      ordered.push(e);
      visit(e.to.node);
    }
  };
  for (const entry of fn.nodes.filter((n) => n.kind === 'entry')) {
    visit(entry.id);
  }

  return ordered;
}

/**
 * The next code edit that brings the code's structure closer to the shown
 * graph: deletions first, then statement moves in the order the code runs.
 * `null` when the structure matches; `undefined` when the difference can't
 * be written as an op. Data wires are written afterwards, edit by edit (a
 * wire from a SET becomes a Get node in the code, so the graphs never match
 * exactly).
 */
function nextStructureOp(
  parsed: GraphDocument,
  shown: GraphDocument,
  overlay: GraphOverlay
): Step | null | undefined {
  const diff = overlayDiff(parsed, shown);
  const [deleted] = diff.deletedNodes;
  if (deleted) {
    return { op: { type: 'deleteNodes', nodeIds: [deleted] } };
  }

  const group = (id: string): FloatingNodes | undefined => {
    const name = floatingGroup(id);
    return overlay.edits.find(
      (e): e is FloatingNodes => e.type === 'addNodes' && e.id === name
    );
  };
  const added = new Set(
    diff.added.filter((e) => e.kind === 'exec').map((e) => e.id)
  );
  for (const fn of shown.functions) {
    const edge = execOrder(fn).find((e) => added.has(e.id));
    if (!edge) {
      continue;
    }

    const floating = group(edge.to.node);
    if (floating || floatingGroup(edge.from.node) !== undefined) {
      // Floating nodes wired into the flow: their code goes there.
      return floating && floatingGroup(edge.from.node) === undefined
        ? {
            op: {
              type: 'addNode',
              template: { type: 'code', code: floating.code },
              after: edge.from,
            },
            group: floating,
          }
        : undefined;
    }

    return {
      op: {
        type: 'connect',
        from: edge.from,
        to: { node: statementNode(fn, edge.to.node), pin: edge.to.pin },
      },
    };
  }

  // A floating value wired into an input of the code becomes its value.
  for (const edge of diff.added) {
    const floating = group(edge.from.node);
    if (
      edge.kind === 'data' &&
      floating &&
      floatingGroup(edge.to.node) === undefined
    ) {
      return {
        op: { type: 'setInput', pin: edge.to, expression: floating.code },
        group: floating,
      };
    }
  }

  return diff.removed.some((e) => e.kind === 'exec') ? undefined : null;
}

/** An op that brings the code closer to the graph (and what it writes). */
interface Step {
  op: GraphOp;
  /** Floating nodes the op writes as code. */
  group?: FloatingNodes;
}

/**
 * The node whose statement moves when execution is wired into `id`: the node
 * itself, or for a call inside an expression (`log(greet(x))`, run before
 * its statement) the statement around it.
 */
function statementNode(fn: FunctionGraph, id: string): string {
  const node = fn.nodes.find((n) => n.id === id);
  if (!node || getMeta<StatementMeta>(node).stmt) {
    return id;
  }

  let best: { id: string; size: number } | undefined;
  for (const n of fn.nodes) {
    const stmt = getMeta<StatementMeta>(n).stmt;
    if (
      stmt &&
      n.id !== id &&
      stmt.start <= node.range.start &&
      node.range.end <= stmt.end &&
      (!best || stmt.end - stmt.start < best.size)
    ) {
      best = { id: n.id, size: stmt.end - stmt.start };
    }
  }

  return best?.id ?? id;
}

/** Whether an edit is about a data wire (an input's value). */
function isDataEdit(edit: GraphEdit, doc: GraphDocument): boolean {
  if (edit.type === 'removeNode' || edit.type === 'addNodes') {
    return false;
  }

  if (edit.type === 'addEdge') {
    return edit.kind === 'data';
  }

  const node = doc.functions
    .flatMap((f) => f.nodes)
    .find((n) => n.id === edit.to.node);
  return node?.pins.find((p) => p.id === edit.to.pin)?.kind === 'data';
}

function hasEdge(doc: GraphDocument, from: PinRef, to: PinRef): boolean {
  return doc.functions.some((f) =>
    f.edges.some(
      (e) =>
        e.from.node === from.node &&
        e.from.pin === from.pin &&
        e.to.node === to.node &&
        e.to.pin === to.pin
    )
  );
}

/** The node an op is about, for its issue. */
function nodeOf(op: GraphOp): string {
  switch (op.type) {
    case 'deleteNodes': {
      return op.nodeIds[0] ?? '';
    }

    case 'connect': {
      return op.to.node;
    }

    case 'disconnect': {
      return op.pin.node;
    }

    default: {
      return '';
    }
  }
}

function pending(node: string, message: string): OverlayResolution {
  return { status: 'pending', issues: [{ node, message }] };
}

/**
 * Writes the graph-only edits as code once the shown graph is valid: first
 * the structure (deletions, statement moves) from the difference between
 * the parsed and the shown graph, then each data wire as `connect` /
 * `disconnect`. Ops are applied one by one on a copy of the text and the
 * edits follow the re-parsed ids. Atomic: if one step fails, the code
 * stays as it is.
 */
export function resolveOverlay(
  text: string,
  overlay: GraphOverlay,
  backend: OverlayBackend,
  maxSteps = 200
): OverlayResolution {
  if (isEmptyOverlay(overlay)) {
    return { status: 'synced', text };
  }

  let source = text;
  let doc = backend.parse(text);
  let current = compactOverlay(overlay);
  const issues = overlayIssues(doc, applyOverlay(doc, current));
  if (issues.length > 0) {
    return { status: 'pending', issues };
  }

  /** Ids written floating nodes have now. */
  const placed = new Map<string, string>();

  /** Applies one op; the error when it fails. */
  const step = (op: GraphOp, group?: FloatingNodes): string | undefined => {
    const result = backend.applyOp(source, op);
    if (!result.ok) {
      return result.error;
    }

    if (result.edits.length === 0) {
      return group
        ? 'The code of the new nodes could not be written.'
        : undefined;
    }

    const nextText = applyTextEdits(source, result.edits);
    const nextDoc = backend.parse(nextText);
    const change = { before: source, edits: result.edits };
    current = remapOverlay(doc, nextDoc, current, change).overlay;
    const renamed = renamedNodes(doc, nextDoc, change);
    for (const [from, to] of placed) {
      placed.set(from, renamed.get(to) ?? to);
    }

    if (group) {
      const ids = placedNodes(doc, nextDoc, change, group);
      current = withPlacedGroup(current, group.id, ids);
      for (const [from, to] of ids) {
        placed.set(from, to);
      }
    }

    doc = nextDoc;
    source = nextText;
    return undefined;
  };

  for (let i = 0; ; i++) {
    if (i >= maxSteps) {
      return pending('', 'Writing the graph as code did not end.');
    }

    const next = nextStructureOp(doc, applyOverlay(doc, current), current);
    if (next === null) {
      break;
    }

    if (next === undefined) {
      return pending('', 'The code cannot follow these wires yet.');
    }

    const error = step(next.op, next.group);
    if (error !== undefined) {
      return pending(nodeOf(next.op), error);
    }
  }

  for (let i = 0; ; i++) {
    if (i >= maxSteps) {
      return pending('', 'Writing the graph as code did not end.');
    }

    const index = current.edits.findIndex((e) => isDataEdit(e, doc));
    const edit = current.edits[index];
    if (!edit || edit.type === 'removeNode' || edit.type === 'addNodes') {
      break;
    }

    // Done once written: the code may show it differently (a Get node).
    current = { edits: current.edits.filter((_, j) => j !== index) };
    const op: GraphOp =
      edit.type === 'addEdge'
        ? { type: 'connect', from: edit.from, to: edit.to }
        : { type: 'disconnect', pin: edit.to };
    const done =
      edit.type === 'addEdge'
        ? hasEdge(doc, edit.from, edit.to)
        : !hasEdge(doc, edit.from, edit.to);
    const error = done ? undefined : step(op);
    if (error !== undefined) {
      return pending(nodeOf(op), error);
    }
  }

  return placed.size > 0
    ? { status: 'synced', text: source, placed: Object.fromEntries(placed) }
    : { status: 'synced', text: source };
}
