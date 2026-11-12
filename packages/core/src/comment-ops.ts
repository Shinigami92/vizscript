import { findCommentBox } from './comments';
import type { StatementMeta } from './edit-meta';
import { getMeta, owningStatement } from './edit-meta';
import type { FunctionGraph, GraphDocument, SourceRange } from './ir';
import type { OpResult, TextEdit } from './ops';
import { lineAwareRange, lineIndent, lineStart } from './text-utils';

/** How a language writes comments. */
export interface CommentSyntax {
  /** Line comment marker (`//`, `#`). */
  line: string;
  /** Start marker of a region (`// #region Title`). */
  region: (title: string) => string;
  /** End marker of a region (`// #endregion`). */
  endRegion: string;
}

function failed(error: string): OpResult {
  return { ok: false, error };
}

function functionOfNode(
  doc: GraphDocument,
  nodeId: string
): FunctionGraph | undefined {
  return doc.functions.find((fn) => fn.nodes.some((n) => n.id === nodeId));
}

function endOfLine(text: string, offset: number): number {
  const index = text.indexOf('\n', offset);
  if (index === -1) {
    return text.length;
  }

  return text[index - 1] === '\r' ? index - 1 : index;
}

function onlyWhitespaceBefore(text: string, offset: number): boolean {
  return /^[ \t]*$/.test(text.slice(lineStart(text, offset), offset));
}

/** Comment lines for `value` at `indent`, ending with a line break. */
function formatComment(
  value: string,
  indent: string,
  block: boolean,
  syntax: CommentSyntax
): string {
  const lines = value.replaceAll('\r', '').split('\n');
  if (block) {
    const body = lines
      .map((line) => `${indent} *${line ? ` ${line}` : ''}`)
      .join('\n');
    return `${indent}/**\n${body}\n${indent} */\n`;
  }

  return lines
    .map((line) => `${indent}${syntax.line}${line ? ` ${line}` : ''}\n`)
    .join('');
}

/** Sets, replaces or (with an empty text) removes the comment of a node. */
export function setComment(
  text: string,
  doc: GraphDocument,
  nodeId: string,
  value: string,
  syntax: CommentSyntax
): OpResult {
  const fn = functionOfNode(doc, nodeId);
  const node = fn?.nodes.find((n) => n.id === nodeId);
  if (!fn || !node) {
    return failed('Unknown node.');
  }

  const trimmed = value.replace(/\s+$/, '');
  if (node.comment) {
    const replacement = trimmed
      ? formatComment(
          trimmed,
          lineIndent(text, node.comment.range.start),
          node.comment.block === true,
          syntax
        )
      : '';
    return {
      ok: true,
      edits: [
        {
          start: node.comment.range.start,
          end: node.comment.range.end,
          text: replacement,
        },
      ],
    };
  }

  if (!trimmed) {
    return { ok: true, edits: [] };
  }

  let anchor: number;
  if (node.kind === 'entry') {
    anchor = fn.range.start;
  } else {
    const owner = owningStatement(node);
    if (!owner || owner.meta.locked) {
      return failed('Comments can only be added to statements.');
    }

    anchor = owner.stmt.start;
  }

  if (!onlyWhitespaceBefore(text, anchor)) {
    return failed(
      'This code shares its line with other code; it cannot get its own comment.'
    );
  }

  const start = lineStart(text, anchor);
  return {
    ok: true,
    edits: [
      {
        start,
        end: start,
        text: formatComment(trimmed, lineIndent(text, anchor), false, syntax),
      },
    ],
  };
}

/** Statement ranges of a function that are whole statements. */
function statementsOf(fn: FunctionGraph): SourceRange[] {
  const result: SourceRange[] = [];
  for (const node of fn.nodes) {
    const meta = getMeta<StatementMeta>(node);
    if (meta.stmt && !meta.locked && !meta.inline) {
      result.push(meta.stmt);
    }
  }

  return result;
}

