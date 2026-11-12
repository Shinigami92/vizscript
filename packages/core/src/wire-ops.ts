import type {
  ExecOutPinMeta,
  InputPinMeta,
  OutputPinMeta,
  StatementMeta,
} from './edit-meta';
import { getMeta, owningStatement } from './edit-meta';
import type {
  GraphDocument,
  GraphEdge,
  GraphNode,
  Pin,
  PinRef,
  SourceRange,
} from './ir';
import { failed, succeeded } from './op-result';
import type { OpResult, TextEdit } from './ops';
import { applyTextEdits } from './ops';
import { findNode } from './reconcile';
import {
  asStatement,
  contains,
  edgesOf,
  findPin,
  functionOf,
  inputEdit,
  insertText,
  removeStatement,
} from './text-op-helpers';
import type { StatementSyntax } from './text-ops';
import { lineAwareRange, lineIndent, reindent } from './text-utils';

/** Text that references the value of a data output, plus required edits. */
export function referenceOutput(
  text: string,
  doc: GraphDocument,
  from: PinRef,
  syntax: StatementSyntax
): { text: string; edits: TextEdit[]; availableAt: number } | string {
  const node = findNode(doc, from.node);
  const pin = findPin(node, from.pin);
  if (!node || !pin || pin.kind !== 'data' || pin.direction !== 'out') {
    return 'Source must be a data output.';
  }

  const meta = getMeta<OutputPinMeta>(pin);
  if (meta.sourceText) {
    const stmt = getMeta<StatementMeta>(node).stmt;
    // Variables written by a statement are available after it.
    const availableAt =
      node.kind === 'setVar' && stmt
        ? stmt.end
        : node.kind === 'entry'
          ? node.range.end
          : node.purity === 'pure'
            ? 0
            : node.range.start;
    return { text: meta.sourceText, edits: [], availableAt };
  }

  if (meta.bind) {
    const { bind } = meta;
    const base = bind.nameHint.replaceAll(/\W/g, '') || 'value';
    let name = syntax.bindingName(base);
    for (let i = 2; new RegExp(`\\b${name}\\b`).test(text); i++) {
      name = `${syntax.bindingName(base)}${i}`;
    }

    if (bind.isStatement) {
      return {
        text: name,
        edits: [
          {
            start: bind.stmt.start,
            end: bind.stmt.start,
            text: syntax.declarePrefix(name),
          },
        ],
        availableAt: bind.stmt.end,
      };
    }

    const indent = lineIndent(text, bind.stmt.start);
    const exprText = text.slice(bind.expr.start, bind.expr.end);
    return {
      text: name,
      edits: [
        {
          start: bind.stmt.start,
          end: bind.stmt.start,
          text: `${syntax.declare(name, exprText)}\n${indent}`,
        },
        { start: bind.expr.start, end: bind.expr.end, text: name },
      ],
      availableAt: bind.stmt.start,
    };
  }

  return 'This output cannot be referenced.';
}

/**
 * Edits of several ops on the same text as one: identical edits once (two
 * wires may need the same new variable), overlapping ones fail.
 */
function mergeEdits(results: ReadonlyArray<OpResult>): OpResult {
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
      return failed('These wires cannot be moved together.');
    }
  }

  return succeeded(sorted);
}

export function moveWires(
  text: string,
  doc: GraphDocument,
  from: PinRef,
  to: PinRef,
  syntax: StatementSyntax
): OpResult {
  const fromPin = findPin(findNode(doc, from.node), from.pin);
  const toPin = findPin(findNode(doc, to.node), to.pin);
  if (!fromPin || !toPin) {
    return failed('Unknown pin.');
  }

  if (fromPin.kind !== 'data' || toPin.kind !== 'data') {
    return failed('Only data wires can be moved together.');
  }

  if (fromPin.direction !== toPin.direction) {
    return failed('Wires move to a pin of the same side.');
  }

  const fn = doc.functions.find((f) => f.id === functionOf(doc, from.node));
  const edges = (fn?.edges ?? []).filter(
    (e) =>
      e.kind === 'data' &&
      (fromPin.direction === 'out'
        ? e.from.node === from.node && e.from.pin === from.pin
        : e.to.node === from.node && e.to.pin === from.pin)
  );
  if (edges.length === 0) {
    return failed('This pin has no wires to move.');
  }

  if (fromPin.direction === 'out') {
    // Every input the old output fed takes the new one.
    return mergeEdits(
      edges.map((e) => connectData(text, doc, to, e.to, syntax))
    );
  }

  // An input's wire goes to another input; the old one becomes empty.
  return mergeEdits(
    edges.flatMap((e) => [
      connectData(text, doc, e.from, to, syntax),
      disconnect(text, doc, from, syntax),
    ])
  );
}

