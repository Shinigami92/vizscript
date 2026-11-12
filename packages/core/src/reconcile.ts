import type { GraphDocument, GraphNode, Positions } from './ir';
import type { TextEdit } from './ops';

function* allNodes(
  doc: GraphDocument
): Generator<[fnId: string, node: GraphNode]> {
  for (const fn of doc.functions) {
    for (const node of fn.nodes) {
      yield [fn.id, node];
    }
  }
}

/**
 * The change between two texts as one edit (common start and end kept),
 * for changes that are no op: typing, undo, redo.
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

  return [
    {
      start,
      end: before.length - end,
      text: after.slice(start, after.length - end),
    },
  ];
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
  const code = removed.trim();
  const codeStart = removal.start + removed.length - removed.trimStart().length;
  const inside = offset - codeStart;
  if (code === '' || inside < 0 || inside >= code.length) {
    return undefined;
  }

  const target = change.edits.find(
    (e) => e !== removal && e.text.includes(code)
  );
  return target
    ? newStart(target, change.edits) + target.text.indexOf(code) + inside
    : undefined;
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
  change: TextChange
): Map<string, string> {
  const at = new Map<string, string>();
  for (const [fnId, node] of allNodes(next)) {
    at.set(`${fnId}|${node.kind}|${node.range.start}`, node.id);
  }

  const result = new Map<string, string>();
  for (const [fnId, node] of allNodes(previous)) {
    const start = mapOffset(node.range.start, change);
    const match =
      start === undefined ? undefined : at.get(`${fnId}|${node.kind}|${start}`);
    if (match && match !== node.id) {
      result.set(node.id, match);
    }
  }

  return result;
}

/**
 * Pairs nodes that disappeared in `next` with the nodes that took their
 * place. With the `change` (an op's edits, or a diff), nodes are first followed through it
 * ({@link movedNodes}). Then two passes:
 * 1. same function, structural path and kind (e.g. an edited literal),
 * 2. same function, kind and title, in document order (e.g. a call whose
 *    text changed *and* moved because a statement was inserted before it).
 */
export function renamedNodes(
  previous: GraphDocument,
  next: GraphDocument,
  change?: TextChange
): Map<string, string> {
  const moved = change ? movedNodes(previous, next, change) : new Map();
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
      removed.push([fnId, node]);
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
 * {@link renamedNodes}.
 */
export function reconcilePositions(
  previous: GraphDocument | undefined,
  next: GraphDocument,
  positions: Positions,
  change?: TextChange
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

  // An id that now names another node's code takes that node's position.
  for (const [, node] of allNodes(next)) {
    const own = positions[node.id];
    if (own && !targets.has(node.id)) {
      result[node.id] = own;
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
