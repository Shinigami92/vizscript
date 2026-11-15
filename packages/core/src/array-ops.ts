import { emptyValue, operandSpan } from './add-pin-ops';
import type { GraphDocument, GraphNode, Pin, SourceRange } from './ir';
import { failed, succeeded } from './op-result';
import { arrayElements } from './operator-chain';
import type { OpResult, TextEdit } from './ops';
import { findNode } from './reconcile';
import { holdsFields } from './symbols';
import type { StatementSyntax } from './text-ops';
import { lineIndent } from './text-utils';
import { arrayElementType } from './types';

/** The node a data input is wired from (a Make Object of an element). */
export function inputSource(
  doc: GraphDocument,
  node: GraphNode,
  pin: Pin
): GraphNode | undefined {
  for (const fn of doc.functions) {
    const edge = fn.edges.find(
      (e) => e.kind === 'data' && e.to.node === node.id && e.to.pin === pin.id
    );
    if (edge) {
      return fn.nodes.find((n) => n.id === edge.from.node);
    }
  }

  return undefined;
}

/** The empty value of a literal of the same kind (`''`, `0`, `false`). */
function emptyLiteral(pin: Pin, syntax: StatementSyntax): string | undefined {
  const literal = pin.literal;
  switch (literal?.kind) {
    case 'string':
    case 'template': {
      return syntax.quote('', literal);
    }

    case 'number': {
      return syntax.number?.('0', literal.raw) ?? '0';
    }

    case 'boolean': {
      return (syntax.booleans ?? { true: 'true', false: 'false' }).false;
    }

    default: {
      return undefined;
    }
  }
}

/**
 * The code of a value with its literals emptied, keeping its shape:
 * `{ name: 'Cable', price: 4.5 }` → `{ name: '', price: 0 }` (UE: a new
 * array element of a struct starts with the struct's defaults).
 */
function blankCopy(
  text: string,
  doc: GraphDocument,
  node: GraphNode,
  syntax: StatementSyntax
): string {
  const edits: Array<{ range: SourceRange; text: string }> = [];
  for (const pin of node.pins) {
    if (pin.direction !== 'in' || pin.kind !== 'data' || !pin.range) {
      continue;
    }

    const source = inputSource(doc, node, pin);
    const empty = source
      ? source.kind === 'makeObject'
        ? blankCopy(text, doc, source, syntax)
        : undefined
      : emptyLiteral(pin, syntax);
    if (empty !== undefined) {
      edits.push({ range: source?.range ?? pin.range, text: empty });
    }
  }

  let code = text.slice(node.range.start, node.range.end);
  for (const edit of edits.toSorted((a, b) => b.range.start - a.range.start)) {
    const start = edit.range.start - node.range.start;
    const end = edit.range.end - node.range.start;
    code = code.slice(0, start) + edit.text + code.slice(end);
  }

  return code;
}

/**
 * A new element for an array of objects: the shape of the first one with
 * empty values; `undefined` when the elements aren't objects.
 */
export function blankElement(
  text: string,
  doc: GraphDocument,
  node: GraphNode,
  syntax: StatementSyntax
): string | undefined {
  for (const pin of arrayElements(node) ?? []) {
    const source = inputSource(doc, node, pin);
    if (source?.kind === 'makeObject') {
      return blankCopy(text, doc, source, syntax);
    }
  }

  return blankOfType(text, doc, node, syntax);
}

/**
 * A new element from the declared element type when there is none to copy
 * (`const cart: Item[] = []` → `{ name: '', price: 0, quantity: 0 }`).
 */
function blankOfType(
  text: string,
  doc: GraphDocument,
  node: GraphNode,
  syntax: StatementSyntax
): string | undefined {
  const declared = doc.symbols?.find(
    (s) =>
      s.defaultRange?.start === node.range.start &&
      s.defaultRange.end === node.range.end
  )?.type?.text;
  const template = syntax.declarations?.typeSystem.array;
  if (!declared || !template) {
    return undefined;
  }

  const at = template.indexOf('T');
  const before = template.slice(0, at);
  const after = template.slice(at + 1);
  const element =
    declared.startsWith(before) && declared.endsWith(after)
      ? declared.slice(before.length, declared.length - after.length).trim()
      : undefined;
  return element ? blankValue(text, doc, element, syntax) : undefined;
}