export function connectData(
  text: string,
  doc: GraphDocument,
  from: PinRef,
  to: PinRef,
  syntax: StatementSyntax
): OpResult {
  const target = findNode(doc, to.node);
  const targetPin = findPin(target, to.pin);
  if (
    !target ||
    !targetPin ||
    targetPin.kind !== 'data' ||
    targetPin.direction !== 'in'
  ) {
    return failed('Target must be a data input.');
  }

  if (functionOf(doc, from.node) !== functionOf(doc, to.node)) {
    return failed('Values can only be wired within the same function.');
  }

  // A pattern or loop binding exists only inside its block.
  const sourcePin = findPin(findNode(doc, from.node), from.pin);
  const visibleIn = sourcePin
    ? getMeta<OutputPinMeta>(sourcePin).visibleIn
    : undefined;
  const usedAt = targetPin.range?.start ?? target.range.start;
  if (visibleIn && (usedAt < visibleIn.start || usedAt >= visibleIn.end)) {
    return failed(
      `${sourcePin?.name || 'This value'} only exists inside its block.`
    );
  }

  const inlined = inlineIntoNextStatement(text, doc, from, target, targetPin);
  if (inlined) {
    return inlined;
  }

  const reference = referenceOutput(text, doc, from, syntax);
  if (typeof reference === 'string') {
    return failed(reference);
  }

  const source = findNode(doc, from.node);
  if (
    source &&
    targetPin.range &&
    contains(source.range, targetPin.range) &&
    source.purity === 'pure'
  ) {
    return failed('A node cannot feed its own input.');
  }

  const consumerAt = targetPin.range?.start ?? target.range.start;
  if (reference.availableAt > consumerAt && source?.kind !== 'entry') {
    return failed('That value is not available yet at this point of the code.');
  }

  const targetRange = targetPin.range;
  if (targetRange) {
    const overlaps = reference.edits.some(
      (e) => e.start < targetRange.end && targetRange.start < e.end
    );
    if (overlaps) {
      return failed('Cannot wire a value into its own expression.');
    }

    return succeeded([
      ...reference.edits,
      inputEdit(targetPin, targetRange, reference.text),
    ]);
  }

  const inputMeta = getMeta<InputPinMeta>(targetPin);
  const insertAt = inputMeta.insertInitAt;
  if (insertAt !== undefined) {
    return succeeded([
      ...reference.edits,
      {
        start: insertAt,
        end: insertAt,
        text: `${inputMeta.insertPrefix ?? ' = '}${reference.text}`,
      },
    ]);
  }

  return failed('This input cannot be rewired.');
}

/**
 * Wiring the result of a call statement into the statement right after it
 * moves the call there (`foo();` + `return;` → `return foo();`) instead of
 * storing the result in a new variable.
 */
