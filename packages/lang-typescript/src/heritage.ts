import type * as t from '@babel/types';
import type { OpResult, ScriptSymbol, TextEdit } from '@vizscript/core';
import { parseFile } from './parse-file';

type Heritable = t.ClassDeclaration | t.TSInterfaceDeclaration;

function failed(error: string): OpResult {
  return { ok: false, error };
}

/** The class or interface declared at `symbol`'s name. */
function declarationOf(
  program: t.Program,
  symbol: ScriptSymbol
): Heritable | undefined {
  for (const statement of program.body) {
    const node =
      (statement.type === 'ExportNamedDeclaration' ||
        statement.type === 'ExportDefaultDeclaration') &&
      statement.declaration
        ? statement.declaration
        : statement;
    if (
      (node.type === 'ClassDeclaration' ||
        node.type === 'TSInterfaceDeclaration') &&
      node.id?.start === symbol.nameRange.start
    ) {
      return node;
    }
  }

  return undefined;
}

/** Whether `value` can follow `keyword` in a class or interface header. */
function valid(
  kind: 'class' | 'interface',
  keyword: 'extends' | 'implements',
  value: string
): boolean {
  try {
    const file = parseFile(
      `${kind} __Check__ ${keyword} ${value} {}\n`,
      'check.ts'
    );
    const node = file.program.body[0];
    return (
      file.errors?.length === 0 &&
      file.program.body.length === 1 &&
      (node?.type === 'ClassDeclaration' ||
        node?.type === 'TSInterfaceDeclaration')
    );
  } catch {
    return false;
  }
}

function end(node: { end?: number | null }): number {
  return node.end ?? 0;
}

/**
 * One clause of a header: where it is written (from the end of what comes
 * before it to the end of its last item) or, missing, where it goes.
 */
function clause(
  before: number,
  items: ReadonlyArray<{ start?: number | null; end?: number | null }>
): { before: number; start?: number; end?: number } {
  const first = items[0];
  const last = items.at(-1);
  return first && last
    ? { before, start: first.start ?? before, end: end(last) }
    : { before };
}

/**
 * Sets what a class extends or implements, or an interface extends, as
 * written after the keyword; `''` removes the clause.
 */
export function setHeritage(
  text: string,
  fileName: string | undefined,
  symbol: ScriptSymbol,
  keyword: 'extends' | 'implements',
  value: string
): OpResult {
  let program: t.Program;
  try {
    program = parseFile(text, fileName).program;
  } catch {
    return failed('The file does not parse.');
  }

  const node = declarationOf(program, symbol);
  if (!node?.id) {
    return failed('Only classes and interfaces extend others.');
  }

  const kind = node.type === 'ClassDeclaration' ? 'class' : 'interface';
  if (kind === 'interface' && keyword === 'implements') {
    return failed('An interface extends others; it implements none.');
  }

  const list = value.trim().replace(/,\s*$/, '');
  if (list !== '' && !valid(kind, keyword, list)) {
    return failed(`"${list}" cannot follow ${keyword}.`);
  }

  const head = node.typeParameters ? end(node.typeParameters) : end(node.id);
  let place: { before: number; start?: number; end?: number };
  if (node.type === 'TSInterfaceDeclaration') {
    place = clause(head, node.extends ?? []);
  } else if (keyword === 'extends') {
    const base = node.superClass;
    place = base
      ? {
          before: head,
          start: base.start ?? head,
          end: node.superTypeArguments
            ? end(node.superTypeArguments)
            : end(base),
        }
      : { before: head };
  } else {
    // After the base class, if there is one.
    const base = node.superTypeArguments ?? node.superClass;
    place = clause(base ? end(base) : head, node.implements ?? []);
  }

  let edit: TextEdit;
  if (place.start === undefined || place.end === undefined) {
    if (list === '') {
      return { ok: true, edits: [] };
    }

    edit = {
      start: place.before,
      end: place.before,
      text: ` ${keyword} ${list}`,
    };
  } else if (list === '') {
    // ` extends Base` goes with its keyword.
    edit = { start: place.before, end: place.end, text: '' };
  } else {
    edit = { start: place.start, end: place.end, text: list };
  }

  return { ok: true, edits: [edit] };
}
