import { blankElement } from './array-ops';
import type { InputPinMeta } from './edit-meta';
import { getMeta } from './edit-meta';
import type { GraphDocument, GraphNode, Pin, SourceRange } from './ir';
import { failed, succeeded } from './op-result';
import {
  arrayElements,
  chainValues,
  MAX_CHAIN_PINS,
  objectEntries,
} from './operator-chain';
import type { OpResult } from './ops';
import { removeListItem } from './symbol-edits';
import { detectIndentUnit } from './text-op-helpers';
import type { StatementSyntax } from './text-ops';
import { lineIndent } from './text-utils';
import { arrayElementType } from './types';

/** A value with the parentheses around it: `(b)` of `a + (b)`. */
export function operandSpan(text: string, range: SourceRange): SourceRange {
  let { start, end } = range;
  for (;;) {
    let before = start;
    while (before > 0 && /\s/.test(text[before - 1] ?? '')) {
      before--;
    }

    let after = end;
    while (after < text.length && /\s/.test(text[after] ?? '')) {
      after++;
    }

    if (text[before - 1] !== '(' || text[after] !== ')') {
      return { start, end };
    }

    start = before - 1;
    end = after + 1;
  }
}

/** The value a new pin of a chain starts with: one that changes nothing. */
function neutralValue(
  text: string,
  node: GraphNode,
  values: ReadonlyArray<Pin>,
  syntax: StatementSyntax
): string {
  const op = node.title;
  const type = node.pins.find(
    (p) => p.direction === 'out' && p.kind === 'data'
  )?.type;
  if (type === 'string' && op === '+') {
    const literal = values.find((p) => p.literal?.kind === 'string')?.literal;
    return syntax.quote(
      '',
      literal ?? { value: '', raw: '', kind: 'string', editable: true }
    );
  }

  if (type === 'bool') {
    const booleans = syntax.booleans ?? { true: 'true', false: 'false' };
    if (op === '&&' || op === 'and') {
      return booleans.true;
    }

    if (op === '||' || op === 'or') {
      return booleans.false;
    }
  }

  const value = ['*', '/', '//'].includes(op)
    ? '1'
    : ['+', '-', '|', '^'].includes(op)
      ? '0'
      : undefined;
  const last = values.at(-1)?.range;
  if (type === 'number' && value && last) {
    const previous = text.slice(last.start, last.end);
    return syntax.number?.(value, previous) ?? value;
  }

  return syntax.placeholder;
}

/** UE's "Add pin +" on a math node: `a + b` → `a + b + 0`. */
function addChainValue(
  text: string,
  node: GraphNode,
  values: ReadonlyArray<Pin>,
  syntax: StatementSyntax
): OpResult {
  const last = values.at(-1)?.range;
  if (!last || values.length >= MAX_CHAIN_PINS) {
    return failed(`An operator takes at most ${MAX_CHAIN_PINS} values.`);
  }

  const at = operandSpan(text, last).end;
  const value = neutralValue(text, node, values, syntax);
  return succeeded([{ start: at, end: at, text: ` ${node.title} ${value}` }]);
}

/** Removes a value of an operator chain with its operator. */
function removeChainValue(
  text: string,
  values: ReadonlyArray<Pin>,
  pinId: string
): OpResult {
  const at = values.findIndex((p) => p.id === pinId);
  const range = values[at]?.range;
  if (!range) {
    return failed('Only values written in the operator can be removed.');
  }

  if (values.length <= 2) {
    return failed('An operator needs two values.');
  }

  const span = operandSpan(text, range);
  // The first value goes with the operator after it, others with the one
  // before them.
  const next = at === 0 ? values[1]?.range : undefined;
  const previous = at > 0 ? values[at - 1]?.range : undefined;
  const start = previous ? operandSpan(text, previous).end : span.start;
  const end = next ? operandSpan(text, next).start : span.end;
  return succeeded([{ start, end, text: '' }]);
}

/** The type's own empty value: `0`, `''`, `false`, else the placeholder. */
export function emptyValue(
  text: string,
  type: string,
  values: ReadonlyArray<Pin>,
  syntax: StatementSyntax
): string {
  if (type === 'string') {
    const literal = values.find((p) => p.literal?.kind === 'string')?.literal;
    return syntax.quote(
      '',
      literal ?? { value: '', raw: '', kind: 'string', editable: true }
    );
  }

  if (type === 'bool') {
    return (syntax.booleans ?? { true: 'true', false: 'false' }).false;
  }

  const last = values.at(-1)?.range;
  if (type === 'number') {
    const previous = last ? text.slice(last.start, last.end) : '';
    return syntax.number?.('0', previous) ?? '0';
  }

  return syntax.placeholder;
}

/**
 * Appends an item to a bracketed list (`[a, b]`, `{ a: 1 }`) after its
 * last one, on its own line when the items are; an empty list (`[]`)
 * gets it between the brackets.
 */
/** Line length the formatter keeps code within. */
const PRINT_WIDTH = 80;

