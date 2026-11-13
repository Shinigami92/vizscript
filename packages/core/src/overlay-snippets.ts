import type { StatementMeta } from './edit-meta';
import { getMeta } from './edit-meta';
import { endOfFunction } from './flow';
import type { FloatingNodes, GraphEdit, GraphOverlay } from './graph-overlay';
import { floatingGroup, floatingPrefix } from './graph-overlay';
import { edgeId } from './ids';
import type { GraphDocument, GraphNode, SourceRange } from './ir';
import type { GraphOp, NodeTemplate, OpResult, TextEdit } from './ops';
import { applyTextEdits } from './ops';
import type { TextChange } from './reconcile';
import { renamedNodes } from './reconcile';

/** What graph-only edits need from a language backend. */
export interface OverlayBackend {
  parse: (text: string) => GraphDocument;
  applyOp: (text: string, op: GraphOp) => OpResult;
}

export type FloatingResult =
  | { ok: true; edit: FloatingNodes }
  | { ok: false; error: string };

/** Name of the function a dry run adds when the file has none. */
const SCRATCH_FUNCTION = 'vizscript_scratch';

/** Whether a graph is the file's top level (a module or class body). */
function isTopLevel(text: string, range: SourceRange): boolean {
  return range.start === 0 && range.end >= text.trimEnd().length;
}

/** Where the text of the edits is in the edited text. */
function insertedRanges(edits: ReadonlyArray<TextEdit>): SourceRange[] {
  let shift = 0;
  return edits
    .toSorted((a, b) => a.start - b.start)
    .map((edit) => {
      const start = edit.start + shift;
      shift += edit.text.length - (edit.end - edit.start);
      return { start, end: start + edit.text.length };
    });
}

/**
 * Nodes of `next` that `previous` didn't have, in code order: only those
 * in the inserted text (code around it may get new ids too).
 */
function freshNodes(
  previous: GraphDocument,
  next: GraphDocument,
  change: TextChange
): GraphNode[] {
  const renamed = renamedNodes(previous, next, change);
  const old = new Set(
    previous.functions.flatMap((f) =>
      f.nodes.map((n) => renamed.get(n.id) ?? n.id)
    )
  );
  const inserted = insertedRanges(change.edits);
  return next.functions
    .flatMap((f) => f.nodes)
    .filter(
      (n) =>
        n.kind !== 'entry' &&
        !old.has(n.id) &&
        inserted.some((r) => r.start <= n.range.start && n.range.end <= r.end)
    )
    .toSorted((a, b) => a.range.start - b.range.start);
}

function hasExecIn(node: GraphNode): boolean {
  return node.pins.some((p) => p.kind === 'exec' && p.direction === 'in');
}

/** The code of new nodes: their statements, or the value they compute. */
function codeOf(
  text: string,
  nodes: ReadonlyArray<GraphNode>,
  next: GraphDocument
): { code: string; base: number } | undefined {
  const ids = new Set(nodes.map((n) => n.id));
  const edges = next.functions.flatMap((f) => f.edges);
  if (!nodes.some(hasExecIn)) {
    // A value: the node whose result nothing else of it uses.
    const root = nodes.find(
      (n) => !edges.some((e) => e.from.node === n.id && ids.has(e.to.node))
    );
    return root
      ? {
          code: text.slice(root.range.start, root.range.end),
          base: root.range.start,
        }
      : undefined;
  }

  const ranges = nodes.map((n) => getMeta<StatementMeta>(n).stmt ?? n.range);
  const start = Math.min(...ranges.map((r) => r.start));
  const end = Math.max(...ranges.map((r) => r.end));
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const before = text.slice(lineStart, start);
  const indent = before.slice(0, before.length - before.trimStart().length);
  const code = text
    .slice(start, end)
    .split('\n')
    .map((line, i) =>
      i > 0 && line.startsWith(indent) ? line.slice(indent.length) : line
    )
    .join('\n');
  return { code, base: start };
}