/** Wraps the statements of `nodeIds` in a region titled `title`. */
export function addCommentBox(
  text: string,
  doc: GraphDocument,
  nodeIds: ReadonlyArray<string>,
  title: string,
  syntax: CommentSyntax
): OpResult {
  const fn = nodeIds
    .map((id) => functionOfNode(doc, id))
    .find((f) => f !== undefined);
  if (!fn) {
    return failed('Select the nodes to comment first.');
  }

  const statements = statementsOf(fn);
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const id of nodeIds) {
    const node = fn.nodes.find((n) => n.id === id);
    if (!node || node.kind === 'entry') {
      continue;
    }

    const owner = owningStatement(node);
    if (!owner) {
      continue;
    }

    // Parts of larger statements (`elif`) take the whole statement.
    const stmt = owner.meta.locked
      ? statements
          .filter((s) => s.start <= owner.stmt.start && owner.stmt.end <= s.end)
          .toSorted((a, b) => a.end - a.start - (b.end - b.start))[0]
      : owner.stmt;
    if (stmt) {
      start = Math.min(start, stmt.start);
      end = Math.max(end, stmt.end);
    }
  }

  if (!Number.isFinite(start)) {
    return failed('Select statements (or values used by them) to comment.');
  }

  // Grow until no statement is cut in half and all statements are in one
  // block (nodes of two branches take the whole `if`).
  let indent = '';
  let from = 0;
  let to = 0;
  for (;;) {
    for (let changed = true; changed;) {
      changed = false;
      for (const s of statements) {
        const overlaps = s.start < end && start < s.end;
        const inside = start <= s.start && s.end <= end;
        const around = s.start <= start && end <= s.end;
        if (overlaps && !inside && !around) {
          start = Math.min(start, s.start);
          end = Math.max(end, s.end);
          changed = true;
        }
      }
    }

    indent = lineIndent(text, start);
    from = lineStart(text, start);
    to = endOfLine(text, end);
    const oneBlock =
      onlyWhitespaceBefore(text, start) &&
      text
        .slice(from, to)
        .split('\n')
        .every((line) => line.trim() === '' || line.startsWith(indent));
    if (oneBlock) {
      break;
    }

    const outer = statements
      .filter(
        (s) =>
          s.start <= start && end <= s.end && (s.start < start || end < s.end)
      )
      .toSorted((a, b) => a.end - a.start - (b.end - b.start))[0];
    if (!outer) {
      return failed('A comment box can only hold statements of one block.');
    }

    start = outer.start;
    end = outer.end;
  }

  // Keep the comment of the first statement inside the box.
  const commented = fn.nodes.find((n) => n.comment?.range.end === from);
  const regionStart = commented?.comment ? commented.comment.range.start : from;
  const edits: TextEdit[] = [
    {
      start: regionStart,
      end: regionStart,
      text: `${indent}${syntax.region(title.trim())}\n`,
    },
    { start: to, end: to, text: `\n${indent}${syntax.endRegion}` },
  ];
  return { ok: true, edits };
}

export function renameCommentBox(
  doc: GraphDocument,
  boxId: string,
  title: string
): OpResult {
  const found = findCommentBox(doc, boxId);
  if (!found) {
    return failed('Unknown comment box.');
  }

  const { titleRange } = found.box;
  const value = title.trim();
  const empty = titleRange.start === titleRange.end;
  return {
    ok: true,
    edits: [
      {
        start: titleRange.start,
        end: titleRange.end,
        text: empty && value ? ` ${value}` : value,
      },
    ],
  };
}

export function deleteCommentBox(
  text: string,
  doc: GraphDocument,
  boxId: string
): OpResult {
  const found = findCommentBox(doc, boxId);
  if (!found) {
    return failed('Unknown comment box.');
  }

  return {
    ok: true,
    edits: found.box.markers.map((marker): TextEdit => {
      const [start, end] = lineAwareRange(text, marker.start, marker.end);
      return { start, end, text: '' };
    }),
  };
}
