import type { DeclarationSyntax } from './declaration-syntax';
import type { ImportRequest } from './imports';
import type { GraphDocument } from './ir';
import { failed, succeeded } from './op-result';
import type { OpResult, TextEdit } from './ops';
import { isBlank, lineEndOf } from './symbol-helpers';
import type { ScriptSymbol } from './symbols';
import { qualifiedName } from './symbols';
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
