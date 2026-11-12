import type { SourceRange } from '@vizscript/core';

/** 1-based line and column of an offset. */
export function lineColumn(
  text: string,
  offset: number
): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  const end = Math.min(offset, text.length);
  for (let i = 0; i < end; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }

  return { line, column: end - lineStart + 1 };
}

/** Source text of a range, dedented and cut to `maxLines`. */
export function snippet(
  text: string,
  range: SourceRange,
  maxLines = 8
): string {
  const lineStart = text.lastIndexOf('\n', range.start - 1) + 1;
  const lead = text.slice(lineStart, range.start);
  const raw =
    (/^\s*$/.test(lead) ? lead : '') + text.slice(range.start, range.end);
  const lines = raw.split('\n');
  const indent = Math.min(
    ...lines
      .filter((l) => l.trim().length > 0)
      .map((l) => l.length - l.trimStart().length)
  );
  const dedented = lines.map((l) =>
    Number.isFinite(indent) ? l.slice(indent) : l
  );
  if (dedented.length > maxLines) {
    return [...dedented.slice(0, maxLines), '…'].join('\n');
  }

  return dedented.join('\n');
}

/** Whether shortcuts use ⌘ / ⌥ / ⇧ (macOS, iOS) instead of Ctrl / Alt. */
export const isMac =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad/.test(navigator.platform);

/** Shortcut label like `⌘Z` on macOS and `Ctrl+Z` elsewhere. */
export function shortcut(key: string, shift = false): string {
  if (isMac) {
    return `${shift ? '⇧' : ''}⌘${key}`;
  }

  return `Ctrl+${shift ? 'Shift+' : ''}${key}`;
}

/** Fast offset → 1-based line lookup for many queries on the same text. */
export function lineLookup(text: string): (offset: number) => number {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      starts.push(i + 1);
    }
  }

  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] ?? 0) <= offset) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }

    return lo + 1;
  };
}
