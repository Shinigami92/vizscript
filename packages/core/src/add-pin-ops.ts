import type { GraphNode, Pin, SourceRange } from './ir';
import { failed, succeeded } from './op-result';
import { arrayElements, chainValues, MAX_CHAIN_PINS } from './operator-chain';
import type { OpResult } from './ops';
import { removeListItem } from './symbol-edits';
import type { StatementSyntax } from './text-ops';
import { lineIndent } from './text-utils';
import { arrayElementType } from './types';

/** A value with the parentheses around it: `(b)` of `a + (b)`. */
function operandSpan(text: string, range: SourceRange): SourceRange {
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
function emptyValue(
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

/** UE's "Add pin +" on Make Array: `[a, b]` → `[a, b, 0]`. */
function addArrayElement(
  text: string,
  node: GraphNode,
  elements: ReadonlyArray<Pin>,
  syntax: StatementSyntax
): OpResult {
  const type = node.pins.find(
    (p) => p.direction === 'out' && p.kind === 'data'
  )?.type;
  const value = emptyValue(
    text,
    type ? arrayElementType(type) : 'any',
    elements,
    syntax
  );
  const first = elements[0]?.range;
  const last = elements.at(-1)?.range;
  if (first && last) {
    const end = operandSpan(text, last).end;
    // One element per line: the new one gets its own, like the others.
    if (text.slice(node.range.start, first.start).includes('\n')) {
      const indent = lineIndent(text, last.start);
      const trailing = text.slice(end).match(/^[ \t]*,/)?.[0];
      return succeeded([
        trailing
          ? {
              start: end + trailing.length,
              end: end + trailing.length,
              text: `\n${indent}${value},`,
            }
          : { start: end, end, text: `,\n${indent}${value}` },
      ]);
    }

    return succeeded([{ start: end, end, text: `, ${value}` }]);
  }

  // An empty array: the value goes between its brackets.
  const close = node.range.end - 1;
  if (text[close] !== ']') {
    return failed('Cannot find the end of this array.');
  }

  return succeeded([{ start: close, end: close, text: value }]);
}

/**
 * UE's "Add pin +" of a node that takes more values (an operator chain or
 * Make Array); `undefined` for other nodes.
 */
export function addPinValue(
  text: string,
  node: GraphNode,
  syntax: StatementSyntax
): OpResult | undefined {
  const values = chainValues(node);
  if (values) {
    return addChainValue(text, node, values, syntax);
  }

  const elements = arrayElements(node);
  return elements ? addArrayElement(text, node, elements, syntax) : undefined;
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

  const range = arrayElements(node)?.find((p) => p.id === pinId)?.range;
  return range
    ? succeeded([removeListItem(text, operandSpan(text, range), true)])
    : undefined;
}
