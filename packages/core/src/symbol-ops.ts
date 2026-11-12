import type { CommentSyntax } from './comment-ops';
import type { ImportRequest } from './imports';
import type { GraphDocument, SourceRange } from './ir';
import type { OpResult, TextEdit, TypeSystemInfo, ValueKind } from './ops';
import type { CallSite } from './signature-ops';
import type { ScriptSymbol } from './symbols';
import { qualifiedName } from './symbols';
import { lineIndent, lineStart } from './text-utils';

/**
 * How a language declares things, for adding, renaming and deleting
 * symbols from "My Script" (UE: the `+` buttons of "My Blueprint").
 */
export interface DeclarationSyntax {
  /** Valid names (`[A-Za-z_]\w*`, …). */
  identifier: RegExp;
  /** Reserved words that cannot be names. */
  keywords: ReadonlySet<string>;
  /** Indentation of a new file (`'    '` in Python). */
  defaultIndent: string;
  /** Blank lines around functions (2 in Python and GDScript). */
  blankLines: number;
  /** Members of a class are written inside `{ … }` (TypeScript). */
  bracedClasses: boolean;
  /** Lines that stay at the top of a file (imports, `extends`, …). */
  header: RegExp;
  /** A new empty function or method (lines after the first not indented). */
  fn: (name: string, unit: string, method: boolean) => string;
  /** A new variable declaration. */
  variable: (
    name: string,
    options: { constant: boolean; member: boolean }
  ) => string;
  /** A new signal (GDScript). */
  signal?: (name: string) => string;
  /** Types and modifiers offered by the Details panel. */
  typeSystem: TypeSystemInfo;
  /** Error message for an invalid type annotation. */
  validType: (text: string) => string | undefined;
  /** A string literal (`"text"` with the language's escapes). */
  string: (value: string) => string;
  /** Boolean literals. */
  booleans: { true: string; false: string };
  /** Whether a variable cannot exist without a value (`const`, Python). */
  valueRequired: (symbol: ScriptSymbol, typed: boolean) => boolean;
  /** Written between `)` and a return type (`: ` or ` -> `). */
  returnArrow: string;
  /** Calls of a function or method in the same file. */
  callSites?: (
    text: string,
    doc: GraphDocument,
    symbol: ScriptSymbol
  ) => CallSite[];
  /** Turns a modifier of a declaration on or off. */
  setModifier: (
    text: string,
    doc: GraphDocument,
    symbol: ScriptSymbol,
    modifier: string,
    enabled: boolean
  ) => OpResult;
  /**
   * Edits that rename a symbol and its uses; backends resolve the uses with
   * their own scope rules.
   */
  rename: (
    text: string,
    doc: GraphDocument,
    symbol: ScriptSymbol,
    name: string
  ) => OpResult;
  /** How collapsed nodes become a function and its call (`collapse.ts`). */
  extract?: ExtractSyntax;
  /** Edits that import a name of another file (see `addImport`). */
  addImport?: (
    text: string,
    doc: GraphDocument,
    request: ImportRequest
  ) => OpResult;
}

/** An input of a collapsed function. */
export interface ExtractParam {
  name: string;
  /** Declared type of the variable it comes from. */
  type?: string;
}

/** Language syntax for "Collapse to function". */
export interface ExtractSyntax {
  /**
   * The new function: `body` is indented by one unit, the other lines of
   * the result are not (like `fn`).
   */
  fn: (
    name: string,
    params: ReadonlyArray<ExtractParam>,
    body: string,
    options: { method: boolean; isStatic: boolean; isAsync: boolean }
  ) => string;
  /** The statement that calls it, with the output stored if there is one. */
  call: (
    callee: string,
    args: ReadonlyArray<string>,
    options: {
      isAsync: boolean;
      /** `declare`: the keyword of a new variable (`const`), else assign. */
      output?: { name: string; declare?: string };
    }
  ) => string;
  /** `return x` with the language's terminator. */
  returnValue: (name: string) => string;
  /** Callee of a method of the same class (`this.name`, `self.name`). */
  method: (name: string, className: string, isStatic: boolean) => string;
}

function failed(error: string): OpResult {
  return { ok: false, error };
}

