import { ARG_PIN, callClose } from './call-pins';
import type {
  ExecOutPinMeta,
  InsertPoint,
  OutputPinMeta,
  StatementMeta,
} from './edit-meta';
import { getMeta, owningStatement } from './edit-meta';
import type { GraphDocument, GraphNode, Pin, PinRef, SourceRange } from './ir';
import { setInput } from './literal-ops';
import { failed, succeeded } from './op-result';
import type { NodeTemplate, OpResult, TextEdit } from './ops';
import { findNode } from './reconcile';
import { removeListItem } from './symbol-edits';
import {
  detectIndentUnit,
  findPin,
  inputEdit,
  insertText,
  templateSnippet,
} from './text-op-helpers';
import type { StatementSyntax } from './text-ops';
import { lineIndent, lineStart } from './text-utils';
import { referenceOutput } from './wire-ops';

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** Insert point right after the statement with the given range. */
function afterStatement(text: string, stmt: SourceRange): InsertPoint {
  return { at: stmt.end, indent: lineIndent(text, stmt.start), mode: 'after' };
}

/**
 * Whether new code goes into the file's top level (a module), where a
 * `return` is not allowed. Without an anchor, code is appended there.
 */
function inTopLevel(
  text: string,
  doc: GraphDocument,
  anchor: { after?: PinRef; before?: PinRef }
): boolean {
  const id = anchor.after?.node ?? anchor.before?.node;
  const fn = id
    ? doc.functions.find((f) => f.nodes.some((n) => n.id === id))
    : undefined;
  // A function spanning the whole file is still a function: it has a symbol.
  return (
    !fn ||
    (fn.range.start === 0 &&
      fn.range.end >= text.trimEnd().length &&
      !(doc.symbols ?? []).some((s) => s.fnId === fn.id))
  );
}

export function addNode(
  text: string,
  doc: GraphDocument,
  template: NodeTemplate,
  anchor: { after?: PinRef; before?: PinRef },
  syntax: StatementSyntax
): OpResult {
  if (template.type === 'return' && inTopLevel(text, doc, anchor)) {
    return failed('Return can only be used inside a function.');
  }

  const unit = detectIndentUnit(text);
  let insert: InsertPoint | undefined;
  if (anchor.after) {
    const node = findNode(doc, anchor.after.node);
    const pin = findPin(node, anchor.after.pin);
    insert = pin ? getMeta<ExecOutPinMeta>(pin).insert : undefined;
    if (!insert) {
      const split = node
        ? afterNestedCall(text, node, template, unit, syntax)
        : undefined;
      return split ?? failed('Code cannot be inserted after this pin.');
    }
  } else if (anchor.before) {
    const meta = getMeta<StatementMeta>(
      findNode(doc, anchor.before.node) ?? {}
    );
    if (!meta.stmt || meta.inline || meta.locked) {
      return failed('Code cannot be inserted before this node.');
    }

    insert = {
      at: meta.stmt.start,
      indent: lineIndent(text, meta.stmt.start),
      mode: 'before',
    };
  } else {
    if (!syntax.appendToFile) {
      return failed('Drag from an exec pin to choose where the new code goes.');
    }

    const trailing = text.length > 0 && !text.endsWith('\n') ? '\n' : '';
    const snippet = templateSnippet(syntax, template, '', unit);
    if (!snippet) {
      return failed('Invalid name.');
    }

    return succeeded([
      { start: text.length, end: text.length, text: `${trailing}${snippet}\n` },
    ]);
  }

  const snippet = templateSnippet(syntax, template, insert.indent, unit);
  if (!snippet) {
    return failed('Invalid name.');
  }

  return succeeded([insertText(insert, snippet, text)]);
}

/**
 * Adding a statement after a call that is part of a larger statement
 * (`return load(path)`): the result moves into a variable first, so the new
 * statement can run between the call and its use, like in Blueprints:
 * `const loadResult = load(path);`, the new statement, `return loadResult;`.
 */
function afterNestedCall(
  text: string,
  node: GraphNode,
  template: NodeTemplate,
  unit: string,
  syntax: StatementSyntax
): OpResult | undefined {
  const bind = node.pins
    .map((p) => getMeta<OutputPinMeta>(p).bind)
    .find((b) => b !== undefined && !b.isStatement);
  if (!bind) {
    return undefined;
  }

  const indent = lineIndent(text, bind.stmt.start);
  if (
    !/^[ \t]*$/.test(
      text.slice(lineStart(text, bind.stmt.start), bind.stmt.start)
    )
  ) {
    return failed('Code cannot be inserted inside this line.');
  }

  const snippet = templateSnippet(syntax, template, indent, unit);
  if (!snippet) {
    return failed('Invalid name.');
  }

  const base = bind.nameHint.replaceAll(/\W/g, '') || 'value';
  let name = syntax.bindingName(base);
  for (let i = 2; new RegExp(`\\b${name}\\b`).test(text); i++) {
    name = `${syntax.bindingName(base)}${i}`;
  }

  const expression = text.slice(bind.expr.start, bind.expr.end);
  return succeeded([
    {
      start: bind.stmt.start,
      end: bind.stmt.start,
      text: `${syntax.declare(name, expression)}\n${indent}${snippet}\n${indent}`,
    },
    { start: bind.expr.start, end: bind.expr.end, text: name },
  ]);
}

