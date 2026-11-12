import type { GraphDocument, SourceRange } from '@vizscript/core';
import { findNodeAtOffset } from '@vizscript/core';

export type ProblemSeverity = 'error' | 'warning' | 'info';

/** A problem in the open file (from the parser or the code editor). */
export interface Problem {
  message: string;
  severity: ProblemSeverity;
  range: SourceRange;
  /** 1-based position of the start. */
  line: number;
  column: number;
  /** Who reported it, e.g. `ts` or `vizscript`. */
  source?: string;
  code?: string;
}

export const SEVERITY_ORDER: Record<ProblemSeverity, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

/**
 * The node each problem belongs to: the smallest node at its start, or the
 * entry of the function it is in (e.g. a wrong parameter type).
 */
export function problemsByNode(
  doc: GraphDocument | null,
  problems: ReadonlyArray<Problem>
): Map<string, Problem[]> {
  const result = new Map<string, Problem[]>();
  if (!doc) {
    return result;
  }

  for (const problem of problems) {
    const offset = problem.range.start;
    let nodeId = findNodeAtOffset(doc, offset)?.id;
    if (!nodeId) {
      const fn = doc.functions
        .filter((f) => f.range.start <= offset && offset <= f.range.end)
        .toSorted(
          (a, b) => a.range.end - a.range.start - (b.range.end - b.range.start)
        )[0];
      nodeId = fn?.nodes.find((n) => n.kind === 'entry')?.id;
    }

    if (nodeId) {
      const list = result.get(nodeId) ?? [];
      list.push(problem);
      result.set(nodeId, list);
    }
  }

  return result;
}

/** Highest severity of a list of problems. */
export function worstSeverity(
  problems: ReadonlyArray<Problem>
): ProblemSeverity | undefined {
  return problems.toSorted(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
  )[0]?.severity;
}