function succeeded(edits: TextEdit[]): OpResult {
  return { ok: true, edits };
}

function lineEndOf(text: string, offset: number): number {
  const end = text.indexOf('\n', offset);
  return end === -1 ? text.length : end;
}

function isBlank(line: string | undefined): boolean {
  return line !== undefined && line.trim() === '';
}

function findSymbol(doc: GraphDocument, id: string): ScriptSymbol | undefined {
  return doc.symbols?.find((s) => s.id === id);
}

/** Checks a new name: valid, not reserved, not taken in its scope. */
export function checkName(
  doc: GraphDocument,
  syntax: DeclarationSyntax,
  scope: string,
  name: string,
  except?: ScriptSymbol
): string | undefined {
  if (!syntax.identifier.test(name)) {
    return `"${name}" is not a valid name.`;
  }

  if (syntax.keywords.has(name)) {
    return `"${name}" is a reserved word.`;
  }

  const taken = doc.symbols?.find(
    (s) => s !== except && s.scope === scope && s.name === name
  );
  return taken ? `"${name}" already exists here.` : undefined;
}

/** `newFunction`, `newFunction2`, … (or snake_case) not taken in a scope. */
export function uniqueName(
  doc: GraphDocument,
  scope: string,
  base: string
): string {
  const taken = new Set(
    (doc.symbols ?? []).filter((s) => s.scope === scope).map((s) => s.name)
  );
  let name = base;
  for (let i = 2; taken.has(name); i++) {
    name = `${base}${i}`;
  }

  return name;
}

/**
 * Inserts `block` as a new paragraph after `offset`'s line, separated by
 * `blank` empty lines from the code around it.
 */
function insertAfterLine(
  text: string,
  offset: number,
  block: string,
  blank: number
): TextEdit {
  const at = lineEndOf(text, offset);
  const separator = '\n'.repeat(blank);
  if (at >= text.length) {
    return { start: at, end: at, text: `\n${separator}${block}\n` };
  }

  // `at` is a newline: the new lines go behind it.
  const nextLine = text.slice(at + 1, lineEndOf(text, at + 1));
  return {
    start: at + 1,
    end: at + 1,
    text: `${separator}${block}\n${isBlank(nextLine) || blank === 0 ? '' : separator}`,
  };
}

/** End of the lines that stay at the top (imports, `extends`, …). */
function headerEnd(
  text: string,
  syntax: DeclarationSyntax
): number | undefined {
  let end: number | undefined;
  let offset = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (syntax.header.test(trimmed)) {
      end = offset;
    } else if (trimmed !== '' && end !== undefined) {
      break;
    }

    offset += line.length + 1;
  }

  return end;
}

export function classOf(
  doc: GraphDocument,
  scope: string
): ScriptSymbol | undefined {
  return doc.symbols?.find(
    (s) => s.kind === 'class' && qualifiedName(s) === scope
  );
}

function memberIndent(
  text: string,
  doc: GraphDocument,
  cls: ScriptSymbol,
  unit: string
): string {
  const member = doc.symbols?.find(
    (s) =>
      s.scope === qualifiedName(cls) &&
      s.kind !== 'local' &&
      !s.modifiers.some((m) => m.endsWith('.'))
  );
  return member
    ? lineIndent(text, member.range.start)
    : lineIndent(text, cls.range.start) + unit;
}

/** Inserts a member at the end of a class body. */
export function addToClass(
  text: string,
  doc: GraphDocument,
  cls: ScriptSymbol,
  member: string,
  unit: string,
  syntax: DeclarationSyntax,
  blank: number
): TextEdit {
  const indent = memberIndent(text, doc, cls, unit);
  const body = member.split('\n').join(`\n${indent}`);
  if (!syntax.bracedClasses) {
    return insertAfterLine(text, cls.range.end - 1, `${indent}${body}`, blank);
  }

  const close = text.lastIndexOf('}', cls.range.end - 1);
  const open = text.indexOf('{', cls.nameRange.end);
  const empty = text.slice(open + 1, close).trim() === '';
  if (empty) {
    // `class A {}` → `class A {\n  member\n}`
    const classIndent = lineIndent(text, cls.range.start);
    return {
      start: open + 1,
      end: close,
      text: `\n${indent}${body}\n${classIndent}`,
    };
  }

  const at = lineStart(text, close);
  const ownLine = text.slice(at, close).trim() === '';
  return ownLine
    ? {
        start: at,
        end: at,
        text: `${'\n'.repeat(blank)}${indent}${body}\n`,
      }
    : { start: close, end: close, text: `\n${indent}${body}\n` };
}