/** The statement a data output belongs to (where its value exists). */
function producingStatement(
  node: GraphNode,
  pin: Pin
): SourceRange | undefined {
  const meta = getMeta<OutputPinMeta>(pin);
  return meta.bind?.stmt ?? getMeta<StatementMeta>(node).stmt ?? meta.scope;
}

export function promote(
  text: string,
  doc: GraphDocument,
  ref: PinRef,
  name: string,
  syntax: StatementSyntax
): OpResult {
  const node = findNode(doc, ref.node);
  const pin = findPin(node, ref.pin);
  if (!node || !pin || pin.kind !== 'data' || pin.direction !== 'out') {
    return failed('Only values can be stored in a variable.');
  }

  const variable = name.trim();
  if (!IDENTIFIER.test(variable)) {
    return failed('Invalid variable name.');
  }

  if (node.kind === 'setVar' || node.kind === 'entry') {
    return failed('This value already has a name.');
  }

  const meta = getMeta<OutputPinMeta>(pin);
  if (meta.bind) {
    const { stmt, expr, isStatement } = meta.bind;
    if (isStatement) {
      return succeeded([
        {
          start: stmt.start,
          end: stmt.start,
          text: syntax.declarePrefix(variable),
        },
      ]);
    }

    return succeeded([
      {
        start: stmt.start,
        end: stmt.start,
        text: `${syntax.declare(variable, text.slice(expr.start, expr.end))}\n${lineIndent(text, stmt.start)}`,
      },
      { start: expr.start, end: expr.end, text: variable },
    ]);
  }

  const scope = meta.scope;
  if (!meta.sourceText || !scope || node.purity !== 'pure') {
    return failed('This value cannot be stored in a variable.');
  }

  return succeeded([
    {
      start: scope.start,
      end: scope.start,
      text: `${syntax.declare(variable, meta.sourceText)}\n${lineIndent(text, scope.start)}`,
    },
    { start: node.range.start, end: node.range.end, text: variable },
  ]);
}

/** Statement a node is evaluated in (own statement or the enclosing one). */
export function extract(
  text: string,
  doc: GraphDocument,
  ref: PinRef,
  name: string,
  syntax: StatementSyntax,
  value?: string
): OpResult {
  const node = findNode(doc, ref.node);
  const pin = findPin(node, ref.pin);
  if (!node || !pin || pin.kind !== 'data' || pin.direction !== 'in') {
    return failed('Only inputs can be extracted to a variable.');
  }

  const variable = name.trim();
  if (!IDENTIFIER.test(variable)) {
    return failed('Invalid variable name.');
  }

  const owner = owningStatement(node);
  if (!owner || owner.meta.inline || owner.meta.locked) {
    return failed('There is no place for a variable before this node.');
  }

  const { stmt } = owner;
  const declaration = (expression: string): TextEdit => ({
    start: stmt.start,
    end: stmt.start,
    text: `${syntax.declare(variable, expression)}\n${lineIndent(text, stmt.start)}`,
  });
  if (!pin.range || pin.range.end <= pin.range.start) {
    // UE promotes an empty input too: the variable starts with `value`.
    if (!value) {
      return failed('This input has no value to extract.');
    }

    const used = setInput(doc, ref, variable);
    return used.ok ? succeeded([declaration(value), ...used.edits]) : used;
  }

  return succeeded([
    declaration(text.slice(pin.range.start, pin.range.end)),
    inputEdit(pin, pin.range, variable),
  ]);
}

export function callWith(
  text: string,
  doc: GraphDocument,
  ref: PinRef,
  callee: string,
  syntax: StatementSyntax
): OpResult {
  return afterValue(text, doc, ref, syntax, (value) => ({
    type: 'call',
    callee,
    args: [value],
  }));
}

/**
 * Uses a value in a new expression of its own (UE: dragging from an output
 * to a `+` node): `$value` in the expression becomes the value. It shows as
 * unconnected nodes until its result is wired into an input.
 */
