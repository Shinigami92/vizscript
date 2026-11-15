import type { StatementMeta } from './edit-meta';
import { getMeta } from './edit-meta';
import type {
  FunctionGraph,
  GraphDocument,
  GraphNode,
  PinRef,
  SourceRange,
} from './ir';

/**
 * Nodes an edit took out of the code, as the code of loose graph-only
 * groups (UE keeps them, unconnected): one group per part wired together.
 * Inputs fed from outside the group are written as the placeholder; those
 * fed by a node still in the code get a graph-only wire back (`feeds`).
 */
export interface LooseCode {
  fnId: string;
  /** Statements (a block's body) rather than a value. */
  statement: boolean;
  code: string;
  /** The nodes it stands for, in code order. */
  nodes: string[];
  /**
   * Every placeholder value of the code, in code order: the output of the
   * code's node that feeds it, or `null` (it was empty, or its source was
   * deleted).
   */
  feeds: Array<PinRef | null>;
}

function contains(outer: SourceRange, inner: SourceRange): boolean {
  return outer.start <= inner.start && inner.end <= outer.end;
}

/** Lines moved left by the indentation of the first one. */
function dedent(text: string, code: string, start: number): string {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const before = text.slice(lineStart, start);
  const indent = before.slice(0, before.length - before.trimStart().length);
  return code
    .split('\n')
    .map((line, i) =>
      i > 0 && line.startsWith(indent) ? line.slice(indent.length) : line
    )
    .join('\n');
}

/** The parts of `lost` wired together (exec or data), per function. */
function components(
  fn: FunctionGraph,
  lost: ReadonlySet<string>
): GraphNode[][] {
  const nodes = fn.nodes.filter((n) => lost.has(n.id));
  const parent = new Map(nodes.map((n) => [n.id, n.id]));
  const root = (id: string): string => {
    let at = id;
    for (let up = parent.get(at); up !== undefined && up !== at;) {
      at = up;
      up = parent.get(at);
    }

    return at;
  };
  for (const edge of fn.edges) {
    if (parent.has(edge.from.node) && parent.has(edge.to.node)) {
      parent.set(root(edge.from.node), root(edge.to.node));
    }
  }

  const groups = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const key = root(node.id);
    groups.set(key, [...(groups.get(key) ?? []), node]);
  }

  return [...groups.values()];
}

export function looseCode(
  text: string,
  doc: GraphDocument,
  /** Nodes the edit took out of the code that the user didn't delete. */
  lost: ReadonlySet<string>,
  /** Nodes the user deleted: what they fed stays empty. */
  deleted: ReadonlySet<string>,
  placeholder: string
): LooseCode[] {
  const result: LooseCode[] = [];
  // Statements kept loose: a callback inside one goes with its code.
  const kept = doc.functions.flatMap((fn) =>
    fn.nodes
      .filter((n) => lost.has(n.id))
      .flatMap((n) => {
        const stmt = getMeta<StatementMeta>(n).stmt;
        return stmt ? [{ fn: fn.id, stmt }] : [];
      })
  );
  for (const fn of doc.functions) {
    if (kept.some((k) => k.fn !== fn.id && contains(k.stmt, fn.range))) {
      continue;
    }

    for (const group of components(fn, lost)) {
      const ids = new Set(group.map((n) => n.id));
      // Statements: their own code, outermost first; else the value.
      // A lone value (`a + b;`) is a value, not a statement.
      const statements = group
        .map((n) => getMeta<StatementMeta>(n))
        .flatMap((m) => (m.stmt && !m.unused ? [m.stmt] : []));
      const outer = statements.filter(
        (r) =>
          !statements.some(
            (o) =>
              o !== r &&
              contains(o, r) &&
              (o.start !== r.start || o.end !== r.end)
          )
      );
      const root = group.find(
        (n) => !fn.edges.some((e) => e.from.node === n.id && ids.has(e.to.node))
      );
      const ranges =
        outer.length > 0
          ? [...new Map(outer.map((r) => [`${r.start}:${r.end}`, r])).values()]
          : root
            ? [root.range]
            : [];
      if (ranges.length === 0) {
        continue;
      }

      // Inputs fed from outside the group: the placeholder.
      const replaced: Array<{ range: SourceRange; from?: PinRef }> = [];
      const inCode = (range: SourceRange | undefined): boolean =>
        range !== undefined && ranges.some((r) => contains(r, range));
      // Placeholders the code has already (empty inputs).
      const empty = group.flatMap((n) =>
        n.pins.filter(
          (p) =>
            p.direction === 'in' &&
            p.literal?.raw === placeholder &&
            inCode(p.range) &&
            !fn.edges.some((e) => e.to.node === n.id && e.to.pin === p.id)
        )
      );
      for (const edge of fn.edges) {
        const to = ids.has(edge.to.node)
          ? group.find((n) => n.id === edge.to.node)
          : undefined;
        const pin = to?.pins.find((p) => p.id === edge.to.pin);
        if (
          edge.kind !== 'data' ||
          ids.has(edge.from.node) ||
          !pin?.range ||
          !ranges.some((r) => pin.range && contains(r, pin.range))
        ) {
          continue;
        }

        replaced.push({
          range: pin.range,
          ...(deleted.has(edge.from.node) ? {} : { from: edge.from }),
        });
      }

      const codeOf = (range: SourceRange): string => {
        let code = text.slice(range.start, range.end);
        for (const r of replaced
          .filter((x) => contains(range, x.range))
          .toSorted((a, b) => b.range.start - a.range.start)) {
          code = `${code.slice(0, r.range.start - range.start)}${placeholder}${code.slice(r.range.end - range.start)}`;
        }

        return dedent(text, code, range.start);
      };
      result.push({
        fnId: fn.id,
        statement: outer.length > 0,
        code: ranges
          .toSorted((a, b) => a.start - b.start)
          .map(codeOf)
          .join('\n'),
        nodes: group
          .toSorted((a, b) => a.range.start - b.range.start)
          .map((n) => n.id),
        feeds: [
          ...replaced,
          ...empty.map((p): { range: SourceRange; from?: PinRef } => ({
            range: p.range ?? { start: 0, end: 0 },
          })),
        ]
          .toSorted((a, b) => a.range.start - b.range.start)
          .map((r) => r.from ?? null),
      });
    }
  }

  return result;
}