export function addFunction(
  text: string,
  doc: GraphDocument,
  scope: string,
  name: string,
  unit: string,
  syntax: DeclarationSyntax
): OpResult {
  const error = checkName(doc, syntax, scope, name);
  if (error) {
    return failed(error);
  }

  if (scope) {
    const cls = classOf(doc, scope);
    if (!cls) {
      return failed(`There is no class ${scope}.`);
    }

    return succeeded([
      addToClass(
        text,
        doc,
        cls,
        syntax.fn(name, unit, true),
        unit,
        syntax,
        Math.min(syntax.blankLines, 1)
      ),
    ]);
  }

  const block = syntax.fn(name, unit, false);
  const trimmed = text.trimEnd();
  if (trimmed === '') {
    return succeeded([{ start: 0, end: text.length, text: `${block}\n` }]);
  }

  const separator = '\n'.repeat(syntax.blankLines + 1);
  return succeeded([
    {
      start: trimmed.length,
      end: text.length,
      text: `${separator}${block}\n`,
    },
  ]);
}

export function addVariable(
  text: string,
  doc: GraphDocument,
  scope: string,
  name: string,
  constant: boolean,
  unit: string,
  syntax: DeclarationSyntax
): OpResult {
  const error = checkName(doc, syntax, scope, name);
  if (error) {
    return failed(error);
  }

  const isVariable = (s: ScriptSymbol): boolean =>
    s.scope === scope &&
    (s.kind === 'variable' || s.kind === 'constant') &&
    !s.modifiers.some((m) => m.endsWith('.'));

  if (scope) {
    const cls = classOf(doc, scope);
    if (!cls) {
      return failed(`There is no class ${scope}.`);
    }

    const line = syntax.variable(name, { constant, member: true });
    const last = doc.symbols?.findLast(isVariable);
    if (last) {
      const indent = lineIndent(text, last.range.start);
      return succeeded([
        insertAfterLine(
          text,
          (last.declarationRange ?? last.range).end - 1,
          `${indent}${line}`,
          0
        ),
      ]);
    }

    return succeeded([addToClass(text, doc, cls, line, unit, syntax, 0)]);
  }

  const line = syntax.variable(name, { constant, member: false });
  const last = doc.symbols?.findLast(isVariable);
  if (last) {
    return succeeded([
      insertAfterLine(
        text,
        (last.declarationRange ?? last.range).end - 1,
        line,
        0
      ),
    ]);
  }

  const header = headerEnd(text, syntax);
  if (header !== undefined) {
    return succeeded([insertAfterLine(text, header, line, 1)]);
  }

  const rest = text.trimStart() === '' ? '' : `\n${text}`;
  return succeeded([{ start: 0, end: text.length, text: `${line}\n${rest}` }]);
}

export function addSignal(
  text: string,
  doc: GraphDocument,
  name: string,
  syntax: DeclarationSyntax
): OpResult {
  if (!syntax.signal) {
    return failed('This language has no signals.');
  }

  const error = checkName(doc, syntax, '', name);
  if (error) {
    return failed(error);
  }

  const line = syntax.signal(name);
  const last = doc.symbols?.findLast(
    (s) => s.kind === 'signal' && s.scope === ''
  );
  if (last) {
    return succeeded([insertAfterLine(text, last.range.end - 1, line, 0)]);
  }

  const header = headerEnd(text, syntax);
  return succeeded([
    header === undefined
      ? { start: 0, end: 0, text: `${line}\n\n` }
      : insertAfterLine(text, header, line, 1),
  ]);
}

// ---------------------------------------------------------------- imports

/**
 * Adds `name` to an import statement of `module` that lists names (`import
 * { a } from './x'`, `from x import a`): `, name` or `, imported as name`.
 */