function inlineIntoNextStatement(
  text: string,
  doc: GraphDocument,
  from: PinRef,
  target: GraphNode,
  targetPin: Pin
): OpResult | undefined {
  const source = findNode(doc, from.node);
  const consumer = owningStatement(target);
  if (!source || !consumer || consumer.meta.locked) {
    return undefined;
  }

  // The statement holding the value and the value's own text.
  let stmt: SourceRange;
  let expr: SourceRange;
  const own = getMeta<StatementMeta>(source);
  const bind = getMeta<OutputPinMeta>(findPin(source, from.pin) ?? {}).bind;
  if (own.unused && own.stmt) {
    // An unconnected value (`a + b;`) can move to any later statement.
    stmt = own.stmt;
    expr = source.range;
    if (consumer.stmt.start < stmt.end) {
      return undefined;
    }
  } else if (bind?.isStatement) {
    // A call moves only into the very next statement (keeping the order).
    stmt = bind.stmt;
    expr = bind.expr;
    const between = text.slice(stmt.end, consumer.stmt.start);
    if (consumer.stmt.start < stmt.end || !/^\s*$/.test(between)) {
      return undefined;
    }
  } else {
    return undefined;
  }

  if (functionOf(doc, source.id) !== functionOf(doc, target.id)) {
    return undefined;
  }

  const expression = text.slice(expr.start, expr.end);
  const [removeStart, removeEnd] = lineAwareRange(text, stmt.start, stmt.end);
  const removal: TextEdit = { start: removeStart, end: removeEnd, text: '' };
  if (targetPin.range) {
    return succeeded([
      removal,
      inputEdit(targetPin, targetPin.range, expression),
    ]);
  }

  const inputMeta = getMeta<InputPinMeta>(targetPin);
  if (inputMeta.insertInitAt === undefined) {
    return undefined;
  }

  return succeeded([
    removal,
    {
      start: inputMeta.insertInitAt,
      end: inputMeta.insertInitAt,
      text: `${inputMeta.insertPrefix ?? ' = '}${expression}`,
    },
  ]);
}

export function connectExec(
  text: string,
  doc: GraphDocument,
  from: PinRef,
  to: PinRef,
  syntax: StatementSyntax
): OpResult {
  const source = findNode(doc, from.node);
  const sourcePin = findPin(source, from.pin);
  const target = findNode(doc, to.node);
  if (!source || !sourcePin || !target) {
    return failed('Unknown pins.');
  }

  if (functionOf(doc, from.node) !== functionOf(doc, to.node)) {
    return failed('Execution can only be wired within the same function.');
  }

  const insert = getMeta<ExecOutPinMeta>(sourcePin).insert;
  const stmtMeta = getMeta<StatementMeta>(target);
  if (!insert) {
    return failed('Code cannot be inserted after this pin.');
  }

  if (!stmtMeta.stmt || stmtMeta.inline || stmtMeta.locked) {
    return failed('Only whole statements can be moved.');
  }

  const stmt = stmtMeta.stmt;
  if (stmt.start <= insert.at && insert.at <= stmt.end) {
    return failed('A statement cannot be moved into itself.');
  }

  const removal = removeStatement(text, { ...stmtMeta, stmt }, syntax);
  if (removal.start < insert.at && insert.at < removal.end) {
    return succeeded([]);
  }

  const snippet = reindent(
    text.slice(stmt.start, stmt.end),
    lineIndent(text, stmt.start),
    insert.indent
  );
  return succeeded([removal, insertText(insert, snippet)]);
}

/**
 * Edits that take the value out of a data input. Nodes computed right in
 * that input stay as a statement of their own (`return load()` → `load();`
 * then `return;`, `foo(a + b)` → `a + b;` then `foo(undefined)`), like
 * Blueprint nodes that just lose their wire.
 */
function clearInput(
  text: string,
  doc: GraphDocument,
  target: GraphNode,
  pin: Pin,
  syntax: StatementSyntax,
  /** The code kept as a statement (default: the input's code as it is). */
  keep = (r: SourceRange): string => text.slice(r.start, r.end)
): TextEdit[] {
  const range = pin.range;
  if (!range) {
    return [];
  }

  const edits: TextEdit[] = [];
  const edge = edgesOf(doc, target.id).find(
    (e) => e.to.node === target.id && e.to.pin === pin.id
  );
  const source = edge ? findNode(doc, edge.from.node) : undefined;
  const consumer = owningStatement(target);
  if (
    source &&
    source.kind !== 'entry' &&
    contains(range, source.range) &&
    consumer &&
    !consumer.meta.inline &&
    range.end > range.start
  ) {
    const indent = lineIndent(text, consumer.stmt.start);
    edits.push({
      start: consumer.stmt.start,
      end: consumer.stmt.start,
      text: `${asStatement(keep(range), syntax)}\n${indent}`,
    });
  }

  if (getMeta<InputPinMeta>(pin).optional) {
    // Also drop the space before the value: `return x;` → `return;`.
    let start = range.start;
    while (start > 0 && (text[start - 1] === ' ' || text[start - 1] === '\t')) {
      start--;
    }

    edits.push({ start, end: range.end, text: '' });
  } else {
    edits.push(inputEdit(pin, range, syntax.placeholder));
  }

  return edits;
}

