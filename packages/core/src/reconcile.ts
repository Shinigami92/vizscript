import type { GraphDocument, GraphNode, Positions } from './ir';
import type { TextEdit } from './ops';
import { applyTextEdits } from './ops';

function* allNodes(
  doc: GraphDocument
): Generator<[fnId: string, node: GraphNode]> {
  for (const fn of doc.functions) {
    for (const node of fn.nodes) {
      yield [fn.id, node];
    }
  }
}

/** Words, runs of white space and single other characters. */
function tokenize(text: string): string[] {
  return text.match(/\w+|\s+|[^\w\s]/g) ?? [];
}

/** Lines with their line break. */
function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** Above this many item pairs a changed part stays one edit. */
const MAX_DIFF_CELLS = 4_000_000;

/**
 * Edits that turn the items of `a` into those of `b` (longest common
 * subsequence); `refine` splits a replaced run further. `undefined` when
 * the texts are too long to compare.
 */
function sequenceEdits(
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string>,
  base: number,
  refine?: (removed: string, inserted: string, at: number) => TextEdit[]
): TextEdit[] | undefined {
  if (a.length * b.length > MAX_DIFF_CELLS) {
    return undefined;
  }

  // lengths[i][j]: common items of a[i..] and b[j..].
  const width = b.length + 1;
  const lengths = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i * width + j] =
        a[i] === b[j]
          ? (lengths[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(
              lengths[(i + 1) * width + j] ?? 0,
              lengths[i * width + j + 1] ?? 0
            );
    }
  }

  const edits: TextEdit[] = [];
  let offset = base;
  let open: TextEdit | undefined;
  /** The items `open` removes. */
  const removedItems: string[] = [];
  const close = (): void => {
    if (!open) {
      return;
    }

    const edit = open;
    const removed = removedItems.splice(0).join('');
    open = undefined;
    edits.push(
      ...(refine && removed !== '' && edit.text !== ''
        ? refine(removed, edit.text, edit.start)
        : [edit])
    );
  };

  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const ai = a[i];
    const bj = b[j];
    if (ai !== undefined && ai === bj) {
      close();
      offset += ai.length;
      i++;
      j++;
    } else if (
      bj === undefined ||
      (ai !== undefined &&
        (lengths[(i + 1) * width + j] ?? 0) >=
          (lengths[i * width + j + 1] ?? 0))
    ) {
      open ??= { start: offset, end: offset, text: '' };
      open.end += ai?.length ?? 0;
      removedItems.push(ai ?? '');
      offset += ai?.length ?? 0;
      i++;
    } else {
      open ??= { start: offset, end: offset, text: '' };
      open.text += bj;
      j++;
    }
  }

  close();
  return edits;
}

/**
 * Minimal edits between two texts: the common start and end are kept, the
 * middle is compared line by line, and changed lines token by token. Code
 * that moved shows as a removal and an insertion of the same text, so
 * nodes can be followed through undo and redo ({@link movedNodes}).
 */
export function diffEdits(before: string, after: string): TextEdit[] {
  if (before === after) {
    return [];
  }

  let start = 0;
  const shorter = Math.min(before.length, after.length);
  while (start < shorter && before[start] === after[start]) {
    start++;
  }

  let end = 0;
  while (
    end < shorter - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  ) {
    end++;
  }

  const removed = before.slice(start, before.length - end);
  const inserted = after.slice(start, after.length - end);
  const whole: TextEdit = {
    start,
    end: start + removed.length,
    text: inserted,
  };
  if (removed === '' || inserted === '') {
    return [whole];
  }

  const byTokens = (from: string, to: string, at: number): TextEdit[] =>
    sequenceEdits(tokenize(from), tokenize(to), at) ?? [
      { start: at, end: at + from.length, text: to },
    ];
  return (
    sequenceEdits(
      splitLines(removed),
      splitLines(inserted),
      start,
      byTokens
    ) ?? [whole]
  );
}

/** The edits of a change and the text they were made on. */
export interface TextChange {
  edits: ReadonlyArray<TextEdit>;
  before: string;
}

/** Where the start of `edit` is in the new text. */
function newStart(edit: TextEdit, edits: ReadonlyArray<TextEdit>): number {
  let shift = 0;
  for (const other of edits) {
    if (other !== edit && other.end <= edit.start && other.start < edit.start) {
      shift += other.text.length - (other.end - other.start);
    }
  }

  return edit.start + shift;
}

/**
 * Where an offset of the old text is after the change, or `undefined`
 * inside replaced text. Code that was moved (removed here, the same text
 * inserted elsewhere) is followed to its new place.
 */
function mapOffset(offset: number, change: TextChange): number | undefined {
  let shift = 0;
  for (const edit of change.edits) {
    if (
      edit.end <= offset &&
      (edit.start < offset || edit.start === edit.end)
    ) {
      shift += edit.text.length - (edit.end - edit.start);
    } else if (edit.start <= offset && offset < edit.end) {
      return movedOffset(offset, edit, change);
    }
  }

  return offset + shift;
}

