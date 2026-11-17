import type { GraphNode, PinLiteral, SourceRange } from './ir';
import { failed, succeeded } from './op-result';
import type { OpResult, TypeSystemInfo } from './ops';

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
  /** The expression of each value, without its conversion and spec. */
  exprs: string[];
  /** What follows each expression up to the `}` (`!r`, `:.1f`, ``). */
  specs: string[];
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
  const exprs: string[] = [];
  const specs: string[] = [];
  let at = node.range.start + opener.length;
  for (const part of parts) {
    const start = text.lastIndexOf(open, part.start);
    const close = closingBrace(text, part.end, end);
    if (start < at || close === -1) {
      return undefined;
    }

    chunks.push(text.slice(at, start));
    values.push(text.slice(start + open.length, close));
    exprs.push(text.slice(part.start, part.end));
    specs.push(valueSpec(text.slice(part.end, close)));
    at = close + 1;
  }

  chunks.push(text.slice(at, end));
  return {
    range: node.range,
    opener,
    closer,
    chunks,
    values,
    exprs,
    specs,
  };
}

/**
 * The conversion and spec after a value's expression as the Format shows
 * it (`!r`, `:.1f`, `=`): without the space before it, and none when it
 * holds values itself (`:{width}`), which stay with the expression.
 */
export function valueSpec(after: string): string {
  const spec = after.trimStart();
  if (spec.includes('{')) {
    return '';
  }

  // `{x = }` prints its spaces: Python's self-documenting expression.
  return spec.startsWith('=') ? after : spec;
}

/** The format UE shows: the text with `{0}`, `{1}` … for the values. */
export function templateFormat(layout: TemplateLayout): string {
  return layout.chunks
    .map((chunk, i) => (i < layout.values.length ? `${chunk}{${i}}` : chunk))
    .join('');
}

/**
 * The literal of a Format Text's Format pin (UE): the template's text with
 * `{0}`, `{1}` … for its values, edited on the node like any text.
 */
export function formatLiteral(format: string): PinLiteral {
  return { value: format, raw: format, kind: 'template', editable: true };
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
 * values they name, a new number gets an empty text, values the format
 * leaves out are dropped (UE: Format Text makes its pins from the format).
 * With `templateSpecs` (Python) a number takes its conversion and spec from
 * the format: `{1:.1f}` writes `{price:.1f}`.
 */
export function setFormat(
  text: string,
  node: GraphNode | undefined,
  format: string,
  types: TypeSystemInfo | undefined
): OpResult {
  const open = types?.templateOpen;
  const layout = node && open ? templateLayout(text, node, open) : undefined;
  if (!layout || !open) {
    return failed('The format of this text cannot be changed here.');
  }

  if (format.includes('\n') && layout.closer.length === 1) {
    return failed('Enter the format on one line.');
  }

  // A text in the other quotes, so it doesn't end the template.
  const empty = layout.closer.includes("'") ? '""' : "''";
  const specs = types?.templateSpecs === true;
  const slot = specs ? /\{(\d+)([!:=][^{}]*)?\}/g : /\{(\d+)\}/g;
  let code = layout.opener;
  let last = 0;
  for (const match of format.matchAll(slot)) {
    const index = Number(match[1]);
    const expr = specs ? layout.exprs[index] : layout.values[index];
    // A spec that holds values (`:{width}`) isn't shown: it stays.
    const kept =
      specs && layout.specs[index] === '' ? hiddenSpec(layout, index) : '';
    code += escapeChunk(format.slice(last, match.index), layout.closer, open);
    code += `${open}${expr === undefined ? empty : `${expr}${match[2] ?? kept}`}}`;
    last = match.index + match[0].length;
  }

  code += escapeChunk(format.slice(last), layout.closer, open) + layout.closer;
  return succeeded([
    { start: layout.range.start, end: layout.range.end, text: code },
  ]);
}

/** A spec the Format doesn't show (`:{width}`), kept as written. */
function hiddenSpec(layout: TemplateLayout, index: number): string {
  const value = layout.values[index] ?? '';
  const expr = layout.exprs[index] ?? '';
  const at = value.indexOf(expr);
  const after = at === -1 ? '' : value.slice(at + expr.length);
  return after.includes('{') ? after : '';
}
