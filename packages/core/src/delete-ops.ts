import { deleteCommentBox } from './comment-ops';
import type { StatementMeta } from './edit-meta';
import { getMeta, owningStatement } from './edit-meta';
import type { GraphDocument, GraphNode, Pin, SourceRange } from './ir';
import { failed, succeeded } from './op-result';
import type { OpResult, TextEdit } from './ops';
import { applyTextEdits } from './ops';
import { findNode } from './reconcile';
import {
  asStatement,
  contains,
  edgesOf,
  findPin,
  inputEdit,
  removeStatement,
} from './text-op-helpers';
import type { StatementSyntax } from './text-ops';
import { lineIndent } from './text-utils';

function sameRange(a: SourceRange, b: SourceRange): boolean {
  return a.start === b.start && a.end === b.end;
}

/**
 * Calls (and awaits) computed inside a statement that are not deleted with
 * it: `return fetch(url)` without the return keeps `fetch(url);`.
 */
function keptCalls(
  doc: GraphDocument,
  statementNode: GraphNode,
  stmt: SourceRange,
  deleted: ReadonlySet<string>
): GraphNode[] {
  const fn = doc.functions.find((f) => f.nodes.includes(statementNode));
  const candidates = (fn?.nodes ?? []).filter((n) => {
    if (
      n === statementNode ||
      deleted.has(n.id) ||
      n.purity !== 'impure' ||
      n.kind === 'entry' ||
      getMeta<StatementMeta>(n).stmt
    ) {
      return false;
    }

    const owner = owningStatement(n);
    return owner !== undefined && sameRange(owner.stmt, stmt);
  });
  // Only the outermost: `await fetch(url)` keeps the await with its call.
  return candidates
    .filter(
      (n) =>
        !candidates.some(
          (other) =>
            other !== n &&
            contains(other.range, n.range) &&
            !sameRange(other.range, n.range)
        )
    )
    .toSorted((a, b) => a.range.start - b.range.start);
}

/**
 * Nodes wired into a deleted value node that aren't deleted with it, like
 * UE keeps them: the outermost nodes inside its expression.
 */
function keptInputs(
  doc: GraphDocument,
  node: GraphNode,
  deleted: ReadonlySet<string>
): GraphNode[] {
  const fn = doc.functions.find((f) => f.nodes.includes(node));
  const candidates = (fn?.nodes ?? []).filter(
    (n) =>
      n !== node &&
      !deleted.has(n.id) &&
      n.kind !== 'entry' &&
      !getMeta<StatementMeta>(n).stmt &&
      contains(node.range, n.range) &&
      !sameRange(node.range, n.range)
  );
  return candidates
    .filter(
      (n) =>
        !candidates.some(
          (other) =>
            other !== n &&
            contains(other.range, n.range) &&
            !sameRange(other.range, n.range)
        )
    )
    .toSorted((a, b) => a.range.start - b.range.start);
}

/**
 * Where kept inputs of a deleted value go: lone statements right before its
 * statement (and that statement's comment), so the graph shows them as
 * unconnected nodes. Only for statements on an exec chain that stand on
 * their own line.
 */
function keepPoint(
  text: string,
  doc: GraphDocument,
  node: GraphNode
): { at: number; indent: string } | undefined {
  const owner = owningStatement(node);
  if (!owner) {
    return undefined;
  }

  const fn = doc.functions.find((f) => f.nodes.includes(node));
  const statement = fn?.nodes.find((n) => {
    const stmt = getMeta<StatementMeta>(n).stmt;
    return stmt !== undefined && sameRange(stmt, owner.stmt);
  });
  const meta = statement ? getMeta<StatementMeta>(statement) : undefined;
  if (
    !statement ||
    !meta ||
    meta.inline ||
    meta.locked ||
    !statement.pins.some((p) => p.kind === 'exec' && p.direction === 'in')
  ) {
    return undefined;
  }

  const indent = lineIndent(text, owner.stmt.start);
  if (
    text.slice(owner.stmt.start - indent.length, owner.stmt.start) !== indent
  ) {
    return undefined;
  }

  const comment = statement.comment?.range;
  return {
    at:
      comment && comment.end <= owner.stmt.start
        ? comment.start
        : owner.stmt.start,
    indent,
  };
}

/** The input whose whole expression is this node, if any. */
function consumerInput(doc: GraphDocument, node: GraphNode): Pin | undefined {
  for (const edge of edgesOf(doc, node.id)) {
    if (edge.from.node !== node.id) {
      continue;
    }

    const pin = findPin(findNode(doc, edge.to.node), edge.to.pin);
    if (pin?.range && sameRange(pin.range, node.range)) {
      return pin;
    }
  }

  return undefined;
}

/**
 * A moved statement leaves no blank line behind: a removal between two
 * blank lines (or at the start of the file) takes the one after it too.
 * The edits stay apart, so the moved code can be followed.
 */
