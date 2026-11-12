import type { CommentSyntax } from './comment-ops';
import type { GraphDocument, SourceRange } from './ir';
import type { OpResult, TextEdit } from './ops';
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

function classOf(doc: GraphDocument, scope: string): ScriptSymbol | undefined {
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
function addToClass(
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

  const error = checkName(doc, syntax, symbol.scope, name, symbol);
  return error ? failed(error) : syntax.rename(text, doc, symbol, name);
}
