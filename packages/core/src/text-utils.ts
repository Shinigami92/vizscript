/** Returns the offset of the start of the line containing `offset`. */
export function lineStart(text: string, offset: number): number {
  return text.lastIndexOf('\n', offset - 1) + 1;
}

/** Leading whitespace of the line containing `offset`. */
export function lineIndent(text: string, offset: number): string {
  const start = lineStart(text, offset);
  let end = start;
  while (end < text.length && (text[end] === ' ' || text[end] === '\t')) {
    end++;
  }

  return text.slice(start, end);
}

/**
 * Expands `[start, end)` to whole lines when the range is the only content
 * on those lines, so deleting it does not leave empty lines behind.
 */
export function lineAwareRange(
  text: string,
  start: number,
  end: number
): [number, number] {
  let s = start;
  while (s > 0 && (text[s - 1] === ' ' || text[s - 1] === '\t')) {
    s--;
  }

  let e = end;
  while (e < text.length && (text[e] === ' ' || text[e] === '\t')) {
    e++;
  }

  const atLineStart = s === 0 || text[s - 1] === '\n';
  const atLineEnd = e === text.length || text[e] === '\n' || text[e] === '\r';
  if (!atLineStart || !atLineEnd) {
    return [start, end];
  }

  if (text[e] === '\r') {
    e++;
  }

  if (text[e] === '\n') {
    e++;
  } else if (s > 0) {
    // Last line without trailing newline: eat the preceding newline instead.
    s--;
    if (text[s - 1] === '\r') {
      s--;
    }
  }

  return [s, e];
}

/** Re-indents all lines but the first from `fromIndent` to `toIndent`. */
export function reindent(
  snippet: string,
  fromIndent: string,
  toIndent: string
): string {
  return snippet
    .split('\n')
    .map((line, index) => {
      if (index === 0) {
        return line;
      }

      return line.startsWith(fromIndent)
        ? toIndent + line.slice(fromIndent.length)
        : line;
    })
    .join('\n');
}

export function truncate(text: string, max = 40): string {
  const singleLine = text.replaceAll(/\s+/g, ' ').trim();
  return singleLine.length > max
    ? `${singleLine.slice(0, max - 1)}…`
    : singleLine;
}
