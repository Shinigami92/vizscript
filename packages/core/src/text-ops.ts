import { ARG_PIN, callClose } from './call-pins';
import { collapseToFunction } from './collapse';
import type { CommentSyntax } from './comment-ops';
import {
  addCommentBox,
  deleteCommentBox,
  renameCommentBox,
  setComment,
} from './comment-ops';
import type {
  ExecOutPinMeta,
  InputPinMeta,
  InsertPoint,
  OutputPinMeta,
  StatementMeta,
} from './edit-meta';
import { getMeta, owningStatement } from './edit-meta';
import { endOfFunction } from './flow';
import type {
  GraphDocument,
  GraphEdge,
  GraphNode,
  LiteralKind,
  Pin,
  PinLiteral,
  PinRef,
  SourceRange,
} from './ir';
import type { GraphOp, NodeTemplate, OpResult, TextEdit } from './ops';
import { applyTextEdits } from './ops';
import { findNode } from './reconcile';
import {
  addParameter,
  moveParameter,
  removeParameter,
  renameParameter,
  setParameterType,
  setParameterValue,
  setReturnType,
} from './signature-ops';
import type { DeclarationSyntax } from './symbol-ops';
import {
  addFunction,
  addImport,
  addSignal,
  addVariable,
  checkName,
  deleteSymbol,
  removeListItem,
  renameSymbol,
  setModifier,
  setSymbolType,
  setSymbolValue,
} from './symbol-ops';
import { qualifiedName } from './symbols';
import { lineAwareRange, lineIndent, lineStart, reindent } from './text-utils';

/**
 * The language specific bits of turning graph operations into text edits.
 * Backends describe their syntax here; the edit logic itself is shared.
 */
export interface StatementSyntax {
  /** Expression used when an input loses its value (`undefined`, `null`). */
  placeholder: string;
  /**
   * Replacement for a removed statement that must not leave its block empty
   * (inline bodies, or the only statement of an indented block).
   */
  emptyBody: string;
  /** Name for a new variable holding a value, from a hint like `fetch`. */
  bindingName: (hint: string) => string;
  /** Declares `name` with the value of `expr` as a full statement. */
  declare: (name: string, expr: string) => string;
  /** Prefix that turns an expression statement into a declaration. */
  declarePrefix: (name: string) => string;
  /** Quotes a new string value, keeping the style of the old literal. */
  quote: (value: string, literal: PinLiteral) => string;
  /** Source of a new statement, or `undefined` for invalid input. */
  template: (
    template: NodeTemplate,
    indent: string,
    indentUnit: string
  ) => string | undefined;
  /** Whether statements may be appended at the end of the file. */
  appendToFile: boolean;
  /** Boolean literals (default `true` / `false`). */
  booleans?: { true: string; false: string };
  /** Comment and region markers. */
  comment: CommentSyntax;
  /** Ends an expression statement (`;` in TypeScript). */
  statementEnd?: string;
  /**
   * An expression as a statement of its own, when it needs more than
   * `statementEnd` (TypeScript wraps `{ … }` in parentheses).
   */
  expressionStatement?: (expression: string) => string;
  /** Adding, renaming and deleting symbols ("My Script"). */
  declarations?: DeclarationSyntax;
}

/**
 * Replaces the expression of an input. Object properties keep their key:
 * `{ length }` → `{ length: value }`, and `{ length: length }` → `{ length }`.
 */
function inputEdit(pin: Pin, range: SourceRange, value: string): TextEdit {
  const { propertyKey: key, property, shorthand } = getMeta<InputPinMeta>(pin);
  if (key && shorthand && value !== key) {
    return { start: range.start, end: range.end, text: `${key}: ${value}` };
  }

  if (key && property && !shorthand && value === key) {
    return { start: property.start, end: property.end, text: key };
  }

  return { start: range.start, end: range.end, text: value };
}

function asStatement(expression: string, syntax: StatementSyntax): string {
  return (
    syntax.expressionStatement?.(expression) ??
    `${expression}${syntax.statementEnd ?? ''}`
  );
}

