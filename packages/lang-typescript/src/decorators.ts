import type * as t from '@babel/types';
import type {
  GraphDocument,
  OpResult,
  ScriptSymbol,
  SourceRange,
  TextEdit,
} from '@vizscript/core';
import { failed } from '@vizscript/core';
import { parseFile } from './parse-file';

function done(edits: TextEdit[]): OpResult {
  return { ok: true, edits };
}

function skipSpace(text: string, from: number): number {
  let at = from;
  while (at < text.length && /\s/.test(text.charAt(at))) {
    at++;
  }

  return at;
}

/** Index of the `)` closing the `(` at `open`, skipping strings. */
function closingParen(text: string, open: number): number {
  let depth = 0;
  let quote = '';
  for (let i = open; i < text.length; i++) {
    const c = text.charAt(i);
    if (quote) {
      if (c === '\\') {
        i++;
      } else if (c === quote) {
        quote = '';
      }
    } else if (c === "'" || c === '"' || c === '`') {
      quote = c;
    } else if (c === '(') {
      depth++;
    } else if (c === ')' && --depth === 0) {
      return i;
    }
  }

  return text.length - 1;
}

/** The decorators written from `start` on (`@Get()`, `@a.b(x)`). */
export function decoratorRanges(text: string, start: number): SourceRange[] {
  const ranges: SourceRange[] = [];
  let at = start;
  while (text.charAt(at) === '@') {
    const begin = at;
    at++;
    while (at < text.length && /[\w$.]/.test(text.charAt(at))) {
      at++;
    }

    let end = at;
    const next = skipSpace(text, at);
    if (text.charAt(next) === '(') {
      end = closingParen(text, next) + 1;
    }

    ranges.push({ start: begin, end });
    at = skipSpace(text, end);
  }

  return ranges;
}

/**
 * Where keywords of a declaration starting at `start` go: after its
 * decorators (`@Get()\n  private get()`, `@Injectable()\nexport class`).
 */
export function afterDecorators(text: string, start: number): number {
  const last = decoratorRanges(text, start).at(-1);
  return last ? skipSpace(text, last.end) : start;
}

function lineIndent(text: string, at: number): string {
  const lineStart = text.lastIndexOf('\n', at - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))?.[0] ?? '';
}

/** The class a member belongs to. */
function ownerClass(
  doc: GraphDocument,
  symbol: ScriptSymbol
): ScriptSymbol | undefined {
  return doc.symbols?.find(
    (s) => s.kind === 'class' && s.scope === '' && s.name === symbol.scope
  );
}

/**
 * A decorator as one parses in a class: `@` added when it is missing;
 * `undefined` when it isn't a single decorator.
 */
function checkedDecorator(raw: string, onParam: boolean): string | undefined {
  const text = raw.trim().replace(/^(?!@)/, '@');
  const code = onParam
    ? `class X {\n  m(${text} a) {}\n}\n`
    : `class X {\n  ${text}\n  m() {}\n}\n`;
  try {
    const file = parseFile(code, 'check.ts');
    const cls = file.program.body[0];
    const method = cls?.type === 'ClassDeclaration' ? cls.body.body : [];
    const target: t.Node | undefined = onParam
      ? method[0]?.type === 'ClassMethod'
        ? method[0].params[0]
        : undefined
      : method[0];
    const decorators =
      target && 'decorators' in target ? (target.decorators ?? []) : [];
    return file.errors?.length === 0 &&
      file.program.body.length === 1 &&
      method.length === 1 &&
      decorators.length === 1
      ? text
      : undefined;
  } catch {
    return undefined;
  }
}