export function disconnect(
  text: string,
  doc: GraphDocument,
  ref: PinRef,
  syntax: StatementSyntax
): OpResult {
  const node = findNode(doc, ref.node);
  const pin = findPin(node, ref.pin);
  if (!node || !pin) {
    return failed('Unknown pin.');
  }

  if (pin.kind === 'exec') {
    return failed(
      'Execution order follows the code. Drag the wire onto another node to reorder.'
    );
  }

  if (pin.direction === 'in') {
    const edits = clearInput(text, doc, node, pin, syntax);
    return edits.length > 0
      ? succeeded(edits)
      : failed('Nothing to disconnect.');
  }

  const edits: TextEdit[] = [];
  for (const edge of edgesOf(doc, node.id)) {
    if (edge.from.node === ref.node && edge.from.pin === ref.pin) {
      const target = findNode(doc, edge.to.node);
      const targetPin = findPin(target, edge.to.pin);
      if (target && targetPin) {
        edits.push(...clearInput(text, doc, target, targetPin, syntax));
      }
    }
  }

  return edits.length > 0 ? succeeded(edits) : failed('Nothing to disconnect.');
}

/**
 * UE's "Break Node Link(s)": every data wire into and out of a node. An
 * edit inside another one (an input of a value that is itself cleared)
 * is left out.
 */
export function disconnectNode(
  text: string,
  doc: GraphDocument,
  nodeId: string,
  syntax: StatementSyntax
): OpResult {
  const node = findNode(doc, nodeId);
  if (!node) {
    return failed('Unknown node.');
  }

  const wires = edgesOf(doc, nodeId).filter((e) => e.kind === 'data');
  const clear = (
    edge: GraphEdge,
    keep?: (r: SourceRange) => string
  ): TextEdit[] => {
    const target = findNode(doc, edge.to.node);
    const pin = findPin(target, edge.to.pin);
    return target && pin
      ? clearInput(text, doc, target, pin, syntax, keep)
      : [];
  };

  // The node's own inputs first; where its value is kept as a statement
  // (its output cleared), it is kept with these inputs cleared.
  const inputs = wires
    .filter((e) => e.to.node === nodeId)
    .flatMap((e) => clear(e));
  const keep = (r: SourceRange): string =>
    applyTextEdits(
      text.slice(r.start, r.end),
      inputs
        .filter(
          (e) =>
            r.start <= e.start &&
            e.end <= r.end &&
            !(e.start === e.end && e.start === r.start)
        )
        .map((e) => ({ ...e, start: e.start - r.start, end: e.end - r.start }))
    );
  const outputs = wires
    .filter((e) => e.from.node === nodeId)
    .flatMap((e) => clear(e, keep));

  // Edits inside a replaced range are part of it (or of its kept copy).
  const kept: TextEdit[] = [];
  for (const edit of [...outputs, ...inputs].toSorted(
    (a, b) => b.end - b.start - (a.end - a.start)
  )) {
    const inside = kept.some(
      (k) =>
        k.end > k.start &&
        k.start <= edit.start &&
        edit.end <= k.end &&
        (edit.start < edit.end ? true : edit.start > k.start)
    );
    const same = kept.some(
      (k) =>
        k.start === edit.start && k.end === edit.end && k.text === edit.text
    );
    if (!inside && !same) {
      kept.push(edit);
    }
  }

  // Statements kept at the same place, in order: inputs before the node.
  const ordered = [...inputs, ...outputs];
  const merged: TextEdit[] = [];
  for (const edit of kept.toSorted(
    (a, b) => a.start - b.start || ordered.indexOf(a) - ordered.indexOf(b)
  )) {
    const last = merged.at(-1);
    if (
      last &&
      last.start === last.end &&
      edit.start === edit.end &&
      last.start === edit.start
    ) {
      merged[merged.length - 1] = { ...last, text: last.text + edit.text };
    } else {
      merged.push(edit);
    }
  }

  const sorted = merged;
  for (const [i, edit] of sorted.entries()) {
    const next = sorted[i + 1];
    if (next && next.start < edit.end) {
      return failed('The wires of this node overlap; break them one by one.');
    }
  }

  return merged.length > 0
    ? succeeded(merged)
    : failed('Nothing to disconnect.');
}
