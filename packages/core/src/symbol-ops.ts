import type { DeclarationSyntax } from './declaration-syntax';
import type { ImportRequest } from './imports';
import type { GraphDocument, SourceRange } from './ir';
import { failed, succeeded } from './op-result';
import type { OpResult, TextEdit } from './ops';
import { isBlank, lineEndOf } from './symbol-helpers';
import type { ScriptSymbol } from './symbols';
import { holdsFields, qualifiedName } from './symbols';
import { lineIndent, lineStart } from './text-utils';

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
  /** The previous line was part of the header (for `headerDoc`). */
  let follows = false;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (syntax.header.test(trimmed)) {
      end = offset;
      follows = true;
    } else if (follows && syntax.headerDoc?.test(trimmed)) {
      end = offset;
    } else if (trimmed !== '' && end !== undefined) {
      break;
    } else {
      follows = false;
    }

    offset += line.length + 1;
  }

  const doc = syntax.leadingDoc?.(text);
  return doc === undefined ? end : Math.max(end ?? -1, doc);
}

export function classOf(
  doc: GraphDocument,
  scope: string
): ScriptSymbol | undefined {
  return doc.symbols?.find(
    (s) => (s.kind === 'class' || holdsFields(s)) && qualifiedName(s) === scope
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

/**
 * Whether the file has code after `from` that runs when the module is
 * loaded: lines that are no declaration (of any kind) and no comment.
 */
function runsCode(text: string, doc: GraphDocument, from: number): boolean {
  let rest = text.slice(from);
  const declared = (doc.symbols ?? [])
    .filter((s) => s.scope === '')
    .map((s) => s.declarationRange ?? s.range)
    .filter((r) => r.start >= from)
    .toSorted((a, b) => b.start - a.start);
  for (const r of declared) {
    rest = rest.slice(0, r.start - from) + rest.slice(r.end - from);
  }

  return rest
    .split('\n')
    .map((line) => line.trim())
    .some((line) => line !== '' && !/^(?:#|\/\/|\/\*|\*)/.test(line));
}

/**
 * The code of the declaration `id` when a new function of `scope` can go
 * right after it: a function, method or class of that scope that starts
 * its own line.
 */
function afterDeclaration(
  text: string,
  doc: GraphDocument,
  scope: string,
  id: string | undefined
): SourceRange | undefined {
  const symbol =
    id === undefined
      ? undefined
      : doc.symbols?.find(
          (s) =>
            s.id === id &&
            s.scope === scope &&
            (s.kind === 'function' || s.kind === 'method' || s.kind === 'class')
        );
  const range = symbol && (symbol.declarationRange ?? symbol.range);
  return range &&
    text.slice(lineStart(text, range.start), range.start).trim() === ''
    ? range
    : undefined;
}

export function addFunction(
  text: string,
  doc: GraphDocument,
  scope: string,
  name: string,
  unit: string,
  syntax: DeclarationSyntax,
  after?: string
): OpResult {
  const error = checkName(doc, syntax, scope, name);
  if (error) {
    return failed(error);
  }

  const anchor = afterDeclaration(text, doc, scope, after);
  if (anchor) {
    // Indented like the declaration it follows (a method like a method).
    const indent = lineIndent(text, anchor.start);
    const block = syntax
      .fn(name, unit, scope !== '')
      .split('\n')
      .map((line) => (line === '' ? line : `${indent}${line}`))
      .join('\n');
    const blank = scope ? Math.min(syntax.blankLines, 1) : syntax.blankLines;
    return succeeded([insertAfterLine(text, anchor.end - 1, block, blank)]);
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

  // After the file's last function or class: code that runs the module
  // (`main()`, `if __name__ == "__main__":`) stays at the end.
  const last = (doc.symbols ?? [])
    .filter(
      (s) =>
        s.scope === '' &&
        (s.kind === 'function' || s.kind === 'class') &&
        lineIndent(text, (s.declarationRange ?? s.range).start) === ''
    )
    .map((s) => (s.declarationRange ?? s.range).end)
    .reduce((a, b) => Math.max(a, b), -1);
  if (last > 0 && runsCode(text, doc, last)) {
    return succeeded([
      insertAfterLine(text, last - 1, block, syntax.blankLines),
    ]);
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

    const line =
      cls.kind === 'type'
        ? syntax.field?.(name)
        : syntax.variable(name, { constant, member: true });
    if (line === undefined) {
      return failed(`${scope} cannot get fields here.`);
    }

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
 * { a } from './x'`, `from x import a`): `, name` or `, imported as name`,
 * on a line of its own in a list written one name per line (with `text`).
 */
export function joinImport(
  doc: GraphDocument,
  module: string,
  name: string,
  imported: string,
  text?: string
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
  // A list with one name per line gets another line.
  const indent =
    text?.slice(lineStart(text, last.range.start), last.range.start) ?? '';
  const ownLine = text !== undefined && indent !== '' && indent.trim() === '';
  return {
    start: last.range.end,
    end: last.range.end,
    text: ownLine ? `,\n${indent}${item}` : `, ${item}`,
  };
}

/**
 * Inserts an import line after the file's last top-level import, else after
 * the header (`extends`, a Python docstring), else on top.
 */
export function insertImport(
  text: string,
  doc: GraphDocument,
  syntax: DeclarationSyntax,
  line: string
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

  const header = headerEnd(text, syntax);
  if (header !== undefined) {
    return insertAfterLine(text, header, line, 1);
  }

  const next = text.trimStart() === '' ? '' : '\n';
  return { start: 0, end: 0, text: `${line}\n${next}` };
}

/**
 * A new type of the file: after its last type, else below the imports or
 * the header (`extends`, a docstring), else at the start.
 */
export function addType(
  text: string,
  doc: GraphDocument,
  name: string,
  unit: string,
  syntax: DeclarationSyntax
): OpResult {
  const declare = syntax.typeDeclaration;
  if (!declare) {
    return failed('Types cannot be added in this language.');
  }

  const error = checkName(doc, syntax, '', name);
  if (error) {
    return failed(error);
  }

  const block = declare(name, unit);
  const blank = Math.max(1, syntax.blankLines);
  const topLevel = (doc.symbols ?? []).filter(
    (s) =>
      s.scope === '' &&
      lineIndent(text, (s.declarationRange ?? s.range).start) === ''
  );
  const after =
    topLevel
      .filter(
        (s) => s.kind === 'type' || s.kind === 'class' || s.kind === 'enum'
      )
      .at(-1) ?? topLevel.filter((s) => s.kind === 'import').at(-1);
  if (after) {
    return succeeded([
      insertAfterLine(
        text,
        (after.declarationRange ?? after.range).end - 1,
        block,
        blank
      ),
    ]);
  }

  const header = headerEnd(text, syntax);
  if (header !== undefined) {
    return succeeded([insertAfterLine(text, header, block, blank)]);
  }

  const rest = text.trim() === '' ? '' : '\n'.repeat(blank);
  return succeeded([{ start: 0, end: 0, text: `${block}\n${rest}` }]);
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
