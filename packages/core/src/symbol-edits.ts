import type { CommentSyntax } from './comment-ops';
import type { DeclarationSyntax } from './declaration-syntax';
import type { GraphDocument, SourceRange } from './ir';
import { failed, succeeded } from './op-result';
import type { OpResult, TextEdit, ValueKind } from './ops';
import { findSymbol, isBlank, lineEndOf } from './symbol-helpers';
import { checkName, classOf } from './symbol-ops';
import type { ScriptSymbol } from './symbols';
import { lineIndent, lineStart } from './text-utils';

/** Comment lines directly above `offset` (they belong to the declaration). */
function leadingComments(
  text: string,
  offset: number,
  comment: CommentSyntax
): number {
  let start = lineStart(text, offset);
  while (start > 0) {
    const previous = lineStart(text, start - 1);
    const line = text.slice(previous, start - 1).trim();
    const isComment =
      line.startsWith(comment.line) ||
      line.startsWith('/*') ||
      line.startsWith('*') ||
      line.endsWith('*/');
    if (!isComment || line.startsWith(comment.endRegion)) {
      break;
    }

    start = previous;
  }

  return start;
}

/**
 * Removes one item of a comma-separated list (`b` of `import { a, b }`),
 * with its comma; an item alone in braces takes the braces and the comma
 * before them (`import a, { b }` becomes `import a`).
 */
export function removeListItem(
  text: string,
  range: SourceRange,
  /** Parameters: `f(a)` keeps its `()` when `a` goes. */
  keepBrackets = false
): TextEdit {
  let { start, end } = range;
  const after = text.slice(end).match(/^\s*,[ \t]*/)?.[0];
  const before = text.slice(0, start).match(/,\s*$/)?.[0];
  if (after) {
    end += after.length;
  } else if (before) {
    start -= before.length;
  } else if (!keepBrackets) {
    const open = text.slice(0, start).match(/[{(]\s*$/)?.[0];
    const close = text.slice(end).match(/^\s*[})]/)?.[0];
    if (open && close) {
      start -= open.length;
      end += close.length;
      start -= text.slice(0, start).match(/,\s*$/)?.[0].length ?? 0;
    }
  }

  return { start, end, text: '' };
}

export function deleteSymbol(
  text: string,
  doc: GraphDocument,
  id: string,
  comment: CommentSyntax,
  emptyBody: string
): OpResult {
  const symbol = findSymbol(doc, id);
  if (!symbol) {
    return failed('Unknown symbol.');
  }

  const shared = symbol.declarationRange;
  const together = shared
    ? (doc.symbols ?? []).filter(
        (s) => s !== symbol && s.declarationRange?.start === shared.start
      )
    : [];
  // One name of an import list, one parameter property of a constructor.
  if (
    (together.length > 0 && symbol.kind === 'import') ||
    symbol.modifiers.includes('constructor')
  ) {
    return succeeded([
      removeListItem(
        text,
        symbol.range,
        symbol.modifiers.includes('constructor')
      ),
    ]);
  }

  if (together.length > 0) {
    return failed(
      `${symbol.name} is declared together with ${together.map((s) => s.name).join(', ')}; change it in the code.`
    );
  }

  const range: SourceRange = shared ?? symbol.range;
  const lineEnd = lineEndOf(text, Math.max(range.end - 1, range.start));
  const before = text.slice(lineStart(text, range.start), range.start).trim();
  const after = text.slice(range.end, lineEnd).replace(/^\s*;/, '').trim();
  if (before !== '' || after !== '') {
    // Shares its line with other code: remove just the declaration.
    return succeeded([{ start: range.start, end: range.end, text: '' }]);
  }

  let start = leadingComments(text, range.start, comment);
  let end = Math.min(lineEnd + 1, text.length);

  // Keep the blank lines of one side only (no doubled gap).
  const linesAbove = text.slice(0, start).split('\n').slice(0, -1);
  let blankAbove = 0;
  while (isBlank(linesAbove.at(-1 - blankAbove))) {
    blankAbove++;
  }

  // At the top of the file or a block, all blank lines below go too.
  const opensBlock = /\{\s*$/.test(text.slice(0, start));
  const limit =
    linesAbove.length === blankAbove || opensBlock
      ? Number.POSITIVE_INFINITY
      : blankAbove;
  for (
    let removed = 0;
    removed < limit &&
    end < text.length &&
    isBlank(text.slice(end, lineEndOf(text, end)));
    removed++
  ) {
    end = Math.min(lineEndOf(text, end) + 1, text.length);
  }

  // The last member of a block: its blank lines above go too.
  if (!opensBlock && /^\s*\}/.test(text.slice(end))) {
    for (let i = 0; i < blankAbove; i++) {
      start = lineStart(text, start - 1);
    }
  }

  // An indented block must keep a statement (Python, GDScript).
  if (emptyBody === 'pass') {
    const indent = lineIndent(text, range.start);
    const previousCode = text
      .slice(0, start)
      .split('\n')
      .findLast((l) => l.trim() !== '' && !l.trim().startsWith(comment.line));
    const nextCode = text
      .slice(end)
      .split('\n')
      .find((l) => l.trim() !== '' && !l.trim().startsWith(comment.line));
    const nextIndent = nextCode
      ? nextCode.length - nextCode.trimStart().length
      : 0;
    if (
      previousCode?.trimEnd().endsWith(':') &&
      indent.length > 0 &&
      nextIndent < indent.length
    ) {
      return succeeded([{ start, end, text: `${indent}${emptyBody}\n` }]);
    }
  }

  return succeeded([{ start, end, text: '' }]);
}