function appendItem(
  text: string,
  node: GraphNode,
  items: ReadonlyArray<SourceRange>,
  item: string,
  close: string,
  padded = false
): OpResult {
  const first = items[0];
  const last = items.at(-1);
  if (first && last) {
    const end = operandSpan(text, last).end;
    // One item per line: the new one gets its own, like the others.
    if (text.slice(node.range.start, first.start).includes('\n')) {
      const indent = lineIndent(text, last.start);
      const trailing = text.slice(end).match(/^[ \t]*,/)?.[0];
      return succeeded([
        trailing
          ? {
              start: end + trailing.length,
              end: end + trailing.length,
              text: `\n${indent}${item},`,
            }
          : { start: end, end, text: `,\n${indent}${item}` },
      ]);
    }

    // An array grown past the print width: one element per line.
    const lineFrom = text.lastIndexOf('\n', node.range.start - 1) + 1;
    const lineTo = text.indexOf('\n', end);
    const width =
      (lineTo === -1 ? text.length : lineTo) - lineFrom + item.length + 2;
    // From its bracket (Rust's `vec![…]`).
    const open = text.indexOf('[', node.range.start);
    const own = text.slice(open, node.range.end);
    if (
      close === ']' &&
      width > PRINT_WIDTH &&
      open !== -1 &&
      open < first.start &&
      own.endsWith(']') &&
      !own.includes('\n')
    ) {
      const indent = lineIndent(text, node.range.start);
      const inner = `${indent}${detectIndentUnit(text)}`;
      const values = [
        ...items.map((r) => {
          const span = operandSpan(text, r);
          return text.slice(span.start, span.end);
        }),
        item,
      ];
      return succeeded([
        {
          start: open,
          end: node.range.end,
          text: `[\n${values.map((v) => `${inner}${v},`).join('\n')}\n${indent}]`,
        },
      ]);
    }

    return succeeded([{ start: end, end, text: `, ${item}` }]);
  }

  const at = node.range.end - 1;
  let open = at - 1;
  while (open > node.range.start && /\s/.test(text[open] ?? '')) {
    open--;
  }

  if (text[at] !== close || !'[{'.includes(text[open] ?? '')) {
    return failed('Cannot find the brackets of this value.');
  }

  return succeeded([
    { start: open + 1, end: at, text: padded ? ` ${item} ` : item },
  ]);
}

/** UE's "Add pin +" on Make Array: `[a, b]` → `[a, b, 0]`. */
function addArrayElement(
  text: string,
  node: GraphNode,
  elements: ReadonlyArray<Pin>,
  syntax: StatementSyntax,
  doc: GraphDocument | undefined
): OpResult {
  const type = node.pins.find(
    (p) => p.direction === 'out' && p.kind === 'data'
  )?.type;
  const value =
    (doc ? blankElement(text, doc, node, syntax) : undefined) ??
    emptyValue(text, type ? arrayElementType(type) : 'any', elements, syntax);
  return appendItem(
    text,
    node,
    elements.flatMap((p) => (p.range ? [p.range] : [])),
    value,
    ']'
  );
}

/** Make Object's "Add pin +": a new entry with that key, still empty. */
function addObjectEntry(
  text: string,
  node: GraphNode,
  entries: ReadonlyArray<Pin>,
  syntax: StatementSyntax,
  key: string | undefined
): OpResult {
  const write = syntax.objectEntry;
  if (!write || !key) {
    return failed('A new entry needs a key.');
  }

  if (entries.some((p) => p.name === key)) {
    return failed(`"${key}" is in the object already.`);
  }

  const ranges = entries.map((p) => getMeta<InputPinMeta>(p).property);
  if (ranges.some((r) => r === undefined)) {
    return failed('Cannot find the entries of this object.');
  }

  return appendItem(
    text,
    node,
    ranges.flatMap((r) => (r ? [r] : [])),
    write.write(key, syntax.placeholder),
    '}',
    write.padded
  );
}

/**
 * UE's "Add pin +" of a node that takes more values (an operator chain,
 * Make Array or Make Object); `undefined` for other nodes.
 */
export function addPinValue(
  text: string,
  node: GraphNode,
  syntax: StatementSyntax,
  /** The key of a new object entry. */
  key?: string,
  /** The parsed file: a new element of objects gets their shape. */
  doc?: GraphDocument
): OpResult | undefined {
  const values = chainValues(node);
  if (values) {
    return addChainValue(text, node, values, syntax);
  }

  const entries = objectEntries(node);
  if (entries) {
    return addObjectEntry(text, node, entries, syntax, key);
  }

  const elements = arrayElements(node);
  return elements
    ? addArrayElement(text, node, elements, syntax, doc)
    : undefined;
}

/**
 * UE's "Remove pin" of an operator chain or Make Array: the value with
 * its operator or comma; `undefined` for other nodes.
 */
export function removePinValue(
  text: string,
  node: GraphNode,
  pinId: string
): OpResult | undefined {
  const values = chainValues(node);
  if (values) {
    return removeChainValue(text, values, pinId);
  }

  const entry = objectEntries(node)?.find((p) => p.id === pinId);
  if (entry) {
    const property = getMeta<InputPinMeta>(entry).property;
    return property
      ? succeeded([removeListItem(text, property, true)])
      : failed('Cannot find this entry of the object.');
  }

  const range = arrayElements(node)?.find((p) => p.id === pinId)?.range;
  return range
    ? succeeded([removeListItem(text, operandSpan(text, range), true)])
    : undefined;
}
