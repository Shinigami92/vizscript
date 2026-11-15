import type { GraphNode, SourceRange } from './ir';
import { failed, succeeded } from './op-result';
import type { OpResult } from './ops';

/**
 * A text template (`` `Total: ${n} EUR` ``, `f"Total: {n} EUR"`) as UE's
 * Format Text: its text parts and the code of each value.
 */
export interface TemplateLayout {
  range: SourceRange;
  /** `` ` ``, `f"`, `rf'''` … */
  opener: string;
  closer: string;
  /** Text around the values, raw as in the code (one more than `values`). */
  chunks: string[];
  /** Code between the value's delimiters (with `!r`, `:>10` in Python). */
  values: string[];
}

/** Index of the `}` that closes a value starting at `from` (nested braces). */
function closingBrace(text: string, from: number, end: number): number {
  let depth = 0;
  for (let i = from; i < end; i++) {
    const char = text[i];
    if (char === '{') {
      depth++;
    } else if (char === '}') {
      if (depth === 0) {
        return i;
      }

      depth--;
    }
  }

  return -1;
}

/**
 * The layout of a Format Text node, with `open` the language's opener of a
 * value (`${`, `{`); undefined when the code doesn't have that shape.
 */
export function templateLayout(
  text: string,
  node: GraphNode,
  open: string
): TemplateLayout | undefined {
  if (node.kind !== 'template') {
    return undefined;
  }

  const raw = text.slice(node.range.start, node.range.end);
  const quote = raw.match(/^[A-Za-z]*("""|'''|"|'|`)/);
  if (!quote?.[1] || !raw.endsWith(quote[1])) {
    return undefined;
  }

  const opener = quote[0];
  const closer = quote[1];
  const end = node.range.end - closer.length;
  const parts = node.pins
    .filter((p) => p.direction === 'in' && p.kind === 'data')
    .flatMap((p) => (p.range ? [p.range] : []))
    .toSorted((a, b) => a.start - b.start);
  const chunks: string[] = [];
  const values: string[] = [];
  let at = node.range.start + opener.length;
  for (const part of parts) {
    const start = text.lastIndexOf(open, part.start);
    const close = closingBrace(text, part.end, end);
    if (start < at || close === -1) {
      return undefined;
    }

    chunks.push(text.slice(at, start));
    values.push(text.slice(start + open.length, close));
    at = close + 1;
  }

  chunks.push(text.slice(at, end));
  return { range: node.range, opener, closer, chunks, values };
}

/** The format UE shows: the text with `{0}`, `{1}` … for the values. */
export function templateFormat(layout: TemplateLayout): string {
  return layout.chunks
    .map((chunk, i) => (i < layout.values.length ? `${chunk}{${i}}` : chunk))
    .join('');
}

/** Backslashes for the quote that ends the text and, in templates, `${`. */
function escapeChunk(chunk: string, closer: string, open: string): string {
  let out = '';
  for (let i = 0; i < chunk.length; i++) {
    const escaped = i > 0 && chunk[i - 1] === '\\';
    if (!escaped && chunk.startsWith(closer, i)) {
      out += `\\${closer[0]}`;
      out += closer.slice(1);
      i += closer.length - 1;
    } else if (!escaped && open === '${' && chunk.startsWith('${', i)) {
      out += '\\${';
      i += 1;
    } else {
      out += chunk[i];
    }
  }

  return out;
}

/**
 * Writes a new format into a Format Text node: `{0}`, `{1}` … keep the
 * values they name, a new number gets `placeholder`, values the format
 * leaves out are dropped (UE: Format Text makes its pins from the format).
 */
export function setFormat(
  text: string,
  node: GraphNode | undefined,
  format: string,
  open: string | undefined,
  placeholder: string
): OpResult {
  const layout = node && open ? templateLayout(text, node, open) : undefined;
  if (!layout || !open) {
    return failed('The format of this text cannot be changed here.');
  }

  if (format.includes('\n') && layout.closer.length === 1) {
    return failed('Enter the format on one line.');
  }

  let code = layout.opener;
  let last = 0;
  for (const match of format.matchAll(/\{(\d+)\}/g)) {
    const index = Number(match[1]);
    code += escapeChunk(format.slice(last, match.index), layout.closer, open);
    code += `${open}${layout.values[index] ?? placeholder}}`;
    last = match.index + match[0].length;
  }

  code += escapeChunk(format.slice(last), layout.closer, open) + layout.closer;
  return succeeded([
    { start: layout.range.start, end: layout.range.end, text: code },
  ]);
}