export function renameSymbol(
  text: string,
  doc: GraphDocument,
  id: string,
  name: string,
  syntax: DeclarationSyntax
): OpResult {
  const symbol = findSymbol(doc, id);
  if (!symbol) {
    return failed('Unknown symbol.');
  }

  if (symbol.name === name) {
    return succeeded([]);
  }

  if (symbol.kind === 'import') {
    return failed('Imports are renamed in the code for now.');
  }

  const error = checkName(doc, syntax, symbol.scope, name, symbol);
  return error ? failed(error) : syntax.rename(text, doc, symbol, name);
}

const TYPED_KINDS = new Set(['variable', 'constant', 'local']);

/** End of a name, after TypeScript's `?` / `!` markers. */
function afterName(text: string, symbol: ScriptSymbol): number {
  let end = symbol.nameRange.end;
  while (text[end] === '?' || text[end] === '!') {
    end++;
  }

  return end;
}

function typedSymbol(doc: GraphDocument, id: string): ScriptSymbol | string {
  const symbol = findSymbol(doc, id);
  if (!symbol) {
    return 'Unknown symbol.';
  }

  return TYPED_KINDS.has(symbol.kind)
    ? symbol
    : `${symbol.name} is not a variable.`;
}

/** Adds, changes or removes the type annotation of a variable. */
export function setSymbolType(
  text: string,
  doc: GraphDocument,
  id: string,
  typeText: string | null,
  syntax: DeclarationSyntax,
  defaultValue?: string
): OpResult {
  const symbol = typedSymbol(doc, id);
  if (typeof symbol === 'string') {
    return failed(symbol);
  }

  if (!typeText?.trim() && needsType(symbol, syntax)) {
    return failed(`${symbol.name} needs a type.`);
  }

  const result = typeEdits(text, symbol, typeText, syntax);
  const current = symbol.defaultRange
    ? text.slice(symbol.defaultRange.start, symbol.defaultRange.end).trim()
    : undefined;
  if (
    !result.ok ||
    !defaultValue ||
    isValuelessField(doc, symbol, syntax) ||
    !typeText?.trim() ||
    (current !== undefined && !PLACEHOLDERS.has(current))
  ) {
    return result;
  }

  // The new type's default value replaces a placeholder or missing value.
  if (symbol.defaultRange) {
    return succeeded([
      ...result.edits,
      {
        start: symbol.defaultRange.start,
        end: symbol.defaultRange.end,
        text: defaultValue,
      },
    ]);
  }

  const [typeEdit] = result.edits;
  return typeEdit
    ? succeeded([{ ...typeEdit, text: `${typeEdit.text} = ${defaultValue}` }])
    : result;
}

const PLACEHOLDERS = new Set(['undefined', 'null', 'None']);

/** A field of a class in a language whose fields take no value (Rust). */
export function isValuelessField(
  doc: GraphDocument,
  symbol: ScriptSymbol,
  syntax: DeclarationSyntax
): boolean {
  return (
    syntax.typeSystem.noFieldValues === true &&
    symbol.kind === 'variable' &&
    classOf(doc, symbol.scope) !== undefined
  );
}

/** Whether the language needs a type on the symbol (Rust, not locals). */
function needsType(symbol: ScriptSymbol, syntax: DeclarationSyntax): boolean {
  return (
    syntax.typeSystem.requiredType !== undefined &&
    (symbol.kind === 'variable' || symbol.kind === 'constant')
  );
}

function typeEdits(
  text: string,
  symbol: ScriptSymbol,
  typeText: string | null,
  syntax: DeclarationSyntax
): OpResult {
  const type = typeText?.trim() || null;
  if (type) {
    const error = syntax.validType(type);
    if (error) {
      return failed(error);
    }
  }

  if (symbol.type) {
    const colon = text.lastIndexOf(':', symbol.type.range.start);
    if (colon < symbol.nameRange.end) {
      return failed('Cannot find the type annotation.');
    }

    if (type) {
      return succeeded([
        { start: colon, end: symbol.type.range.end, text: `: ${type}` },
      ]);
    }

    if (!symbol.defaultRange && syntax.valueRequired(symbol, false)) {
      return failed(`${symbol.name} needs a value to have no type.`);
    }

    return succeeded([{ start: colon, end: symbol.type.range.end, text: '' }]);
  }

  if (!type) {
    return succeeded([]);
  }

  const at = afterName(text, symbol);
  // GDScript: `var x := 1` → `var x: int = 1`
  const inferred = text.slice(at).match(/^\s*:=/);
  if (inferred) {
    return succeeded([
      { start: at, end: at + inferred[0].length, text: `: ${type} =` },
    ]);
  }

  return succeeded([{ start: at, end: at, text: `: ${type}` }]);
}