export function useValue(
  text: string,
  doc: GraphDocument,
  ref: PinRef,
  expression: string,
  syntax: StatementSyntax
): OpResult {
  const chained = chainedCall(text, doc, ref, expression);
  if (chained) {
    return succeeded([chained]);
  }

  return afterValue(text, doc, ref, syntax, (value) => ({
    type: 'value',
    expression: expression.replaceAll('$value', value),
  }));
}

/**
 * A member of an unused call result, written onto the call itself like a
 * fluent chain (`program.name('x');` → `program.name('x').version();`)
 * instead of binding the result to a variable first. Multi-line chains get
 * the member on a line of its own.
 */
function chainedCall(
  text: string,
  doc: GraphDocument,
  ref: PinRef,
  expression: string
): TextEdit | undefined {
  const member = /^\$value(\.[A-Za-z_$][\w$]*(?:\(.*\))?)$/s.exec(expression);
  const pin = findPin(findNode(doc, ref.node), ref.pin);
  const bind = pin ? getMeta<OutputPinMeta>(pin).bind : undefined;
  if (!member?.[1] || !bind?.isStatement) {
    return undefined;
  }

  const code = text.slice(bind.expr.start, bind.expr.end);
  const lastLine = code.split('\n').at(-1) ?? '';
  const onItsOwnLine =
    code.includes('\n') && lastLine.trimStart().startsWith('.');
  const prefix = onItsOwnLine
    ? `\n${lastLine.slice(0, lastLine.length - lastLine.trimStart().length)}`
    : '';
  return {
    start: bind.expr.end,
    end: bind.expr.end,
    text: `${prefix}${member[1]}`,
  };
}

/** A new statement right after a value exists, made from the value. */
function afterValue(
  text: string,
  doc: GraphDocument,
  ref: PinRef,
  syntax: StatementSyntax,
  template: (value: string) => NodeTemplate
): OpResult {
  const node = findNode(doc, ref.node);
  const pin = findPin(node, ref.pin);
  if (!node || !pin || pin.kind !== 'data' || pin.direction !== 'out') {
    return failed('Only values can be used here.');
  }

  const reference = referenceOutput(text, doc, ref, syntax);
  if (typeof reference === 'string') {
    return failed(reference);
  }

  let insert: InsertPoint | undefined;
  if (node.kind === 'entry') {
    // Parameters: at the start of the function body.
    const then = node.pins.find((p) => p.kind === 'exec');
    insert = then ? getMeta<ExecOutPinMeta>(then).insert : undefined;
  } else {
    const stmt = producingStatement(node, pin);
    insert = stmt ? afterStatement(text, stmt) : undefined;
  }

  if (!insert) {
    return failed('There is no place for code after this value.');
  }

  const snippet = templateSnippet(
    syntax,
    template(reference.text),
    insert.indent,
    detectIndentUnit(text)
  );
  if (!snippet) {
    return failed('Invalid name.');
  }

  return succeeded([...reference.edits, insertText(insert, snippet, text)]);
}

/**
 * Adds an argument to a call (UE: "Add pin"): a placeholder that shows as
 * a new input pin to wire or fill in.
 */
export function addArgument(
  text: string,
  doc: GraphDocument,
  nodeId: string,
  syntax: StatementSyntax
): OpResult {
  const node = findNode(doc, nodeId);
  const close = node?.kind === 'call' ? callClose(text, node) : undefined;
  if (!node || close === undefined) {
    return failed('Arguments can only be added to calls.');
  }

  const hasArgs =
    text.slice(text.lastIndexOf('(', close) + 1, close).trim() !== '';
  const open = text.slice(node.range.start, close).includes('(');
  if (!open) {
    return failed('Cannot find the arguments of this call.');
  }

  return succeeded([
    {
      start: close,
      end: close,
      text: `${hasArgs ? ', ' : ''}${syntax.placeholder}`,
    },
  ]);
}

/** `...`, `*`, `**` or `name=` written before an argument's value. */
const ARG_PREFIX = /(?<=[(,]\s*)(?:\.\.\.|\*{1,2}|[A-Za-z_]\w*\s*=(?!=))\s*$/;

/** Removes an argument of a call with its comma (UE: "Remove pin"). */
export function removeArgument(
  text: string,
  doc: GraphDocument,
  ref: PinRef
): OpResult {
  const node = findNode(doc, ref.node);
  const pin = findPin(node, ref.pin);
  if (node?.kind !== 'call' || !pin?.range || !ARG_PIN.test(pin.id)) {
    return failed('Only arguments written in a call can be removed.');
  }

  const prefix = text.slice(0, pin.range.start).match(ARG_PREFIX)?.[0] ?? '';
  return succeeded([
    removeListItem(
      text,
      { start: pin.range.start - prefix.length, end: pin.range.end },
      true
    ),
  ]);
}
