/**
 * Changed lines of a text against its saved version, for the editor's
 * gutter like VS Code's: added and modified lines of the new text, and the
 * places where lines were deleted.
 */
export interface LineChange {
  kind: 'added' | 'modified' | 'deleted';
  /** First line (1-based) of the new text; for `deleted` the line above. */
  start: number;
  /** Last line (inclusive); equals `start` for `deleted`. */
  end: number;
}

/** Longest common subsequences beyond this many cells are guessed. */
const MAX_CELLS = 4_000_000;

/**
 * Pairs of equal lines (index in `a`, index in `b`), in order: a longest
 * common subsequence of the lines.
 */
function commonLines(
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string>
): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0 || n * m > MAX_CELLS) {
    return [];
  }

  // lengths[i][j]: common lines of a[i..] and b[j..].
  const width = m + 1;
  const lengths = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lengths[i * width + j] =
        a[i] === b[j]
          ? (lengths[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(
              lengths[(i + 1) * width + j] ?? 0,
              lengths[i * width + j + 1] ?? 0
            );
    }
  }

  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (
      (lengths[(i + 1) * width + j] ?? 0) >= (lengths[i * width + j + 1] ?? 0)
    ) {
      i++;
    } else {
      j++;
    }
  }

  return pairs;
}

export function lineChanges(base: string, text: string): LineChange[] {
  if (base === text) {
    return [];
  }

  const a = base.split('\n');
  const b = text.split('\n');
  // Equal lines at both ends need no comparison.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) {
    head++;
  }

  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }

  const middleA = a.slice(head, a.length - tail);
  const middleB = b.slice(head, b.length - tail);
  const pairs = [
    ...commonLines(middleA, middleB),
    [middleA.length, middleB.length] as [number, number],
  ];

  const changes: LineChange[] = [];
  let lastA = 0;
  let lastB = 0;
  for (const [i, j] of pairs) {
    const removed = i - lastA;
    const added = j - lastB;
    // Lines of the new text: 1-based, after the equal head.
    const first = head + lastB + 1;
    if (added > 0) {
      changes.push({
        kind: removed > 0 ? 'modified' : 'added',
        start: first,
        end: first + added - 1,
      });
    } else if (removed > 0) {
      const above = Math.max(first - 1, 1);
      changes.push({ kind: 'deleted', start: above, end: above });
    }

    lastA = i + 1;
    lastB = j + 1;
  }

  return changes;
}