export function failed(error: string): OpResult {
  return { ok: false, error };
}

function succeeded(edits: TextEdit[]): OpResult {
  return { ok: true, edits };
}

function contains(outer: SourceRange, inner: SourceRange): boolean {
  return outer.start <= inner.start && inner.end <= outer.end;
}

export function findPin(
  node: GraphNode | undefined,
  pinId: string
): Pin | undefined {
  return node?.pins.find((p) => p.id === pinId);
}

function edgesOf(doc: GraphDocument, nodeId: string): GraphEdge[] {
  for (const fn of doc.functions) {
    if (fn.nodes.some((n) => n.id === nodeId)) {
      return fn.edges;
    }
  }

  return [];
}

function functionOf(doc: GraphDocument, nodeId: string): string | undefined {
  return doc.functions.find((fn) => fn.nodes.some((n) => n.id === nodeId))?.id;
}

function insertText(point: InsertPoint, snippet: string): TextEdit {
  const text =
    point.mode === 'after'
      ? `\n${point.indent}${snippet}`
      : `${snippet}\n${point.indent}`;
  return { start: point.at, end: point.at, text };
}

/** Leading whitespace of a line. */
function leadingSpace(line: string): string {
  return line.match(/^[ \t]*/)?.[0] ?? '';
}

/**
 * Code moved to another place: its lines lose their common indentation,
 * keep their nesting in the file's indent unit, and all but the first get
 * `indent` (the first line goes where the insert point puts it).
 */
export function reindentCode(
  code: string,
  indent: string,
  unit: string
): string {
  const lines = code
    .replaceAll('\r\n', '\n')
    .replace(/^(?:[ \t]*\n)+/, '')
    .trimEnd()
    .split('\n');
  const filled = lines.filter((line) => line.trim() !== '');
  const common = Math.min(...filled.map((line) => leadingSpace(line).length));
  const sourceUnit = detectIndentUnit(lines.join('\n'));
  return lines
    .map((line, i) => {
      if (line.trim() === '') {
        return '';
      }

      const relative = leadingSpace(line).slice(
        Number.isFinite(common) ? common : 0
      );
      const levels = relative.split(sourceUnit).length - 1;
      const rest = relative.slice(levels * sourceUnit.length);
      return `${i === 0 ? '' : indent}${unit.repeat(levels)}${rest}${line.trimStart()}`;
    })
    .join('\n');
}

/** A template's code: pasted code as is, the others from the language. */
function templateSnippet(
  syntax: StatementSyntax,
  template: NodeTemplate,
  indent: string,
  unit: string
): string | undefined {
  return template.type === 'code'
    ? reindentCode(template.code, indent, unit)
    : syntax.template(template, indent, unit);
}

/** Indentation step of a file: a tab, or the smallest space indent. */
export function detectIndentUnit(text: string): string {
  let smallest = Number.POSITIVE_INFINITY;
  for (const line of text.split('\n')) {
    if (line.startsWith('\t')) {
      return '\t';
    }

    const spaces = line.length - line.trimStart().length;
    if (spaces > 0 && line.trim() !== '') {
      smallest = Math.min(smallest, spaces);
    }
  }

  return Number.isFinite(smallest) ? ' '.repeat(smallest) : '  ';
}

/** Removal (or placeholder) edit for a whole statement. */
function removeStatement(
  text: string,
  meta: Partial<StatementMeta> & { stmt: SourceRange },
  syntax: StatementSyntax
): TextEdit {
  if (meta.inline || meta.sole) {
    return {
      start: meta.stmt.start,
      end: meta.stmt.end,
      text: syntax.emptyBody,
    };
  }

  const [start, end] = lineAwareRange(text, meta.stmt.start, meta.stmt.end);
  return { start, end, text: '' };
}

// ------------------------------------------------------------------ ops

function sameRange(a: SourceRange, b: SourceRange): boolean {
  return a.start === b.start && a.end === b.end;
}

/**
 * Calls (and awaits) computed inside a statement that are not deleted with
 * it: `return fetch(url)` without the return keeps `fetch(url);`.
 */
