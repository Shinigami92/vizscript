import { collapseToFunction } from './collapse';
import type { CommentSyntax } from './comment-ops';
import {
  addCommentBox,
  deleteCommentBox,
  renameCommentBox,
  setComment,
} from './comment-ops';
import type { DeclarationSyntax } from './declaration-syntax';
import {
  deleteNodes,
  tidyBlankLines,
  withEmptiedBoxes,
  withoutDoubleBlankLines,
} from './delete-ops';
import { endOfFunction } from './flow';
import {
  addArgument,
  addNode,
  callWith,
  extract,
  promote,
  removeArgument,
  useValue,
} from './insert-ops';
import type { GraphDocument, PinLiteral } from './ir';
import { setInput, setLiteral } from './literal-ops';
import { failed, succeeded } from './op-result';
import type { GraphOp, NodeTemplate, OpResult, TextEdit } from './ops';
import { findNode } from './reconcile';
import { replaceReference, setAssignOperator } from './reference-ops';
import {
  addParameter,
  moveParameter,
  removeParameter,
  renameParameter,
  setParameterType,
  setParameterValue,
  setReturnType,
} from './signature-ops';
import {
  deleteSymbol,
  renameSymbol,
  setModifier,
  setSymbolType,
  setSymbolValue,
} from './symbol-edits';
import {
  addFunction,
  addImport,
  addSignal,
  addType,
  addVariable,
  checkName,
} from './symbol-ops';
import { qualifiedName } from './symbols';
import { detectIndentUnit, findPin } from './text-op-helpers';
import {
  clearArguments,
  connectData,
  connectExec,
  disconnect,
  disconnectNode,
  moveWires,
} from './wire-ops';

export { failed } from './op-result';
export { detectIndentUnit, findPin, reindentCode } from './text-op-helpers';
export { looksLikeCode } from './literal-ops';
export { ASSIGN_OPERATORS, referenceName } from './reference-ops';

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
  /**
   * Writes a number typed into a pin; `previous` is the literal it replaces
   * (Rust keeps a float a float: `1.0` → `2` writes `2.0`).
   */
  number?: (value: string, previous: string) => string;
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
    ? addNode(text, doc, { type: 'return', value: true }, anchor, syntax)
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
        | 'addType'
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

  // The file's indentation, or the language's while nothing is indented.
  const unit = /^[ \t]+\S/m.test(text)
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

    case 'addType': {
      return addType(text, doc, op.name, unit, declarations);
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
  return withoutPlaceholderBodies(
    text,
    applyTextOpEdits(text, doc, op, syntax),
    syntax
  );
}

/** Width of a line's indentation. */
function indentOf(line: string): number {
  return /^[ \t]*/.exec(line)?.[0].length ?? 0;
}

/**
 * Code inserted into an indented block whose only line is the empty body
 * (`pass` in Python and GDScript) replaces it: the placeholder isn't needed
 * once the block has code.
 */
function withoutPlaceholderBodies(
  text: string,
  result: OpResult,
  syntax: StatementSyntax
): OpResult {
  if (!result.ok || !/^\w+$/.test(syntax.emptyBody)) {
    return result;
  }

  const lines: Array<{ start: number; end: number; text: string }> = [];
  for (let start = 0; start <= text.length;) {
    const newline = text.indexOf('\n', start);
    const end = newline === -1 ? text.length : newline;
    lines.push({ start, end, text: text.slice(start, end) });
    if (newline === -1) {
      break;
    }

    start = newline + 1;
  }

  const isCode = (line: string): boolean => {
    const trimmed = line.trim();
    return trimmed !== '' && !trimmed.startsWith(syntax.comment.line);
  };
  const removals: TextEdit[] = [];
  for (const edit of result.edits) {
    const inserted = /\n([ \t]*)\S/.exec(edit.text);
    if (edit.start !== edit.end || !inserted) {
      continue;
    }

    // The next code line after the insertion: a lone `pass` of the block.
    const index = lines.findIndex(
      (l) => l.start > edit.start && isCode(l.text)
    );
    const line = lines[index];
    if (
      !line ||
      line.text.trim() !== syntax.emptyBody ||
      indentOf(line.text) !== (inserted[1] ?? '').length
    ) {
      continue;
    }

    const next = lines
      .slice(index + 1)
      .find((l) => isCode(l.text) && indentOf(l.text) >= indentOf(line.text));
    const sameBlock =
      next !== undefined &&
      indentOf(next.text) === indentOf(line.text) &&
      lines
        .slice(index + 1, lines.indexOf(next))
        .every(
          (l) => !isCode(l.text) || indentOf(l.text) > indentOf(line.text)
        );
    const removal = {
      start: line.start,
      end: Math.min(line.end + 1, text.length),
      text: '',
    };
    const overlaps = [...result.edits, ...removals].some(
      (e) => e.start < removal.end && removal.start < e.end
    );
    if (!sameBlock && !overlaps) {
      removals.push(removal);
    }
  }

  return removals.length > 0
    ? { ok: true, edits: [...result.edits, ...removals] }
    : result;
}

function applyTextOpEdits(
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

      const used = applyTextOpEdits(text, doc, op.op, syntax);
      return used.ok
        ? { ok: true, edits: [...imported.edits, ...used.edits] }
        : used;
    }

    case 'deleteNodes': {
      return tidyBlankLines(
        text,
        withEmptiedBoxes(
          text,
          doc,
          op.nodeIds,
          deleteNodes(text, doc, op.nodeIds, syntax)
        )
      );
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
        ? withoutDoubleBlankLines(
            text,
            connectExec(text, doc, op.from, op.to, syntax)
          )
        : connectData(text, doc, op.from, op.to, syntax, op.convert);
    }

    case 'disconnect': {
      return disconnect(text, doc, op.pin, syntax);
    }

    case 'disconnectNode': {
      return disconnectNode(text, doc, op.node, syntax);
    }

    case 'setAssignOperator': {
      return setAssignOperator(text, doc, op.node, op.operator);
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
      return extract(text, doc, op.pin, op.name, syntax, op.value);
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

    case 'clearArguments': {
      return clearArguments(text, doc, op.node, syntax);
    }

    default: {
      return applySymbolOp(text, doc, op, syntax);
    }
  }
}