export function joinImport(
  doc: GraphDocument,
  module: string,
  name: string,
  imported: string
): TextEdit | undefined {
  const listed = (doc.symbols ?? []).filter(
    (s) =>
      s.kind === 'import' &&
      s.module === module &&
      s.imported !== '*' &&
      s.imported !== 'default' &&
      !s.modifiers.includes('type')
  );
  const statement = listed.at(-1)?.declarationRange;
  const last = listed
    .filter((s) => s.declarationRange?.start === statement?.start)
    .reduce<ScriptSymbol | undefined>(
      (a, b) => (a && a.range.end > b.range.end ? a : b),
      undefined
    );
  if (!last) {
    return undefined;
  }

  const item = imported === name ? name : `${imported} as ${name}`;
  return { start: last.range.end, end: last.range.end, text: `, ${item}` };
}

/**
 * Inserts an import line after the file's last top-level import, else after
 * `fallback` (a Python docstring) or the header (`extends`), else on top.
 */
export function insertImport(
  text: string,
  doc: GraphDocument,
  syntax: DeclarationSyntax,
  line: string,
  fallback?: number
): TextEdit {
  const last = (doc.symbols ?? [])
    .filter(
      (s) =>
        s.kind === 'import' &&
        lineIndent(text, (s.declarationRange ?? s.range).start) === ''
    )
    .at(-1);
  if (last) {
    return insertAfterLine(
      text,
      (last.declarationRange ?? last.range).end - 1,
      line,
      0
    );
  }

  // The later of both: a Python docstring may follow a shebang line.
  const header = Math.max(headerEnd(text, syntax) ?? -1, fallback ?? -1);
  if (header >= 0) {
    return insertAfterLine(text, header, line, 1);
  }

  const next = text.trimStart() === '' ? '' : '\n';
  return { start: 0, end: 0, text: `${line}\n${next}` };
}

/**
 * Imports a name of another file for a node that uses it. Nothing to do
 * when the file imports it already; a name taken by something else fails.
 */
export function addImport(
  text: string,
  doc: GraphDocument,
  request: ImportRequest,
  syntax: DeclarationSyntax | undefined
): OpResult {
  const taken = (doc.symbols ?? []).find(
    (s) => s.name === request.name && s.scope === '' && s.kind !== 'local'
  );
  if (taken) {
    return taken.kind === 'import' &&
      (taken.imported === request.imported ||
        (taken.imported === '*' && request.imported === '*'))
      ? succeeded([])
      : failed(`${request.name} already exists in this file.`);
  }

  if (!syntax?.addImport) {
    return failed('This language cannot add imports yet.');
  }

  return syntax.addImport(text, doc, request);
}

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
function removeListItem(text: string, range: SourceRange): TextEdit {
  let { start, end } = range;
  const after = text.slice(end).match(/^\s*,[ \t]*/)?.[0];
  const before = text.slice(0, start).match(/,\s*$/)?.[0];
  if (after) {
    end += after.length;
  } else if (before) {
    start -= before.length;
  } else {
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
  if (together.length > 0 && symbol.kind === 'import') {
    return succeeded([removeListItem(text, symbol.range)]);
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

  const start = leadingComments(text, range.start, comment);
  let end = Math.min(lineEnd + 1, text.length);

  // Keep the blank lines of one side only (no doubled gap).
  const linesAbove = text.slice(0, start).split('\n').slice(0, -1);
  let blankAbove = 0;
  while (isBlank(linesAbove.at(-1 - blankAbove))) {
    blankAbove++;
  }

  // At the top of the file, all blank lines below go too.
  const limit =
    linesAbove.length === blankAbove ? Number.POSITIVE_INFINITY : blankAbove;
  for (
    let removed = 0;
    removed < limit &&
    end < text.length &&
    isBlank(text.slice(end, lineEndOf(text, end)));
    removed++
  ) {
    end = Math.min(lineEndOf(text, end) + 1, text.length);
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

  const result = typeEdits(text, symbol, typeText, syntax);
  const current = symbol.defaultRange
    ? text.slice(symbol.defaultRange.start, symbol.defaultRange.end).trim()
    : undefined;
  if (
    !result.ok ||
    !defaultValue ||
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

  if (symbol.modifiers.includes(modifier) === enabled) {
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
