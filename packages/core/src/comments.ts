import type { StatementMeta } from './edit-meta';
import { getMeta } from './edit-meta';
import type {
  CommentBox,
  FunctionGraph,
  GraphDocument,
  GraphNode,
  SourceRange,
} from './ir';

/** Text of a comment without its markers (`//`, `#`, `/** … *\/`). */
export function commentText(raw: string): { text: string; block: boolean } {
  if (raw.startsWith('/*')) {
    const lines = raw
      .replace(/^\/\*+/, '')
      .replace(/\*+\/$/, '')
      .split('\n')
      .map((line) => line.replace(/^\s*\* ?/, '').trimEnd());
    while (lines.length > 0 && lines[0]?.trim() === '') {
      lines.shift();
    }

    while (lines.length > 0 && lines.at(-1)?.trim() === '') {
      lines.pop();
    }

    return { text: lines.join('\n').replace(/^ /, ''), block: true };
  }

  return { text: raw.replace(/^(?:\/\/+|#+)!? ?/, '').trimEnd(), block: false };
}

const REGION = /^(#?\s*)(end)?region\b/;

/**
 * Region marker in a line comment: `// #region Title`, `#region`, `# region`,
 * `// region: Title`.
 */
export function parseRegionMarker(
  raw: string
): { end: boolean; title: string; titleOffset: number } | undefined {
  const prefix = raw.match(/^(?:\/\/+|#+) ?/)?.[0];
  if (prefix === undefined) {
    return undefined;
  }

  const body = raw.slice(prefix.length);
  const match = body.match(REGION);
  if (!match) {
    return undefined;
  }

  // rust-analyzer writes `// region: Title`.
  const colon = raw.slice(prefix.length + match[0].length).match(/^\s*:/);
  const afterKeyword =
    prefix.length + match[0].length + (colon?.[0].length ?? 0);
  const rest = raw.slice(afterKeyword);
  const title = rest.trim();
  const titleOffset = title
    ? afterKeyword + rest.indexOf(title)
    : raw.trimEnd().length;
  return { end: match[2] !== undefined, title, titleOffset };
}

interface Comment {
  range: SourceRange;
  raw: string;
  startLine: number;
  endLine: number;
  /** Nothing but whitespace around it on its lines. */
  ownLine: boolean;
}

class Lines {
  private readonly starts: number[] = [0];

  public constructor(private readonly text: string) {
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '\n') {
        this.starts.push(i + 1);
      }
    }
  }

  /** 0-based line of an offset. */
  public lineOf(offset: number): number {
    let low = 0;
    let high = this.starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((this.starts[mid] ?? 0) <= offset) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }

    return low;
  }

  public start(line: number): number {
    return this.starts[line] ?? this.text.length;
  }

  /** Start of the next line (after the line break), or the text end. */
  public next(line: number): number {
    return this.starts[line + 1] ?? this.text.length;
  }
}

function isBlank(text: string): boolean {
  return /^[ \t\r]*$/.test(text);
}

/** Statement range of a node, if it is the node of a whole statement. */
function statementOf(node: GraphNode): SourceRange | undefined {
  const meta = getMeta<StatementMeta>(node);
  return meta.locked ? undefined : meta.stmt;
}

/**
 * Attaches source comments to a lowered document: comment lines directly
 * above a statement (or function) become the comment of its node, and
 * regions become comment boxes. `comments` are the ranges of all comments
 * found by the backend's parser.
 */
export function attachComments(
  doc: GraphDocument,
  text: string,
  comments: ReadonlyArray<SourceRange>
): void {
  if (comments.length === 0) {
    return;
  }

  const lines = new Lines(text);
  const parsed: Comment[] = comments
    .toSorted((a, b) => a.start - b.start)
    .map((range) => {
      const startLine = lines.lineOf(range.start);
      const endLine = lines.lineOf(range.end);
      const before = text.slice(lines.start(startLine), range.start);
      const after = text.slice(range.end, lines.next(endLine));
      return {
        range,
        raw: text.slice(range.start, range.end),
        startLine,
        endLine,
        ownLine: isBlank(before) && isBlank(after.replace(/\n$/, '')),
      };
    });

  // Nodes that start a line: the targets of comments above them.
  const targets = new Map<number, GraphNode>();
  const offer = (line: number, node: GraphNode, weight: number): void => {
    const current = targets.get(line);
    const currentWeight = current
      ? current.kind === 'entry'
        ? Number.POSITIVE_INFINITY
        : (statementOf(current)?.end ?? 0) - (statementOf(current)?.start ?? 0)
      : Number.NEGATIVE_INFINITY;
    if (weight > currentWeight) {
      targets.set(line, node);
    }
  };

  for (const fn of doc.functions) {
    for (const node of fn.nodes) {
      if (node.kind === 'entry') {
        offer(lines.lineOf(fn.range.start), node, Number.POSITIVE_INFINITY);
        continue;
      }

      // The largest statement starting on a line (`export const x = …`
      // may start after `export`).
      const stmt = statementOf(node);
      if (stmt) {
        offer(lines.lineOf(stmt.start), node, stmt.end - stmt.start);
      }
    }
  }

  // Comment groups: consecutive comment-only lines above a statement.
  const regions: Array<{ comment: Comment; marker: RegionMarker }> = [];
  let group: Comment[] = [];
  const flush = (): void => {
    const first = group[0];
    const last = group.at(-1);
    const members = group;
    group = [];
    if (!first || !last) {
      return;
    }

    const node = targets.get(last.endLine + 1);
    if (!node || node.comment) {
      return;
    }

    let block = false;
    const texts = members.map((comment) => {
      const result = commentText(comment.raw);
      block ||= result.block;
      return result.text;
    });
    node.comment = {
      text: texts.join('\n'),
      range: {
        start: lines.start(first.startLine),
        end: lines.next(last.endLine),
      },
      ...(block ? { block } : {}),
    };
  };

  for (const comment of parsed) {
    const marker = comment.ownLine ? parseRegionMarker(comment.raw) : undefined;
    const previous = group.at(-1);
    if (
      marker ||
      !comment.ownLine ||
      (previous && previous.endLine + 1 !== comment.startLine)
    ) {
      flush();
    }

    if (marker) {
      regions.push({ comment, marker });
    } else if (comment.ownLine) {
      group.push(comment);
    }
  }

  flush();
  buildBoxes(doc, lines, regions);
}

type RegionMarker = NonNullable<ReturnType<typeof parseRegionMarker>>;

function buildBoxes(
  doc: GraphDocument,
  lines: Lines,
  regions: ReadonlyArray<{ comment: Comment; marker: RegionMarker }>
): void {
  const open: Array<{ comment: Comment; marker: RegionMarker }> = [];
  const counts = new Map<string, number>();
  for (const region of regions) {
    if (!region.marker.end) {
      open.push(region);
      continue;
    }

    const start = open.pop();
    if (!start) {
      continue;
    }

    const range: SourceRange = {
      start: lines.start(start.comment.startLine),
      end: lines.next(region.comment.endLine),
    };
    const inner: SourceRange = {
      start: start.comment.range.end,
      end: region.comment.range.start,
    };
    const titleStart = start.comment.range.start + start.marker.titleOffset;
    for (const fn of doc.functions) {
      // A region around whole functions is already shown by their frames.
      if (fn.range.start >= inner.start && fn.range.end <= inner.end) {
        continue;
      }

      const nodes = fn.nodes
        .filter(
          (n) =>
            n.kind !== 'entry' &&
            n.range.start >= inner.start &&
            n.range.end <= inner.end
        )
        .map((n) => n.id);
      if (nodes.length === 0) {
        continue;
      }

      const key = `${fn.id}#region:${start.marker.title}`;
      const count = counts.get(key) ?? 0;
      counts.set(key, count + 1);
      const box: CommentBox = {
        id: count === 0 ? key : `${key}~${count}`,
        title: start.marker.title,
        range,
        titleRange: {
          start: titleStart,
          end: titleStart + start.marker.title.length,
        },
        markers: [start.comment.range, region.comment.range],
        nodes,
      };
      (fn.comments ??= []).push(box);
    }
  }
}

/** Finds a comment box and its function by id. */
export function findCommentBox(
  doc: GraphDocument,
  id: string
): { box: CommentBox; fn: FunctionGraph } | undefined {
  for (const fn of doc.functions) {
    const box = fn.comments?.find((b) => b.id === id);
    if (box) {
      return { box, fn };
    }
  }

  return undefined;
}