function movedOffset(
  offset: number,
  removal: TextEdit,
  change: TextChange
): number | undefined {
  const removed = change.before.slice(removal.start, removal.end);
  const codeStart = removal.start + removed.length - removed.trimStart().length;
  const inside = offset - codeStart;
  // A statement moved into an expression loses its `;` (and back).
  const trimmed = removed.trim();
  for (const code of [trimmed, trimmed.replace(/;$/, '')]) {
    if (code === '' || inside < 0 || inside >= code.length) {
      continue;
    }

    const target = change.edits.find(
      (e) => e !== removal && e.text.includes(code)
    );
    if (target) {
      return (
        newStart(target, change.edits) + target.text.indexOf(code) + inside
      );
    }
  }

  return undefined;
}

/**
 * Nodes found again where an edit moved their code: same function, kind
 * and (shifted) start. Ids count equal code (`greeter(user)#0`, `#1`), so
 * when one of two equal calls changes, the other one takes its id; this
 * keeps each node with its own code.
 */
function movedNodes(
  previous: GraphDocument,
  next: GraphDocument,
  change: TextChange,
  functions: ReadonlyMap<string, string>
): Map<string, string> {
  // Nested nodes of one kind can start at the same offset (`a * b * 100`
  // has two `*`): the one of the same length is the same node.
  const at = new Map<string, GraphNode[]>();
  for (const [fnId, node] of allNodes(next)) {
    const key = `${fnId}|${node.kind}|${node.range.start}`;
    at.set(key, [...(at.get(key) ?? []), node]);
  }

  const after = textAfter(change);
  const result = new Map<string, string>();
  for (const [previousFn, node] of allNodes(previous)) {
    const fnId = functions.get(previousFn) ?? previousFn;
    const length = node.range.end - node.range.start;
    const pick = (start: number | undefined): GraphNode | undefined => {
      const candidates =
        start === undefined
          ? []
          : (at.get(`${fnId}|${node.kind}|${start}`) ?? []);
      return (
        candidates.find((n) => n.range.end - n.range.start === length) ??
        (candidates.length === 1 ? candidates[0] : undefined)
      );
    };
    const match = (
      pick(nodeStart(node, change)) ??
      pick(uniqueCodeStart(node, change.before, after))
    )?.id;
    if (match && match !== node.id) {
      result.set(node.id, match);
    }
  }

  return result;
}

/**
 * Where a node of the old text starts after the change: shifted, moved
 * with the code around it, or (inside replaced code) where its own code is
 * found once in the inserted text. `undefined` for a node whose own code
 * changed: it reaches out of the replaced text (`a * b` when `a` changes).
 */
function nodeStart(node: GraphNode, change: TextChange): number | undefined {
  const { start, end } = node.range;
  const inside = change.edits.find((e) => e.start <= start && start < e.end);
  if (inside && end > inside.end) {
    return undefined;
  }

  const mapped = mapOffset(start, change);
  if (mapped !== undefined || !inside) {
    return mapped;
  }

  const code = change.before.slice(start, end).trim();
  if (code === '') {
    return undefined;
  }

  const found = change.edits.flatMap((e) => {
    const at = e.text.indexOf(code);
    return at === -1 || e.text.includes(code, at + 1)
      ? []
      : [newStart(e, change.edits) + at];
  });
  return found.length === 1 ? found[0] : undefined;
}

/** The text after a change (empty if its edits don't fit together). */
function textAfter(change: TextChange): string {
  try {
    return applyTextEdits(change.before, change.edits);
  } catch {
    return '';
  }
}

/**
 * Where a node's code is after a change, when that code occurs once in the
 * old and once in the new text (longer code only: short names repeat).
 */
function uniqueCodeStart(
  node: GraphNode,
  before: string,
  after: string
): number | undefined {
  const code = before.slice(node.range.start, node.range.end);
  if (
    code.trim().length < 8 ||
    before.indexOf(code, node.range.start + 1) !== -1 ||
    before.lastIndexOf(code, node.range.start - 1) !== -1
  ) {
    return undefined;
  }

  const at = after.indexOf(code);
  return at !== -1 && after.indexOf(code, at + 1) === -1 ? at : undefined;
}

/**
 * Pairs nodes that disappeared in `next` with the nodes that took their
 * place. With the `change` (an op's edits, or a diff), nodes are first followed through it
 * ({@link movedNodes}). Then two passes:
 * 1. same function, structural path and kind (e.g. an edited literal),
 * 2. same function, kind and title, in document order (e.g. a call whose
 *    text changed *and* moved because a statement was inserted before it).
 */
/**
 * Functions whose id changed (a renamed function: its id follows the name),
 * paired by where they start (followed through the change), else by their
 * order among the changed ones.
 */