function keptCalls(
  doc: GraphDocument,
  statementNode: GraphNode,
  stmt: SourceRange,
  deleted: ReadonlySet<string>
): GraphNode[] {
  const fn = doc.functions.find((f) => f.nodes.includes(statementNode));
  const candidates = (fn?.nodes ?? []).filter((n) => {
    if (
      n === statementNode ||
      deleted.has(n.id) ||
      n.purity !== 'impure' ||
      n.kind === 'entry' ||
      getMeta<StatementMeta>(n).stmt
    ) {
      return false;
    }

    const owner = owningStatement(n);
    return owner !== undefined && sameRange(owner.stmt, stmt);
  });
  // Only the outermost: `await fetch(url)` keeps the await with its call.
  return candidates
    .filter(
      (n) =>
        !candidates.some(
          (other) =>
            other !== n &&
            contains(other.range, n.range) &&
            !sameRange(other.range, n.range)
        )
    )
    .toSorted((a, b) => a.range.start - b.range.start);
}

/** The input whose whole expression is this node, if any. */
function consumerInput(doc: GraphDocument, node: GraphNode): Pin | undefined {
  for (const edge of edgesOf(doc, node.id)) {
    if (edge.from.node !== node.id) {
      continue;
    }

    const pin = findPin(findNode(doc, edge.to.node), edge.to.pin);
    if (pin?.range && sameRange(pin.range, node.range)) {
      return pin;
    }
  }

  return undefined;
}

/** Longest run of blank lines between two lines of a text. */
function longestBlankRun(text: string): number {
  let longest = 0;
  for (const run of text.matchAll(/\n((?:[ \t]*\n)+)/g)) {
    longest = Math.max(longest, (run[1] ?? '').split('\n').length - 1);
  }

  return longest;
}

/**
 * Deleting several statements leaves the blank lines that separated them:
 * runs of blank lines longer than any in the file before, and blank lines
 * added at its end, shrink again. One edit from the first to the last change.
 */
function tidyBlankLines(text: string, result: OpResult): OpResult {
  if (!result.ok || result.edits.length === 0) {
    return result;
  }

  const edited = applyTextEdits(text, result.edits);
  const longest = longestBlankRun(text);
  const ending = text.match(/\n*$/)?.[0] ?? '';
  let tidy = edited.replaceAll(/\n((?:[ \t]*\n)+)/g, (whole, run: string) =>
    run.split('\n').length - 1 > longest ? `\n${'\n'.repeat(longest)}` : whole
  );
  const trailing = tidy.match(/\n*$/)?.[0] ?? '';
  if (trailing.length > ending.length) {
    tidy = tidy.slice(0, tidy.length - trailing.length) + ending;
  }
  if (tidy === edited) {
    return result;
  }

  let start = 0;
  while (
    start < text.length &&
    start < tidy.length &&
    text[start] === tidy[start]
  ) {
    start++;
  }

  let end = 0;
  while (
    end < text.length - start &&
    end < tidy.length - start &&
    text[text.length - 1 - end] === tidy[tidy.length - 1 - end]
  ) {
    end++;
  }

  return succeeded([
    {
      start,
      end: text.length - end,
      text: tidy.slice(start, tidy.length - end),
    },
  ]);
}

