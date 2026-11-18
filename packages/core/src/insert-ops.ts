import { addPinValue, removePinValue } from './add-pin-ops';
import { ARG_PIN, callClose } from './call-pins';
import type { DeclarationSyntax } from './declaration-syntax';
import type {
  ExecOutPinMeta,
  InputPinMeta,
  InsertPoint,
  OutputPinMeta,
  StatementMeta,
} from './edit-meta';
import { getMeta, owningStatement } from './edit-meta';
import type { GraphDocument, GraphNode, Pin, PinRef, SourceRange } from './ir';
import { setInput } from './literal-ops';
import { failed, succeeded } from './op-result';
import { substituteValue } from './operand-parens';
import type { NodeTemplate, OpResult, TextEdit } from './ops';
import { findNode } from './reconcile';
import { removeListItem, setModifier } from './symbol-edits';
import {
  detectIndentUnit,
  findPin,
  functionEdgesOf,
  inputCode,
  inputEdit,
  insertText,
  nodeCode,
  templateSnippet,
  valueEdit,
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

  template = withRequiredArguments(doc, template, syntax);

  const unit = detectIndentUnit(text);
  let insert: InsertPoint | undefined;
  if (anchor.after) {
    const node = findNode(doc, anchor.after.node);
    const pin = findPin(node, anchor.after.pin);
    insert = pin ? getMeta<ExecOutPinMeta>(pin).insert : undefined;
    if (!insert) {
      const branch =
        node && anchor.after.pin === 'false'
          ? elseBranch(text, doc, node, template, unit, syntax)
          : undefined;
      const split = node
        ? afterNestedCall(text, node, template, unit, syntax)
        : undefined;
      return (
        branch ?? split ?? failed('Code cannot be inserted after this pin.')
      );
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

  if (anchor.after) {
    insert = belowDefinitions(text, doc, anchor.after.node, insert, syntax);
  }

  const snippet = templateSnippet(syntax, template, insert.indent, unit);
  if (!snippet) {
    return failed('Invalid name.');
  }

  return succeeded([insertText(insert, snippet, text)]);
}

/**
 * A node on the False pin of an `if` without `else`: the `if` gets one,
 * holding the new code (a Branch becomes `elif` / `else if`). Not when the
 * pin leads on already (into an `elif`).
 */
function elseBranch(
  text: string,
  doc: GraphDocument,
  node: GraphNode,
  template: NodeTemplate,
  unit: string,
  syntax: StatementSyntax
): OpResult | undefined {
  const stmt = getMeta<StatementMeta>(node).stmt;
  const wired = functionEdgesOf(doc, node.id).some(
    (e) =>
      e.kind === 'exec' && e.from.node === node.id && e.from.pin === 'false'
  );
  if (node.kind !== 'branch' || !syntax.elseBranch || !stmt || wired) {
    return undefined;
  }

  const indent = lineIndent(text, stmt.start);
  const elseIf = template.type === 'branch';
  const body = templateSnippet(
    syntax,
    template,
    elseIf ? indent : `${indent}${unit}`,
    unit
  );
  if (!body) {
    return failed('Invalid name.');
  }

  return succeeded([
    {
      start: stmt.end,
      end: stmt.end,
      text: syntax.elseBranch(body, indent, unit, elseIf),
    },
  ]);
}

/**
 * Where a statement added to the module's flow goes in a language that runs
 * the module from top to bottom: below the functions and classes between
 * its anchor and the next statement of the flow (`if __name__ ==
 * "__main__":` after the `def`s it calls), else right after the anchor.
 */
function belowDefinitions(
  text: string,
  doc: GraphDocument,
  anchorNode: string,
  insert: InsertPoint,
  syntax: StatementSyntax
): InsertPoint {
  const fn = doc.functions.find((f) =>
    f.nodes.some((n) => n.id === anchorNode)
  );
  if (
    !syntax.definitionsRunInOrder ||
    insert.mode !== 'after' ||
    insert.indent !== '' ||
    !fn ||
    !inTopLevel(text, doc, { after: { node: anchorNode, pin: '' } })
  ) {
    return insert;
  }

  const next = Math.min(
    text.length,
    ...fn.nodes
      .map((n) => getMeta<StatementMeta>(n).stmt?.start ?? -1)
      .filter((start) => start >= insert.at)
  );
  const definitions = (doc.symbols ?? [])
    .filter(
      (s) => s.scope === '' && (s.kind === 'function' || s.kind === 'class')
    )
    .map((s) => s.declarationRange ?? s.range)
    .filter((r) => r.start >= insert.at && r.end <= next);
  const end = Math.max(-1, ...definitions.map((r) => r.end));
  // To the end of its line: a `const` function's range ends before `;`.
  const newline = text.indexOf('\n', end);
  const last = newline === -1 ? text.length : newline;
  return end < 0
    ? insert
    : {
        at: last,
        indent: '',
        mode: 'after',
        blankLines: syntax.declarations?.blankLines ?? 1,
      };
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

  // An unused value (`items[0];`) becomes the variable's value in place.
  const own = getMeta<StatementMeta>(node);
  if (own.unused && own.stmt) {
    return succeeded([
      {
        start: own.stmt.start,
        end: own.stmt.start,
        text: syntax.declarePrefix(variable),
      },
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
    // Through the input it fills: `not var` for the CONTAINS of `not in`.
    valueEdit(doc, node, variable),
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
    declaration(inputCode(text, doc, node, pin)),
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
  return afterValue(text, doc, ref, syntax, (value) =>
    withRequiredArguments(doc, { type: 'call', callee, args: [value] }, syntax)
  );
}

/**
 * A new call of a function of the file or an imported one, with a value
 * for each required parameter it doesn't get, in languages where a missing
 * argument fails: the default of the parameter's type when it is a plain
 * value (`heal(0)`), else the placeholder (`summary(None)`).
 */
function withRequiredArguments(
  doc: GraphDocument,
  template: NodeTemplate,
  syntax: StatementSyntax
): NodeTemplate {
  if (!syntax.requiredArguments || template.type !== 'call') {
    return template;
  }

  const callee = template.callee.trim();
  const fn = (doc.symbols ?? []).find(
    (s) =>
      s.scope === '' &&
      s.name === callee &&
      (s.kind === 'function' || s.kind === 'import') &&
      s.params
  );
  const required: string[] = [];
  for (const param of fn?.params ?? []) {
    if (
      param.rest ||
      param.defaultRange !== undefined ||
      param.defaultText !== undefined
    ) {
      break;
    }

    const option = syntax.declarations?.typeSystem.primitives.find(
      (p) => p.name === param.type?.text.trim()
    );
    required.push(
      option && !option.defaultIsNode ? option.defaultValue : syntax.placeholder
    );
  }

  const given = template.args ?? [];
  return required.length > given.length
    ? { ...template, args: [...given, ...required.slice(given.length)] }
    : template;
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
  syntax: StatementSyntax,
  inPlace = false
): OpResult {
  // `await` goes around the call itself: its result is the awaited value.
  const pin = inPlace ? findPin(findNode(doc, ref.node), ref.pin) : undefined;
  const bind = pin ? getMeta<OutputPinMeta>(pin).bind : undefined;
  if (bind) {
    const code = text.slice(bind.expr.start, bind.expr.end);
    return succeeded([
      {
        start: bind.expr.start,
        end: bind.expr.end,
        text: substituteValue(expression, code),
      },
    ]);
  }

  // A lone value (`item.quantity;`) is used where it stands, like a
  // wire from it: `item.quantity <= 0;`, not a second copy of it.
  const node = findNode(doc, ref.node);
  const own = node ? getMeta<StatementMeta>(node) : undefined;
  if (node && own?.unused && own.stmt) {
    const code = nodeCode(text, node);
    return succeeded([
      {
        start: node.range.start,
        end: node.range.end,
        text: substituteValue(expression, code),
      },
    ]);
  }

  const chained = chainedCall(text, doc, ref, expression);
  if (chained) {
    return succeeded([chained]);
  }

  // An unused call result is used where the call stands (`total(cart);` →
  // `` `${total(cart)} EUR`; ``): the call keeps its place in the flow and
  // feeds the new node, without a variable of its own (UE: one wire).
  const result = findPin(node, ref.pin);
  const unused = result ? getMeta<OutputPinMeta>(result).bind : undefined;
  if (unused?.isStatement) {
    const code = text.slice(unused.expr.start, unused.expr.end);
    return succeeded([
      {
        start: unused.expr.start,
        end: unused.expr.end,
        text: substituteValue(expression, code),
      },
    ]);
  }

  return afterValue(text, doc, ref, syntax, (value) => ({
    type: 'value',
    expression: substituteValue(expression, value),
  }));
}

/**
 * An op's edits plus `async` on the function around `nodeId` when it lacks
 * it and its language has the keyword (`await` needs it; GDScript doesn't).
 */
export function withAsync(
  text: string,
  doc: GraphDocument,
  nodeId: string,
  result: OpResult,
  declarations: DeclarationSyntax | undefined
): OpResult {
  const node = findNode(doc, nodeId);
  if (!result.ok || !node || !declarations) {
    return result;
  }

  const owner = (doc.symbols ?? [])
    .filter(
      (s) =>
        (s.kind === 'function' || s.kind === 'method') &&
        s.range.start <= node.range.start &&
        node.range.end <= s.range.end
    )
    .toSorted(
      (a, b) => a.range.end - a.range.start - (b.range.end - b.range.start)
    )[0];
  const kind = owner?.kind === 'method' ? 'method' : 'function';
  const flags = declarations.typeSystem.modifiers[kind]?.flags;
  if (
    !owner ||
    owner.modifiers.includes('async') ||
    !flags?.includes('async')
  ) {
    return result;
  }

  const made = setModifier(text, doc, owner.id, 'async', true, declarations);
  return made.ok ? succeeded([...result.edits, ...made.edits]) : result;
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

/**
 * The exec output into the block a value is bound in (`for (const item of
 * items)` → Loop Body, `catch (error)` → Catch), if it is bound in one.
 */
function bindingBlock(node: GraphNode, pin: Pin): Pin | undefined {
  const execOuts = node.pins.filter(
    (p) => p.kind === 'exec' && p.direction === 'out'
  );
  const visibleIn = getMeta<OutputPinMeta>(pin).visibleIn;
  if (visibleIn) {
    return execOuts.find((p) => {
      const at = getMeta<ExecOutPinMeta>(p).insert?.at;
      return at !== undefined && at >= visibleIn.start && at <= visibleIn.end;
    });
  }

  if (node.kind === 'forEach') {
    return execOuts.find((p) => p.id === 'body');
  }

  const handler = node.kind === 'try' ? /^error(\d*)$/.exec(pin.id) : null;
  return handler
    ? execOuts.find((p) => p.id === `except${handler[1]}` || p.id === 'catch')
    : undefined;
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
    // A loop item or a caught error exists only in its block: at its start.
    const block = bindingBlock(node, pin);
    const stmt = block ? undefined : producingStatement(node, pin);
    insert = block
      ? getMeta<ExecOutPinMeta>(block).insert
      : stmt
        ? afterStatement(text, stmt)
        : undefined;
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
  syntax: StatementSyntax,
  /** The key of a new object entry. */
  name?: string
): OpResult {
  const node = findNode(doc, nodeId);
  const added = node ? addPinValue(text, node, syntax, name, doc) : undefined;
  if (added) {
    return added;
  }

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

  // The first, empty pin of a `...rest` parameter (`data[0]`) is written
  // too: one more pin next to it, like UE's Make Array.
  const rest = node.pins.find(
    (p) => p.id.startsWith('param:') && !p.range && p.name.endsWith('[0]')
  );
  const meta = rest ? getMeta<InputPinMeta>(rest) : undefined;
  if (meta?.insertInitAt !== undefined) {
    const value = syntax.placeholder;
    return succeeded([
      {
        start: meta.insertInitAt,
        end: meta.insertInitAt,
        text: `${meta.insertPrefix ?? ''}${value}, ${value}`,
      },
    ]);
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
  const removed = node ? removePinValue(text, node, ref.pin) : undefined;
  if (removed) {
    return removed;
  }

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
