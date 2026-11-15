import type { OpResult, TextEdit } from './ops';

export function failed(error: string): OpResult {
  return { ok: false, error };
}

export function succeeded(edits: TextEdit[]): OpResult {
  return { ok: true, edits };
}

/**
 * Edits of several ops on the same text as one: identical edits once (two
 * wires may need the same new variable), overlapping ones fail.
 */
export function mergeEdits(
  results: ReadonlyArray<OpResult>,
  overlap = 'These changes overlap.'
): OpResult {
  const edits = new Map<string, TextEdit>();
  for (const result of results) {
    if (!result.ok) {
      return result;
    }

    for (const edit of result.edits) {
      edits.set(`${edit.start}:${edit.end}:${edit.text}`, edit);
    }
  }

  const sorted = [...edits.values()].toSorted(
    (a, b) => a.start - b.start || a.end - b.end
  );
  for (const [i, edit] of sorted.entries()) {
    const next = sorted[i + 1];
    if (next && next.start < edit.end) {
      return failed(overlap);
    }
  }

  return succeeded(sorted);
}