function deleteNodes(
  text: string,
  doc: GraphDocument,
  ids: ReadonlyArray<string>,
  syntax: StatementSyntax
): OpResult {
  const targets: Array<{ range: SourceRange; edit: TextEdit }> = [];
  const deleted = new Set(ids);
  let locked = false;
  for (const id of ids) {
    const node = findNode(doc, id);
    if (!node || node.kind === 'entry') {
      continue;
    }

    const meta = getMeta<StatementMeta>(node);
    if (meta.locked) {
      locked = true;
      continue;
    }

    if (meta.stmt) {
      const kept = keptCalls(doc, node, meta.stmt, deleted);
      if (kept.length > 0 && !(meta.inline && kept.length > 1)) {
        const indent = lineIndent(text, meta.stmt.start);
        targets.push({
          range: meta.stmt,
          edit: {
            start: meta.stmt.start,
            end: meta.stmt.end,
            text: kept
              .map((n) =>
                asStatement(text.slice(n.range.start, n.range.end), syntax)
              )
              .join(`\n${indent}`),
          },
        });
        continue;
      }

      const edit = removeStatement(text, { ...meta, stmt: meta.stmt }, syntax);
      // The comment above a removed statement goes with it.
      const comment = node.comment?.range;
      targets.push({
        range: meta.stmt,
        edit:
          comment && edit.text === '' && comment.end === edit.start
            ? { ...edit, start: comment.start }
            : edit,
      });
      continue;
    }

    // A value node leaves an empty input behind (keeping a property key).
    const input = consumerInput(doc, node);
    targets.push({
      range: node.range,
      edit: input
        ? inputEdit(input, node.range, syntax.placeholder)
        : {
            start: node.range.start,
            end: node.range.end,
            text: syntax.placeholder,
          },
    });
  }

  if (targets.length === 0) {
    return failed(
      locked
        ? 'This node is part of a larger statement; delete that statement instead.'
        : 'Nothing to delete (entry nodes cannot be deleted).'
    );
  }

  // Drop targets nested in other targets (e.g. a call inside a deleted statement).
  const sorted = targets.toSorted(
    (a, b) => a.range.start - b.range.start || b.range.end - a.range.end
  );
  const kept: typeof sorted = [];
  for (const target of sorted) {
    if (kept.some((k) => contains(k.range, target.range))) {
      continue;
    }

    kept.push(target);
  }

  return succeeded(kept.map((k) => k.edit));
}

/** Words that are values in every supported language. */
const VALUE_WORDS = new Set([
  'true',
  'false',
  'null',
  'undefined',
  'None',
  'True',
  'False',
  'NaN',
  'Infinity',
]);

/** Globals of the supported languages that typed code often starts with. */
const KNOWN_GLOBALS = new Set([
  'Math',
  'JSON',
  'console',
  'String',
  'Number',
  'Boolean',
  'Array',
  'Object',
  'Date',
  'Promise',
  'globalThis',
  'window',
  'document',
  'this',
  'self',
  'len',
  'str',
  'int',
  'float',
  'bool',
  'list',
  'dict',
  'range',
  'print',
  'Vector2',
  'Vector3',
  'Color',
]);

/**
 * Whether a typed value is code rather than text: a number, a quoted
 * string, `[…]` / `{…}` / `(…)`, or something that starts with a name the
 * script knows (`user`, `count + 1`, `greet(user)`, `Math.max(a, b)`).
 * `Jane User`, `Hello, ` or `Hello!` are text.
 */