export function withoutDoubleBlankLines(
  text: string,
  result: OpResult
): OpResult {
  if (!result.ok) {
    return result;
  }

  return succeeded(
    result.edits.map((edit) => {
      if (edit.text !== '') {
        return edit;
      }

      const before = text.slice(0, edit.start);
      const blankAfter = text.slice(edit.end).match(/^[ \t]*\n/)?.[0];
      const blankBefore =
        /^\s*$/.test(before) || /\n[ \t]*\n[ \t]*$/.test(before);
      const end = edit.end + (blankAfter?.length ?? 0);
      const touches = result.edits.some(
        (other) =>
          other !== edit && other.start >= edit.end && other.start <= end
      );
      return blankAfter && blankBefore && !touches ? { ...edit, end } : edit;
    })
  );
}

/**
 * Comment boxes whose nodes are all deleted go too (their `#region` lines
 * would stay behind as plain comments).
 */
export function withEmptiedBoxes(
  text: string,
  doc: GraphDocument,
  ids: ReadonlyArray<string>,
  result: OpResult
): OpResult {
  if (!result.ok) {
    return result;
  }

  const deleted = new Set(ids);
  const markers: TextEdit[] = [];
  for (const fn of doc.functions) {
    for (const box of fn.comments ?? []) {
      if (box.nodes.length > 0 && box.nodes.every((id) => deleted.has(id))) {
        const removed = deleteCommentBox(text, doc, box.id);
        if (removed.ok) {
          markers.push(...removed.edits);
        }
      }
    }
  }

  // A marker line next to a removed statement: keep the edits apart.
  const edits = [...result.edits];
  for (const marker of markers) {
    if (!edits.some((e) => e.start < marker.end && marker.start < e.end)) {
      edits.push(marker);
    }
  }

  return succeeded(edits);
}

/** Longest run of blank lines between two lines of a text. */
function longestBlankRun(text: string): number {
  let longest = 0;
  for (const run of text.matchAll(/\n((?:[ \t]*\n)+)/g)) {
    longest = Math.max(longest, (run[1] ?? '').split('\n').length - 1);
  }

  return longest;
}

/**
 * Deleting several statements leaves the blank lines that separated them:
 * runs of blank lines longer than any in the file before, and blank lines
 * added at its end, shrink again. One edit from the first to the last change.
 */
export function tidyBlankLines(text: string, result: OpResult): OpResult {
  if (!result.ok || result.edits.length === 0) {
    return result;
  }

  const edited = applyTextEdits(text, result.edits);
  const longest = longestBlankRun(text);
  const ending = text.match(/\n*$/)?.[0] ?? '';
  let tidy = edited.replaceAll(/\n((?:[ \t]*\n)+)/g, (whole, run: string) =>
    run.split('\n').length - 1 > longest ? `\n${'\n'.repeat(longest)}` : whole
  );
  const trailing = tidy.match(/\n*$/)?.[0] ?? '';
  if (trailing.length > ending.length) {
    tidy = tidy.slice(0, tidy.length - trailing.length) + ending;
  }

  // Nor at its start.
  const opening = text.match(/^\n*/)?.[0] ?? '';
  const leading = tidy.match(/^\n*/)?.[0] ?? '';
  if (leading.length > opening.length) {
    tidy = opening + tidy.slice(leading.length);
  }
  if (tidy === edited) {
    return result;
  }

  let start = 0;
  while (
    start < text.length &&
    start < tidy.length &&
    text[start] === tidy[start]
  ) {
    start++;
  }

  let end = 0;
  while (
    end < text.length - start &&
    end < tidy.length - start &&
    text[text.length - 1 - end] === tidy[tidy.length - 1 - end]
  ) {
    end++;
  }

  return succeeded([
    {
      start,
      end: text.length - end,
      text: tidy.slice(start, tidy.length - end),
    },
  ]);
}