/** The new nodes of an applied op as floating nodes. */
function collect(
  text: string,
  doc: GraphDocument,
  edits: ReadonlyArray<TextEdit>,
  backend: OverlayBackend,
  id: string,
  fnId: string
): FloatingResult {
  const nextText = applyTextEdits(text, [...edits]);
  const next = backend.parse(nextText);
  const fresh = freshNodes(doc, next, { before: text, edits: [...edits] });
  const written = fresh.length > 0 ? codeOf(nextText, fresh, next) : undefined;
  if (!written) {
    return { ok: false, error: 'This adds no nodes.' };
  }

  const prefix = floatingPrefix(id);
  const ids = new Set(fresh.map((n) => n.id));
  const nodes = fresh.map((n) => ({
    ...n,
    id: `${prefix}${n.id}`,
    // Relative to the code, for matching them once they are written.
    range: {
      start: n.range.start - written.base,
      end: n.range.end - written.base,
    },
  }));
  const edges = next.functions
    .flatMap((f) => f.edges)
    .filter((e) => ids.has(e.from.node) && ids.has(e.to.node))
    .map((e) => {
      const from = { node: `${prefix}${e.from.node}`, pin: e.from.pin };
      const to = { node: `${prefix}${e.to.node}`, pin: e.to.pin };
      return { ...e, id: edgeId(from, to), from, to };
    });
  return {
    ok: true,
    edit: { type: 'addNodes', id, fnId, code: written.code, nodes, edges },
  };
}

/**
 * Nodes for a template that has no place in the code yet (UE: a node
 * dropped anywhere in the graph): the template is written at the end of a
 * function of a copy of the code, and the nodes it makes are kept as
 * floating graph-only nodes of `fnId`.
 */
export function floatingNodes(
  text: string,
  template: NodeTemplate,
  fnId: string | undefined,
  id: string,
  backend: OverlayBackend,
  scratch = true
): FloatingResult {
  const doc = backend.parse(text);
  const functions = doc.functions
    .filter(
      (f) =>
        !isTopLevel(text, f.range) && f.nodes.some((n) => n.kind === 'entry')
    )
    .toSorted((a, b) => Number(b.id === fnId) - Number(a.id === fnId));
  const home = fnId ?? doc.functions.at(-1)?.id;
  let error = 'Nodes cannot be added here.';
  for (const fn of functions) {
    const anchor = endOfFunction(doc, fn.id);
    if (!anchor) {
      continue;
    }

    const result = backend.applyOp(text, {
      type: 'addNode',
      template,
      ...anchor,
    });
    if (result.ok) {
      return collect(text, doc, result.edits, backend, id, home ?? fn.id);
    }

    error = result.error;
  }

  if (functions.length > 0 || !scratch) {
    return { ok: false, error };
  }

  // No function to try it in: a scratch one (never written to the file).
  const added = backend.applyOp(text, {
    type: 'addFunction',
    scope: '',
    name: SCRATCH_FUNCTION,
  });
  if (!added.ok) {
    return { ok: false, error: added.error };
  }

  const result = floatingNodes(
    applyTextEdits(text, added.edits),
    template,
    undefined,
    id,
    backend,
    false
  );
  return result.ok && home
    ? { ok: true, edit: { ...result.edit, fnId: home } }
    : result;
}

/**
 * Which written node each floating node became: the nodes new in `next`,
 * paired in code order by kind and title.
 */
export function placedNodes(
  previous: GraphDocument,
  next: GraphDocument,
  change: TextChange,
  edit: FloatingNodes
): Map<string, string> {
  const fresh = freshNodes(previous, next, change);
  const used = new Set<string>();
  const placed = new Map<string, string>();
  for (const node of edit.nodes.toSorted(
    (a, b) => a.range.start - b.range.start
  )) {
    const match =
      fresh.find(
        (n) => !used.has(n.id) && n.kind === node.kind && n.title === node.title
      ) ?? fresh.find((n) => !used.has(n.id) && n.kind === node.kind);
    if (match) {
      used.add(match.id);
      placed.set(node.id, match.id);
    }
  }

  return placed;
}

/**
 * The overlay once a group of floating nodes is written: the group is gone,
 * and the other edits use the ids of the written nodes (edits of nodes
 * that weren't found are dropped).
 */
export function withPlacedGroup(
  overlay: GraphOverlay,
  group: string,
  placed: Map<string, string>
): GraphOverlay {
  const map = (id: string): string | undefined =>
    floatingGroup(id) === group ? placed.get(id) : id;
  const edits: GraphEdit[] = [];
  for (const edit of overlay.edits) {
    if (edit.type === 'addNodes') {
      if (edit.id !== group) {
        edits.push(edit);
      }

      continue;
    }

    if (edit.type === 'removeNode') {
      const node = map(edit.node);
      if (node) {
        edits.push({ ...edit, node });
      }

      continue;
    }

    const from = map(edit.from.node);
    const to = map(edit.to.node);
    if (from && to) {
      edits.push({
        ...edit,
        from: { ...edit.from, node: from },
        to: { ...edit.to, node: to },
      });
    }
  }

  return { edits };
}