/**
 * UE's Make <Struct>: a value of a type that lists fields (an interface,
 * an object type) with each field's empty value (`Item` →
 * `{ name: '', price: 0, quantity: 0 }`); `undefined` for other types.
 */
export function blankValue(
  text: string,
  doc: GraphDocument,
  typeName: string,
  syntax: StatementSyntax
): string | undefined {
  const write = syntax.objectEntry;
  const owner = doc.symbols?.find((s) => holdsFields(s) && s.name === typeName);
  const fields = owner
    ? (doc.symbols ?? []).filter(
        (s) => s.kind === 'variable' && s.scope === owner.name
      )
    : [];
  if (!write || fields.length === 0) {
    return undefined;
  }

  const entries = fields
    .map((f) => write.write(f.name, emptyValue(text, f.dataType, [], syntax)))
    .join(', ');
  return write.padded ? `{ ${entries} }` : `{${entries}}`;
}

function elementsOf(
  text: string,
  doc: GraphDocument,
  nodeId: string
):
  | { node: GraphNode; pins: ReadonlyArray<Pin>; spans: SourceRange[] }
  | string {
  const node = findNode(doc, nodeId);
  const pins = node ? arrayElements(node) : undefined;
  if (!node || !pins) {
    return 'Only the elements of an array literal can be changed here.';
  }

  const spans = pins.flatMap((p) =>
    p.range ? [operandSpan(text, p.range)] : []
  );
  return spans.length === pins.length
    ? { node, pins, spans }
    : 'Cannot find the elements of this array.';
}

/**
 * UE's Insert and Duplicate of an array element: a new empty element
 * before `index`, or a copy of it after it (`copy`).
 */
export function insertElement(
  text: string,
  doc: GraphDocument,
  nodeId: string,
  index: number,
  copy: boolean,
  syntax: StatementSyntax
): OpResult {
  const found = elementsOf(text, doc, nodeId);
  if (typeof found === 'string') {
    return failed(found);
  }

  const { node, pins, spans } = found;
  const span = spans[index];
  const first = spans[0];
  if (!span || !first) {
    return failed('There is no such element.');
  }

  const type = node.pins.find(
    (p) => p.direction === 'out' && p.kind === 'data'
  )?.type;
  const value = copy
    ? text.slice(span.start, span.end)
    : (blankElement(text, doc, node, syntax) ??
      emptyValue(text, type ? arrayElementType(type) : 'any', pins, syntax));
  // One element per line: the new one gets its own, like the others.
  const ownLines = text.slice(node.range.start, first.start).includes('\n');
  const indent = lineIndent(text, span.start);
  const edit: TextEdit = copy
    ? {
        start: span.end,
        end: span.end,
        text: ownLines ? `,\n${indent}${value}` : `, ${value}`,
      }
    : {
        start: span.start,
        end: span.start,
        text: ownLines ? `${value},\n${indent}` : `${value}, `,
      };
  return succeeded([edit]);
}

/** Moves an array element to another index (UE: drag its grip). */
export function moveElement(
  text: string,
  doc: GraphDocument,
  nodeId: string,
  from: number,
  to: number
): OpResult {
  const found = elementsOf(text, doc, nodeId);
  if (typeof found === 'string') {
    return failed(found);
  }

  const { spans } = found;
  if (!spans[from] || !spans[to]) {
    return failed('There is no such element.');
  }

  const codes = spans.map((s) => text.slice(s.start, s.end));
  const order = [...codes];
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved ?? '');
  return succeeded(
    spans.flatMap((span, i) =>
      order[i] === codes[i] ? [] : [{ ...span, text: order[i] ?? '' }]
    )
  );
}