export function deleteNodes(
  text: string,
  doc: GraphDocument,
  ids: ReadonlyArray<string>,
  syntax: StatementSyntax
): OpResult {
  const targets: Array<{
    range: SourceRange;
    edit: TextEdit;
    /** Inputs of a deleted value, kept as statements before its statement. */
    keep?: { at: number; indent: string; nodes: GraphNode[] };
  }> = [];
  const deleted = new Set(ids);
  let locked = false;
  for (const id of ids) {
    const node = findNode(doc, id);
    if (!node || node.kind === 'entry') {
      continue;
    }

    const meta = getMeta<StatementMeta>(node);
    if (meta.locked) {
      locked = true;
      continue;
    }

    if (meta.stmt) {
      const kept = keptCalls(doc, node, meta.stmt, deleted);
      if (kept.length > 0 && !(meta.inline && kept.length > 1)) {
        const indent = lineIndent(text, meta.stmt.start);
        targets.push({
          range: meta.stmt,
          edit: {
            start: meta.stmt.start,
            end: meta.stmt.end,
            text: kept
              .map((n) =>
                asStatement(text.slice(n.range.start, n.range.end), syntax)
              )
              .join(`\n${indent}`),
          },
        });
        continue;
      }

      const edit = removeStatement(text, { ...meta, stmt: meta.stmt }, syntax);
      // The comment above a removed statement goes with it.
      const comment = node.comment?.range;
      targets.push({
        range: meta.stmt,
        edit:
          comment && edit.text === '' && comment.end === edit.start
            ? { ...edit, start: comment.start }
            : edit,
      });
      continue;
    }

    // A value node leaves an empty input behind (keeping a property key).
    const input = consumerInput(doc, node);
    const inputs = keptInputs(doc, node, deleted);
    const point = inputs.length > 0 ? keepPoint(text, doc, node) : undefined;
    targets.push({
      range: node.range,
      edit: input
        ? inputEdit(input, node.range, syntax.placeholder)
        : {
            start: node.range.start,
            end: node.range.end,
            text: syntax.placeholder,
          },
      ...(point ? { keep: { ...point, nodes: inputs } } : {}),
    });
  }

  if (targets.length === 0) {
    return failed(
      locked
        ? 'This node is part of a larger statement; delete that statement instead.'
        : 'Nothing to delete (entry nodes cannot be deleted).'
    );
  }

  // Drop targets nested in other targets (e.g. a call inside a deleted statement).
  const sorted = targets.toSorted(
    (a, b) => a.range.start - b.range.start || b.range.end - a.range.end
  );
  const kept: typeof sorted = [];
  for (const target of sorted) {
    if (kept.some((k) => contains(k.range, target.range))) {
      continue;
    }

    kept.push(target);
  }

  return succeeded(
    keepIndentedBlocks(
      text,
      [...kept.map((k) => k.edit), ...keptStatements(text, kept, syntax)],
      syntax
    )
  );
}

/** One insertion per statement for the kept inputs of deleted values. */
function keptStatements(
  text: string,
  targets: ReadonlyArray<{
    keep?: { at: number; indent: string; nodes: GraphNode[] };
  }>,
  syntax: StatementSyntax
): TextEdit[] {
  const byPoint = new Map<number, { indent: string; nodes: GraphNode[] }>();
  for (const { keep } of targets) {
    if (keep) {
      const entry = byPoint.get(keep.at) ?? { indent: keep.indent, nodes: [] };
      entry.nodes.push(...keep.nodes);
      byPoint.set(keep.at, entry);
    }
  }

  return [...byPoint].map(([at, { indent, nodes }]) => ({
    start: at,
    end: at,
    text: nodes
      .toSorted((a, b) => a.range.start - b.range.start)
      .map(
        (n) =>
          `${asStatement(text.slice(n.range.start, n.range.end), syntax)}\n${indent}`
      )
      .join(''),
  }));
}

/** Leading whitespace of the line that starts at `start`. */
function indentAt(text: string, start: number): string {
  return /^[ \t]*/.exec(text.slice(start))?.[0] ?? '';
}

/**
 * An indented block (Python, GDScript) must keep a statement: when the
 * deleted statements are all of a block's code, the first removal leaves
 * the empty body (`pass`) behind. Comments don't count as code.
 */
function keepIndentedBlocks(
  text: string,
  edits: TextEdit[],
  syntax: StatementSyntax
): TextEdit[] {
  if (!/^\w+$/.test(syntax.emptyBody)) {
    return edits;
  }

  const removed = edits.filter((e) => e.text === '');
  const isRemoved = (offset: number): boolean =>
    removed.some((e) => e.start <= offset && offset < e.end);
  const lines: Array<{ start: number; text: string }> = [];
  for (let start = 0; start <= text.length;) {
    const end = text.indexOf('\n', start);
    const stop = end === -1 ? text.length : end;
    lines.push({ start, text: text.slice(start, stop) });
    if (end === -1) {
      break;
    }

    start = end + 1;
  }

  const isCode = (line: string): boolean => {
    const trimmed = line.trim();
    return trimmed !== '' && !trimmed.startsWith(syntax.comment.line);
  };
  const filled = new Set<number>();
  return edits.map((edit) => {
    if (edit.text !== '') {
      return edit;
    }

    const first = lines.findIndex(
      (l) => l.start >= edit.start && isCode(l.text)
    );
    const indent = indentAt(text, lines[first]?.start ?? edit.start).length;
    // The block's header: the code line above with less indentation.
    let header = -1;
    for (let i = first - 1; i >= 0; i--) {
      const line = lines[i];
      if (line && isCode(line.text) && indentAt(line.text, 0).length < indent) {
        header = i;
        break;
      }
    }

    const headerLine = lines[header];
    if (
      first === -1 ||
      !headerLine ||
      !headerLine.text.trimEnd().endsWith(':') ||
      filled.has(header)
    ) {
      return edit;
    }

    const headerIndent = indentAt(headerLine.text, 0).length;
    for (let i = header + 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line || !isCode(line.text)) {
        continue;
      }

      if (indentAt(line.text, 0).length <= headerIndent) {
        break;
      }

      if (!isRemoved(line.start)) {
        return edit;
      }
    }

    filled.add(header);
    const own = lines[first];
    return {
      ...edit,
      text: `${own ? indentAt(own.text, 0) : ''}${syntax.emptyBody}\n`,
    };
  });
}