/** Adds, replaces or removes a decorator of a declaration or parameter. */
export function setDecorator(
  text: string,
  doc: GraphDocument,
  symbol: ScriptSymbol,
  change: { param?: number; index?: number; text: string | null }
): OpResult {
  const member = symbol.scope !== '' && ownerClass(doc, symbol) !== undefined;
  const onParam = change.param !== undefined;
  if (
    onParam
      ? symbol.kind !== 'method' || !member
      : symbol.kind !== 'class' && !member
  ) {
    return failed(
      onParam
        ? 'Only inputs of class methods have decorators in TypeScript.'
        : 'Only classes and their members have decorators in TypeScript.'
    );
  }

  const param =
    change.param === undefined ? undefined : symbol.params?.[change.param];
  if (onParam && !param) {
    return failed('Cannot find this input.');
  }

  const start = param
    ? (param.range?.start ?? param.nameRange.start)
    : (symbol.declarationRange ?? symbol.range).start;
  const ranges = decoratorRanges(text, start);
  // A parameter property's decorators stand on its line, like a parameter's.
  const inline = onParam || symbol.modifiers.includes('constructor');

  if (change.index !== undefined) {
    const range = ranges[change.index];
    if (!range) {
      return failed('Cannot find this decorator.');
    }

    if (change.text === null || change.text.trim() === '') {
      return done([
        { start: range.start, end: skipSpace(text, range.end), text: '' },
      ]);
    }

    const decorator = checkedDecorator(change.text, onParam || inline);
    return decorator
      ? done([{ ...range, text: decorator }])
      : failed(`"${change.text.trim()}" is not a valid decorator.`);
  }

  if (change.text === null || change.text.trim() === '') {
    return done([]);
  }

  const decorator = checkedDecorator(change.text, onParam || inline);
  if (!decorator) {
    return failed(`"${change.text.trim()}" is not a valid decorator.`);
  }

  const last = ranges.at(-1);
  if (last) {
    // After the others, in their style: on the same line or on its own.
    const next = skipSpace(text, last.end);
    const sameLine = !text.slice(last.end, next).includes('\n');
    return done([
      sameLine
        ? { start: last.end, end: last.end, text: ` ${decorator}` }
        : {
            start: next,
            end: next,
            text: `${decorator}\n${lineIndent(text, next)}`,
          },
    ]);
  }

  return done([
    {
      start,
      end: start,
      text: inline
        ? `${decorator} `
        : `${decorator}\n${lineIndent(text, start)}`,
    },
  ]);
}

/** End of the `<…>` that starts at `open`; `=>` inside doesn't close it. */
function closingAngle(text: string, open: number): number | undefined {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text.charAt(i);
    if (c === '<') {
      depth++;
    } else if (c === '>' && text.charAt(i - 1) !== '=' && --depth === 0) {
      return i;
    }
  }

  return undefined;
}

function checkedTypeParams(params: string): boolean {
  try {
    const file = parseFile(`function f<${params}>() {}\n`, 'check.ts');
    const fn = file.program.body[0];
    return (
      file.errors?.length === 0 &&
      file.program.body.length === 1 &&
      fn?.type === 'FunctionDeclaration' &&
      fn.typeParameters?.type === 'TSTypeParameterDeclaration'
    );
  } catch {
    return false;
  }
}

/** Sets the type parameters written after a generic's name. */
export function setTypeParams(
  text: string,
  _doc: GraphDocument,
  symbol: ScriptSymbol,
  params: string
): OpResult {
  const generic =
    symbol.kind === 'class' ||
    symbol.kind === 'type' ||
    symbol.kind === 'method' ||
    symbol.kind === 'function';
  if (!generic) {
    return failed('Only functions, classes and types have type parameters.');
  }

  if (
    symbol.kind === 'function' &&
    symbol.modifiers.some((m) => m === 'const' || m === 'let' || m === 'var')
  ) {
    return failed(
      'Change the type parameters of an arrow function in the code.'
    );
  }

  const list = params
    .trim()
    .replace(/^<([\s\S]*)>$/, '$1')
    .trim();
  if (list !== '' && !checkedTypeParams(list)) {
    return failed(`"${list}" are not valid type parameters.`);
  }

  const at = symbol.nameRange.end;
  const open = skipSpace(text, at);
  const close =
    text.charAt(open) === '<' ? closingAngle(text, open) : undefined;
  const written =
    close === undefined ? undefined : { start: at, end: close + 1 };
  const next = list === '' ? '' : `<${list}>`;
  if (!written) {
    return done(next === '' ? [] : [{ start: at, end: at, text: next }]);
  }

  return done([{ ...written, text: next }]);
}