export function looksLikeCode(value: string, doc: GraphDocument): boolean {
  if (/^[-+]?(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i.test(value)) {
    return true;
  }

  if (VALUE_WORDS.has(value) || /^["'`[{(]/.test(value)) {
    return true;
  }

  const leading = value.match(/^-?([A-Za-z_$][\w$]*)/)?.[1];
  if (!leading) {
    return false;
  }

  const known = new Set<string>(KNOWN_GLOBALS);
  for (const symbol of doc.symbols ?? []) {
    known.add(symbol.name);
    for (const param of symbol.params ?? []) {
      known.add(param.name);
    }
  }

  return known.has(leading);
}

/** Source of a value typed into a pin that has no code yet. */
function literalSource(
  value: string,
  kind: LiteralKind,
  doc: GraphDocument,
  syntax: StatementSyntax
): string | { error: string } {
  const trimmed = value.trim();
  if (trimmed === '') {
    return { error: 'Value must not be empty.' };
  }

  switch (kind) {
    case 'string':
    case 'template': {
      return syntax.declarations?.string(value) ?? JSON.stringify(value);
    }

    case 'number': {
      return Number.isNaN(Number(trimmed.replaceAll('_', '')))
        ? { error: `"${value}" is not a number.` }
        : trimmed;
    }

    case 'boolean': {
      const words = syntax.booleans ?? { true: 'true', false: 'false' };
      const normalized = trimmed.toLowerCase();
      return normalized === 'true' || normalized === 'false'
        ? words[normalized]
        : { error: `A boolean must be ${words.true} or ${words.false}.` };
    }

    default: {
      return looksLikeCode(trimmed, doc)
        ? trimmed
        : (syntax.declarations?.string(value) ?? JSON.stringify(value));
    }
  }
}

function setLiteral(
  doc: GraphDocument,
  nodeId: string,
  pinId: string,
  value: string,
  syntax: StatementSyntax
): OpResult {
  const pin = findPin(findNode(doc, nodeId), pinId);
  const insert = pin ? getMeta<InputPinMeta>(pin) : undefined;
  if (pin?.literal && !pin.range && insert?.insertInitAt !== undefined) {
    // A missing argument: its value is inserted (UE: a pin's default box).
    const source = literalSource(value, pin.literal.kind, doc, syntax);
    if (typeof source !== 'string') {
      return failed(source.error);
    }

    return succeeded([
      {
        start: insert.insertInitAt,
        end: insert.insertInitAt,
        text: `${insert.insertPrefix ?? ' = '}${source}`,
      },
    ]);
  }

  if (!pin?.literal || !pin.range) {
    return failed('This pin has no editable value.');
  }

  const literal = pin.literal;
  let replacement: string;
  switch (literal.kind) {
    case 'string':
    case 'template': {
      replacement = syntax.quote(value, literal);
      break;
    }

    case 'number': {
      const trimmed = value.trim();
      if (trimmed === '' || Number.isNaN(Number(trimmed.replaceAll('_', '')))) {
        return failed(`"${value}" is not a number.`);
      }

      replacement = trimmed;
      break;
    }

    case 'boolean': {
      const words = syntax.booleans ?? { true: 'true', false: 'false' };
      const normalized = value.trim().toLowerCase();
      if (normalized !== 'true' && normalized !== 'false') {
        return failed(`A boolean must be ${words.true} or ${words.false}.`);
      }

      replacement = normalized === 'true' ? words.true : words.false;
      break;
    }

    default: {
      if (value.trim() === '') {
        return failed('Value must not be empty.');
      }

      // A placeholder (`undefined`, `None`) has no type yet: plain text is
      // a string, like UE's text box; code stays code.
      replacement =
        (literal.kind === 'undefined' || literal.kind === 'null') &&
        !looksLikeCode(value.trim(), doc)
          ? (syntax.declarations?.string(value) ?? JSON.stringify(value))
          : value.trim();
    }
  }

  return succeeded([inputEdit(pin, pin.range, replacement)]);
}

/** Text that references the value of a data output, plus required edits. */
function referenceOutput(
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

function moveWires(
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

function connectData(
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

function connectExec(
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

function disconnect(
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
function disconnectNode(
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

/** `name`, `this.name`, `ns.fn`. */
const NAME_PATH = /^[A-Za-z_$#][\w$]*(?:\.[A-Za-z_$#][\w$]*)*$/;

/** The variable of a Get / Set or the function of a call, as written. */
export function referenceName(node: GraphNode): string | undefined {
  const name =
    node.kind === 'getVar' || node.kind === 'call'
      ? node.title
      : node.kind === 'setVar'
        ? node.title.replace(/^Set /, '')
        : undefined;
  return name && NAME_PATH.test(name) ? name : undefined;
}

function replaceReference(
  text: string,
  doc: GraphDocument,
  nodeId: string,
  name: string
): OpResult {
  const node = findNode(doc, nodeId);
  const current = node ? referenceName(node) : undefined;
  if (!node || !current) {
    return failed('Only Get, Set and call nodes can be replaced.');
  }

  if (!NAME_PATH.test(name)) {
    return failed('Enter a name.');
  }

  // The name is where the node's code starts: `x`, `x = …`, `fn(…)`.
  const at = node.range.start;
  if (
    text.slice(at, at + current.length) !== current ||
    /[\w$]/.test(text.charAt(at + current.length))
  ) {
    return failed(
      node.kind === 'setVar'
        ? 'A declaration cannot point to another variable; rename it instead.'
        : 'Cannot find the name of this node in the code.'
    );
  }

  return succeeded([{ start: at, end: at + current.length, text: name }]);
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** Insert point right after the statement with the given range. */
function afterStatement(text: string, stmt: SourceRange): InsertPoint {
  return { at: stmt.end, indent: lineIndent(text, stmt.start), mode: 'after' };
}

function addNode(
  text: string,
  doc: GraphDocument,
  template: NodeTemplate,
  anchor: { after?: PinRef; before?: PinRef },
  syntax: StatementSyntax
): OpResult {
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

  return succeeded([insertText(insert, snippet)]);
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

function setInput(
  doc: GraphDocument,
  ref: PinRef,
  expression: string
): OpResult {
  const pin = findPin(findNode(doc, ref.node), ref.pin);
  if (!pin || pin.kind !== 'data' || pin.direction !== 'in') {
    return failed('Only data inputs can be given a value.');
  }

  const value = expression.trim();
  if (!value || value.includes('\n')) {
    return failed('Enter a single-line expression.');
  }

  if (pin.range) {
    return succeeded([inputEdit(pin, pin.range, value)]);
  }

  const meta = getMeta<InputPinMeta>(pin);
  if (meta.insertInitAt !== undefined) {
    return succeeded([
      {
        start: meta.insertInitAt,
        end: meta.insertInitAt,
        text: `${meta.insertPrefix ?? ' = '}${value}`,
      },
    ]);
  }

  return failed('This input cannot be given a value.');
}

/** The statement a data output belongs to (where its value exists). */
function producingStatement(
  node: GraphNode,
  pin: Pin
): SourceRange | undefined {
  const meta = getMeta<OutputPinMeta>(pin);
  return meta.bind?.stmt ?? getMeta<StatementMeta>(node).stmt ?? meta.scope;
}

function promote(
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
function extract(
  text: string,
  doc: GraphDocument,
  ref: PinRef,
  name: string,
  syntax: StatementSyntax
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

  if (!pin.range || pin.range.end <= pin.range.start) {
    return failed('This input has no value to extract.');
  }

  const owner = owningStatement(node);
  if (!owner || owner.meta.inline || owner.meta.locked) {
    return failed('There is no place for a variable before this node.');
  }

  const { stmt } = owner;
  const expression = text.slice(pin.range.start, pin.range.end);
  return succeeded([
    {
      start: stmt.start,
      end: stmt.start,
      text: `${syntax.declare(variable, expression)}\n${lineIndent(text, stmt.start)}`,
    },
    inputEdit(pin, pin.range, variable),
  ]);
}

function callWith(
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
function useValue(
  text: string,
  doc: GraphDocument,
  ref: PinRef,
  expression: string,
  syntax: StatementSyntax
): OpResult {
  return afterValue(text, doc, ref, syntax, (value) => ({
    type: 'value',
    expression: expression.replaceAll('$value', value),
  }));
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

  return succeeded([...reference.edits, insertText(insert, snippet)]);
}

/**
 * Adds an argument to a call (UE: "Add pin"): a placeholder that shows as
 * a new input pin to wire or fill in.
 */
function addArgument(
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
function removeArgument(
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

const NO_RESULT = new Set(['void', 'None', 'undefined', 'null', 'never']);

/**
 * Like UE adds a Return node with the first output: a function that gets a
 * result type but has no `return` gets one at the end of its flow, in the
 * same edit.
 */
function withReturnNode(
  text: string,
  doc: GraphDocument,
  symbolId: string,
  typeText: string | null,
  result: OpResult,
  syntax: StatementSyntax
): OpResult {
  const type = typeText?.trim() ?? '';
  const fnId = doc.symbols?.find((s) => s.id === symbolId)?.fnId;
  const fn = doc.functions.find((f) => f.id === fnId);
  if (
    !result.ok ||
    type === '' ||
    NO_RESULT.has(type) ||
    !fn ||
    fn.nodes.some((n) => n.kind === 'return')
  ) {
    return result;
  }

  const anchor = endOfFunction(doc, fn.id);
  const added = anchor
    ? addNode(text, doc, { type: 'return' }, anchor, syntax)
    : undefined;
  return added?.ok ? succeeded([...result.edits, ...added.edits]) : result;
}

/** Ops of "My Script": add, rename and delete declarations. */
function applySymbolOp(
  text: string,
  doc: GraphDocument,
  op: Extract<
    GraphOp,
    {
      type:
        | 'addFunction'
        | 'addVariable'
        | 'addSignal'
        | 'renameSymbol'
        | 'deleteSymbol'
        | 'setSymbolType'
        | 'setSymbolValue'
        | 'setModifier'
        | 'addParameter'
        | 'removeParameter'
        | 'moveParameter'
        | 'renameParameter'
        | 'setParameterType'
        | 'setParameterValue'
        | 'setReturnType';
    }
  >,
  syntax: StatementSyntax
): OpResult {
  const declarations = syntax.declarations;
  if (!declarations) {
    return failed('This language cannot add or rename declarations yet.');
  }

  const unit = /\S/.test(text)
    ? detectIndentUnit(text)
    : declarations.defaultIndent;
  switch (op.type) {
    case 'addFunction': {
      return addFunction(text, doc, op.scope, op.name, unit, declarations);
    }

    case 'addVariable': {
      if (op.local) {
        return addLocal(text, doc, op.scope, op.name, syntax);
      }

      return addVariable(
        text,
        doc,
        op.scope,
        op.name,
        op.constant ?? false,
        unit,
        declarations
      );
    }

    case 'addSignal': {
      return addSignal(text, doc, op.name, declarations);
    }

    case 'renameSymbol': {
      return renameSymbol(text, doc, op.symbol, op.name, declarations);
    }

    case 'setSymbolType': {
      return setSymbolType(
        text,
        doc,
        op.symbol,
        op.typeText,
        declarations,
        op.defaultValue
      );
    }

    case 'setSymbolValue': {
      return setSymbolValue(
        text,
        doc,
        op.symbol,
        op.value,
        op.kind,
        declarations
      );
    }

    case 'addParameter': {
      return addParameter(
        text,
        doc,
        op.symbol,
        op.name,
        op.typeText,
        op.argument,
        syntax.placeholder,
        declarations
      );
    }

    case 'removeParameter': {
      return removeParameter(text, doc, op.symbol, op.index, declarations);
    }

    case 'moveParameter': {
      return moveParameter(text, doc, op.symbol, op.from, op.to, declarations);
    }

    case 'renameParameter': {
      return renameParameter(
        text,
        doc,
        op.symbol,
        op.index,
        op.name,
        declarations
      );
    }

    case 'setParameterType': {
      return setParameterType(
        text,
        doc,
        op.symbol,
        op.index,
        op.typeText,
        declarations
      );
    }

    case 'setParameterValue': {
      return setParameterValue(
        text,
        doc,
        op.symbol,
        op.index,
        op.value,
        op.kind,
        declarations
      );
    }

    case 'setReturnType': {
      return withReturnNode(
        text,
        doc,
        op.symbol,
        op.typeText,
        setReturnType(text, doc, op.symbol, op.typeText, declarations),
        syntax
      );
    }

    case 'setModifier': {
      return setModifier(
        text,
        doc,
        op.symbol,
        op.modifier,
        op.enabled,
        declarations
      );
    }

    case 'deleteSymbol': {
      return deleteSymbol(
        text,
        doc,
        op.symbol,
        syntax.comment,
        syntax.emptyBody
      );
    }
  }
}

/** A local variable: a declaration at the start of the function body. */
function addLocal(
  text: string,
  doc: GraphDocument,
  fnName: string,
  name: string,
  syntax: StatementSyntax
): OpResult {
  const declarations = syntax.declarations;
  const fn = doc.symbols?.find(
    (s) =>
      (s.kind === 'function' || s.kind === 'method') &&
      qualifiedName(s) === fnName
  );
  const entry = doc.functions
    .find((f) => f.id === fn?.fnId)
    ?.nodes.find((n) => n.kind === 'entry');
  if (!fn || !entry || !declarations) {
    return failed(`There is no function ${fnName}.`);
  }

  const error = checkName(doc, declarations, fnName, name);
  if (error) {
    return failed(error);
  }

  return addNode(
    text,
    doc,
    { type: 'setVar', name, declaration: 'let' },
    { after: { node: entry.id, pin: 'then' } },
    syntax
  );
}

/**
 * Turns a graph operation into minimal text edits, using the statement and
 * pin metadata produced by a backend's lowering (see `edit-meta.ts`).
 */
export function applyTextOp(
  text: string,
  doc: GraphDocument,
  op: GraphOp,
  syntax: StatementSyntax
): OpResult {
  switch (op.type) {
    case 'withImport': {
      // One edit (one undo step): the import and what uses the name.
      const imported = addImport(text, doc, op.import, syntax.declarations);
      if (!imported.ok) {
        return imported;
      }

      const used = applyTextOp(text, doc, op.op, syntax);
      return used.ok
        ? { ok: true, edits: [...imported.edits, ...used.edits] }
        : used;
    }

    case 'deleteNodes': {
      return tidyBlankLines(text, deleteNodes(text, doc, op.nodeIds, syntax));
    }

    case 'setLiteral': {
      return setLiteral(doc, op.node, op.pin, op.value, syntax);
    }

    case 'connect': {
      const fromPin = findPin(findNode(doc, op.from.node), op.from.pin);
      if (!fromPin) {
        return failed('Unknown source pin.');
      }

      return fromPin.kind === 'exec'
        ? connectExec(text, doc, op.from, op.to, syntax)
        : connectData(text, doc, op.from, op.to, syntax);
    }

    case 'disconnect': {
      return disconnect(text, doc, op.pin, syntax);
    }

    case 'disconnectNode': {
      return disconnectNode(text, doc, op.node, syntax);
    }

    case 'replaceReference': {
      return replaceReference(text, doc, op.node, op.name);
    }

    case 'moveWires': {
      return moveWires(text, doc, op.from, op.to, syntax);
    }

    case 'setSymbolGroup': {
      const set = syntax.declarations?.setSymbolGroup;
      const symbol = doc.symbols?.find((s) => s.id === op.symbol);
      if (!symbol) {
        return failed('Unknown symbol.');
      }

      return set
        ? set(text, doc, symbol, op.group)
        : failed('This language has no categories.');
    }

    case 'setScriptSetting': {
      const set = syntax.declarations?.setScriptSetting;
      return set
        ? set(text, doc, op.setting, op.value)
        : failed('This language has no script settings.');
    }

    case 'collapseToFunction': {
      return collapseToFunction(
        text,
        doc,
        op.nodes,
        op.name,
        detectIndentUnit(text),
        syntax.declarations
      );
    }

    case 'addNode': {
      return addNode(
        text,
        doc,
        op.template,
        { after: op.after, before: op.before },
        syntax
      );
    }

    case 'setInput': {
      return setInput(doc, op.pin, op.expression);
    }

    case 'extract': {
      return extract(text, doc, op.pin, op.name, syntax);
    }

    case 'promote': {
      return promote(text, doc, op.pin, op.name, syntax);
    }

    case 'callWith': {
      return callWith(text, doc, op.pin, op.callee, syntax);
    }

    case 'setComment': {
      return setComment(
        text,
        doc,
        op.node,
        op.text,
        syntax.comment,
        op.doc === true
      );
    }

    case 'addCommentBox': {
      return addCommentBox(text, doc, op.nodes, op.title, syntax.comment);
    }

    case 'renameCommentBox': {
      return renameCommentBox(doc, op.box, op.title);
    }

    case 'deleteCommentBox': {
      return deleteCommentBox(text, doc, op.box);
    }

    case 'useValue': {
      return useValue(text, doc, op.pin, op.expression, syntax);
    }

    case 'addArgument': {
      return addArgument(text, doc, op.node, syntax);
    }

    case 'removeArgument': {
      return removeArgument(text, doc, op.pin);
    }

    default: {
      return applySymbolOp(text, doc, op, syntax);
    }
  }
}