/** Writes a value of the given kind in the language's syntax. */
function valueSource(
  value: string,
  kind: ValueKind,
  syntax: DeclarationSyntax
): string | { error: string } {
  switch (kind) {
    case 'string': {
      return syntax.string(value);
    }

    case 'bool': {
      return value === 'true' ? syntax.booleans.true : syntax.booleans.false;
    }

    case 'number': {
      const trimmed = value.trim();
      return trimmed === '' || Number.isNaN(Number(trimmed.replaceAll('_', '')))
        ? { error: `"${value}" is not a number.` }
        : trimmed;
    }

    case 'expression': {
      return value.trim() === ''
        ? { error: 'The value must not be empty.' }
        : value.trim();
    }
  }
}

/** Sets or removes the value (initializer) of a variable. */
export function setSymbolValue(
  text: string,
  doc: GraphDocument,
  id: string,
  value: string | null,
  kind: ValueKind,
  syntax: DeclarationSyntax
): OpResult {
  const symbol = typedSymbol(doc, id);
  if (typeof symbol === 'string') {
    return failed(symbol);
  }

  if (isValuelessField(doc, symbol, syntax)) {
    return value === null
      ? succeeded([])
      : failed(`Fields of ${symbol.scope} cannot have a default value.`);
  }

  const from = symbol.type ? symbol.type.range.end : afterName(text, symbol);
  if (value === null) {
    if (!symbol.defaultRange) {
      return succeeded([]);
    }

    if (syntax.valueRequired(symbol, symbol.type !== undefined)) {
      return failed(`${symbol.name} needs a value.`);
    }

    return succeeded([{ start: from, end: symbol.defaultRange.end, text: '' }]);
  }

  const source = valueSource(value, kind, syntax);
  if (typeof source !== 'string') {
    return failed(source.error);
  }

  if (symbol.defaultRange) {
    return succeeded([
      {
        start: symbol.defaultRange.start,
        end: symbol.defaultRange.end,
        text: source,
      },
    ]);
  }

  return succeeded([{ start: from, end: from, text: ` = ${source}` }]);
}

export function setModifier(
  text: string,
  doc: GraphDocument,
  id: string,
  modifier: string,
  enabled: boolean,
  syntax: DeclarationSyntax
): OpResult {
  const symbol = findSymbol(doc, id);
  if (!symbol) {
    return failed('Unknown symbol.');
  }

  // `export default` counts as exported.
  const has =
    symbol.modifiers.includes(modifier) ||
    (modifier === 'export' && symbol.modifiers.includes('export default'));
  if (has === enabled) {
    return succeeded([]);
  }

  return syntax.setModifier(text, doc, symbol, modifier, enabled);
}

/**
 * Replaces the declaration keyword (`const` → `let`, `var` → `const`) that
 * comes before the name of a symbol.
 */
export function replaceKeyword(
  text: string,
  symbol: ScriptSymbol,
  keywords: ReadonlyArray<string>,
  next: string
): OpResult {
  const start = (symbol.declarationRange ?? symbol.range).start;
  const head = text.slice(start, symbol.nameRange.start);
  const pattern = new RegExp(String.raw`\b(?:${keywords.join('|')})\b`, 'g');
  const match = [...head.matchAll(pattern)].at(-1);
  if (!match) {
    return failed(`Cannot find the ${keywords.join(' / ')} of ${symbol.name}.`);
  }

  const at = start + match.index;
  return succeeded([{ start: at, end: at + match[0].length, text: next }]);
}

/**
 * Removes a modifier word (with its arguments and the space after it) that
 * stands before the name, also on a line of its own above the declaration
 * (`@export` in GDScript).
 */
export function removeModifier(
  text: string,
  symbol: ScriptSymbol,
  modifier: string
): OpResult {
  let start = (symbol.declarationRange ?? symbol.range).start;
  // An annotation alone on the line above belongs to the declaration.
  const above = lineStart(text, Math.max(lineStart(text, start) - 1, 0));
  if (
    /^\s*@\w+(?:\([^)]*\))?\s*$/.test(text.slice(above, lineStart(text, start)))
  ) {
    start = above;
  }

  const head = text.slice(start, symbol.nameRange.start);
  const escaped = modifier.replaceAll(/[$.*+?^()[\]{}|\\]/g, String.raw`\$&`);
  const match = head.match(
    new RegExp(String.raw`(?:^|(?<=\s))${escaped}(?:\([^)]*\))?\s+`)
  );
  if (match?.index === undefined) {
    return failed(`${symbol.name} has no ${modifier}.`);
  }

  const at = start + match.index;
  return succeeded([{ start: at, end: at + match[0].length, text: '' }]);
}
