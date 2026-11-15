import type { SourceRange } from './ir';
import { failed, succeeded } from './op-result';
import type { GraphOp, OpResult, TextEdit, TypeSystemInfo } from './ops';

/** The value of a function input as a file of its own, see `valueHost`. */
export interface ValueHost {
  text: string;
  /** Where the value starts in `text`. */
  start: number;
}

/**
 * A value that is no node of the graph (a function input's default) in a
 * copy of the file with a declaration of it appended (`const __value__:
 * Item[] = [];`): parsed, it has nodes like a variable's value, and the
 * file's types for new elements.
 */
export function valueHost(
  text: string,
  range: SourceRange,
  typeText: string | undefined,
  types: TypeSystemInfo | null | undefined
): ValueHost | undefined {
  const host = types?.valueHost;
  if (!host) {
    return undefined;
  }

  const code = text.slice(range.start, range.end);
  const template = typeText
    ? host.typed.replace('$type', typeText)
    : host.untyped;
  const at = template.indexOf('$value');
  const head = `${text}${text.endsWith('\n') ? '' : '\n'}\n`;
  return {
    text: `${head}${template.slice(0, at)}${code}${template.slice(at + 6)}\n`,
    start: head.length + at,
  };
}

/**
 * Applies an op to a value that is no node (`inValue`): on its host file,
 * with the edits moved back into the value (none may leave it).
 */
export function applyInValue(
  text: string,
  op: Extract<GraphOp, { type: 'inValue' }>,
  types: TypeSystemInfo,
  apply: (host: string) => OpResult
): OpResult {
  const host = valueHost(text, op.range, op.typeText, types);
  if (!host) {
    return failed('This value cannot be edited here.');
  }

  const result = apply(host.text);
  if (!result.ok) {
    return result;
  }

  const end = host.start + (op.range.end - op.range.start);
  const edits: TextEdit[] = [];
  for (const edit of result.edits) {
    if (edit.start < host.start || edit.end > end) {
      return failed('The change reaches outside the value.');
    }

    const shift = op.range.start - host.start;
    edits.push({ ...edit, start: edit.start + shift, end: edit.end + shift });
  }

  return succeeded(edits);
}