function renamedFunctions(
  previous: GraphDocument,
  next: GraphDocument,
  change?: TextChange
): Map<string, string> {
  const nextIds = new Set(next.functions.map((f) => f.id));
  const previousIds = new Set(previous.functions.map((f) => f.id));
  const gone = previous.functions.filter((f) => !nextIds.has(f.id));
  const added = next.functions.filter((f) => !previousIds.has(f.id));
  const result = new Map<string, string>();
  for (const [i, fn] of gone.entries()) {
    const start = change ? mapOffset(fn.range.start, change) : fn.range.start;
    const match =
      added.find((f) => f.range.start === start) ??
      (gone.length === added.length ? added[i] : undefined);
    if (match && ![...result.values()].includes(match.id)) {
      result.set(fn.id, match.id);
    }
  }

  return result;
}

export function renamedNodes(
  previous: GraphDocument,
  next: GraphDocument,
  change?: TextChange
): Map<string, string> {
  const functions = renamedFunctions(previous, next, change);
  const moved = change
    ? movedNodes(previous, next, change, functions)
    : new Map();
  const previousIds = new Set<string>();
  for (const [, node] of allNodes(previous)) {
    previousIds.add(node.id);
  }

  const nextIds = new Set<string>();
  const added: Array<[string, GraphNode]> = [];
  for (const [fnId, node] of allNodes(next)) {
    nextIds.add(node.id);
    if (!previousIds.has(node.id)) {
      added.push([fnId, node]);
    }
  }

  const removed: Array<[string, GraphNode]> = [];
  for (const [fnId, node] of allNodes(previous)) {
    if (!nextIds.has(node.id)) {
      removed.push([functions.get(fnId) ?? fnId, node]);
    }
  }

  const result = new Map<string, string>(moved);
  const taken = new Set<string>(moved.values());
  const pass = (key: (fnId: string, node: GraphNode) => string): void => {
    const candidates = new Map<string, string[]>();
    for (const [fnId, node] of added) {
      if (!taken.has(node.id)) {
        const k = key(fnId, node);
        candidates.set(k, [...(candidates.get(k) ?? []), node.id]);
      }
    }

    for (const [fnId, node] of removed) {
      if (result.has(node.id)) {
        continue;
      }

      const match = candidates.get(key(fnId, node))?.shift();
      if (match) {
        result.set(node.id, match);
        taken.add(match);
      }
    }
  };

  pass((fnId, node) => `${fnId}|${node.path}|${node.kind}`);
  pass((fnId, node) => `${fnId}|${node.kind}|${node.title}`);
  return result;
}

/**
 * Carries positions over from a previous parse to a new one.
 *
 * Node ids are content based, so most nodes match by id directly. Nodes
 * whose own text changed get a new id; they are matched with
 * {@link renamedNodes}. Ids count equal code (`total#0`, `total#1`): when
 * one of two equal nodes goes, the other one takes its id, and its old
 * position goes with it ({@link movedNodes}).
 *
 * `memory` (updated in place) keeps the positions of nodes that disappear
 * and gives them back when the same node returns, e.g. on undo or redo, so
 * it comes back where it was instead of on top of its twin.
 */
export function reconcilePositions(
  previous: GraphDocument | undefined,
  next: GraphDocument,
  positions: Positions,
  change?: TextChange,
  memory?: Positions
): Positions {
  const result: Positions = {};
  const renamed = previous
    ? renamedNodes(previous, next, change)
    : new Map<string, string>();
  const targets = new Set(renamed.values());
  for (const [oldId, newId] of renamed) {
    const p = positions[oldId];
    if (p) {
      result[newId] = p;
    }
  }

  const nextIds = new Set<string>();
  for (const [, node] of allNodes(next)) {
    nextIds.add(node.id);
    if (result[node.id]) {
      continue;
    }

    // A position stays with its id unless that node took another id; the
    // node with this id now is another one (its twin came back).
    const own = positions[node.id];
    const remembered = memory?.[node.id];
    if (own && !targets.has(node.id) && !renamed.has(node.id)) {
      result[node.id] = own;
    } else if (memory && remembered) {
      result[node.id] = remembered;
      delete memory[node.id];
    }
  }

  // Nodes that are gone (deleted, or their id went to their twin).
  if (previous && memory) {
    for (const [, node] of allNodes(previous)) {
      const p = positions[node.id];
      const gone = !nextIds.has(node.id) || targets.has(node.id);
      if (p && gone && !renamed.has(node.id)) {
        memory[node.id] = p;
      }
    }
  }

  return result;
}

/** Returns the innermost node whose source range contains `offset`. */
export function findNodeAtOffset(
  doc: GraphDocument,
  offset: number
): GraphNode | undefined {
  let best: GraphNode | undefined;
  for (const [, node] of allNodes(doc)) {
    if (
      node.kind !== 'entry' &&
      node.range.start <= offset &&
      offset <= node.range.end &&
      (!best ||
        node.range.end - node.range.start < best.range.end - best.range.start)
    ) {
      best = node;
    }
  }

  return best;
}

export function findNode(
  doc: GraphDocument,
  nodeId: string
): GraphNode | undefined {
  for (const [, node] of allNodes(doc)) {
    if (node.id === nodeId) {
      return node;
    }
  }

  return undefined;
}
