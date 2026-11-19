import type {
  GraphDocument,
  OpResult,
  ScriptSymbol,
  SymbolParam,
  TextEdit,
} from '@vizscript/core';
import {
  removeListItem,
  removeModifier,
  replaceKeyword,
  withStartValue,
} from '@vizscript/core';
import { afterDecorators } from './decorators';
import { ACCESS, KINDS, TYPESCRIPT_TYPES } from './type-system';

/**
 * UE's "Expose on Spawn": a field becomes a parameter property of the
 * constructor (`constructor(public speed = 10)`), set when the class is
 * created, and back.
 */
function setConstructorParameter(
  text: string,
  doc: GraphDocument,
  symbol: ScriptSymbol,
  enabled: boolean
): OpResult {
  if (symbol.kind !== 'variable' || symbol.scope === '') {
    return {
      ok: false,
      error: 'Only fields of a class can be set when created.',
    };
  }

  const ctor = doc.symbols?.find(
    (s) =>
      s.kind === 'method' &&
      s.scope === symbol.scope &&
      s.name === 'constructor'
  );
  const access = symbol.modifiers.find((m) => ACCESS.includes(m));
  const readonly = symbol.modifiers.includes('readonly');
  const type = symbol.type ? `: ${symbol.type.text}` : '';
  const value = symbol.defaultRange
    ? ` = ${text.slice(symbol.defaultRange.start, symbol.defaultRange.end)}`
    : '';

  if (!enabled) {
    // Back to a field above the constructor.
    if (!ctor) {
      return { ok: false, error: 'Cannot find the constructor.' };
    }

    const removed = removeListItem(text, symbol.range, true);
    const lineStart = text.lastIndexOf('\n', ctor.range.start - 1) + 1;
    const indent =
      text.slice(lineStart, ctor.range.start).match(/^\s*/)?.[0] ?? '';
    const prefix = [
      ...(access && access !== 'public' ? [access] : []),
      ...(readonly ? ['readonly'] : []),
    ].join(' ');
    const field = `${indent}${prefix ? `${prefix} ` : ''}${symbol.name}${type}${value};\n`;
    return {
      ok: true,
      edits: [removed, { start: lineStart, end: lineStart, text: field }],
    };
  }

  if (symbol.modifiers.includes('static') || symbol.name.startsWith('#')) {
    return {
      ok: false,
      error: 'Static and #private fields cannot be constructor parameters.',
    };
  }

  const param = `${access ?? 'public'} ${readonly ? 'readonly ' : ''}${symbol.name}${type}${value}`;
  const fieldStart = text.lastIndexOf('\n', symbol.range.start - 1) + 1;
  const fieldEnd = text.indexOf('\n', symbol.range.end);
  const field = {
    start: fieldStart,
    end: fieldEnd === -1 ? text.length : fieldEnd + 1,
  };
  if (!ctor) {
    const cls = doc.symbols?.find(
      (s) => s.kind === 'class' && s.name === symbol.scope
    );
    if (cls?.extends) {
      return {
        ok: false,
        error: `${symbol.scope} extends ${cls.extends}: add a constructor that calls super() first.`,
      };
    }

    // The field's line becomes the constructor.
    const indent = text.slice(fieldStart, symbol.range.start);
    return {
      ok: true,
      edits: [{ ...field, text: `${indent}constructor(${param}) {}\n` }],
    };
  }

  // After the last parameter, or inside `()`.
  const params = ctor.params ?? [];
  const last = params.at(-1);
  const open = text.indexOf('(', ctor.nameRange.end);
  const insert = last
    ? { start: paramEnd(text, last), text: `, ${param}` }
    : { start: open + 1, text: param };
  return {
    ok: true,
    edits: [
      { start: field.start, end: field.end, text: '' },
      { start: insert.start, end: insert.start, text: insert.text },
    ],
  };
}

/** End of a parameter in the code (with its type and default value). */
function paramEnd(text: string, param: SymbolParam): number {
  return Math.max(
    param.nameRange.end,
    param.type?.range.end ?? 0,
    param.defaultRange?.end ?? 0
  );
}
/**
 * Sets or clears a modifier of a declaration (`const`, access levels,
 * `async`, `export`, `static`, `readonly`, constructor parameters).
 */
export function setModifier(
  text: string,
  doc: GraphDocument,
  symbol: ScriptSymbol,
  modifier: string,
  enabled: boolean
): OpResult {
  if (KINDS.includes(modifier)) {
    if (!enabled) {
      return { ok: true, edits: [] };
    }

    const keyword = replaceKeyword(text, symbol, KINDS, modifier);
    return modifier === 'const' && !symbol.defaultRange
      ? withStartValue(keyword, symbol, TYPESCRIPT_TYPES, 'undefined')
      : keyword;
  }

  if (modifier === 'constructor') {
    return setConstructorParameter(text, doc, symbol, enabled);
  }

  if (ACCESS.includes(modifier)) {
    if (!enabled) {
      return { ok: true, edits: [] };
    }

    if (symbol.scope === '' || symbol.kind === 'local') {
      return { ok: false, error: 'Only class members have an access level.' };
    }

    const current = symbol.modifiers.find((m) => ACCESS.includes(m));
    if (modifier === 'public') {
      // Public is the default: no keyword.
      return current && current !== 'public'
        ? removeModifier(text, symbol, current)
        : { ok: true, edits: [] };
    }

    if (current) {
      return replaceKeyword(text, symbol, ACCESS, modifier);
    }

    // The access level comes first (`private static readonly`), after the
    // decorators.
    const at = afterDecorators(
      text,
      (symbol.declarationRange ?? symbol.range).start
    );
    return { ok: true, edits: [{ start: at, end: at, text: `${modifier} ` }] };
  }

  if (modifier === 'async') {
    // An async function returns a `Promise` of its declared type.
    const returns = symbol.returns;
    const wrapped = returns ? /^Promise<(.*)>$/s.exec(returns.text) : null;
    if (!enabled) {
      const removed = removeModifier(text, symbol, 'async');
      return removed.ok && returns && wrapped?.[1]
        ? {
            ok: true,
            edits: [...removed.edits, { ...returns.range, text: wrapped[1] }],
          }
        : removed;
    }

    const promised: TextEdit[] =
      returns && !wrapped
        ? [{ ...returns.range, text: `Promise<${returns.text}>` }]
        : [];
    const start = (symbol.declarationRange ?? symbol.range).start;
    const head = text.slice(start, symbol.nameRange.start);
    const fn = head.search(/\bfunction\b/);
    if (symbol.kind === 'method') {
      // Before the name (or the `*` of a generator).
      const star = head.trimEnd().endsWith('*')
        ? start + head.trimEnd().length - 1
        : symbol.nameRange.start;
      return {
        ok: true,
        edits: [{ start: star, end: star, text: 'async ' }, ...promised],
      };
    }

    if (fn === -1) {
      return { ok: false, error: 'Change async in the code of this function.' };
    }

    return {
      ok: true,
      edits: [
        { start: start + fn, end: start + fn, text: 'async ' },
        ...promised,
      ],
    };
  }

  if (modifier === 'export') {
    if (symbol.scope !== '' || symbol.kind === 'local') {
      return { ok: false, error: 'Only module declarations can be exported.' };
    }

    if (!enabled) {
      return removeModifier(
        text,
        symbol,
        symbol.modifiers.includes('export default')
          ? 'export default'
          : 'export'
      );
    }

    const at = afterDecorators(
      text,
      (symbol.declarationRange ?? symbol.range).start
    );
    return { ok: true, edits: [{ start: at, end: at, text: 'export ' }] };
  }

  if (modifier === 'static' || modifier === 'readonly') {
    if (symbol.scope === '' || symbol.kind === 'local') {
      return { ok: false, error: `Only class members can be ${modifier}.` };
    }

    if (!enabled) {
      return removeModifier(text, symbol, modifier);
    }

    // `private static async name()`, `static readonly name`: static goes
    // before readonly, async, get and set; readonly right before the name.
    const lineStart = text.lastIndexOf('\n', symbol.nameRange.start - 1) + 1;
    const head = text.slice(lineStart, symbol.nameRange.start);
    const later = head.search(/\b(?:readonly|async|get|set)\b|\*/);
    const at =
      modifier === 'static' && later !== -1
        ? lineStart + later
        : symbol.nameRange.start;
    return { ok: true, edits: [{ start: at, end: at, text: `${modifier} ` }] };
  }

  return { ok: false, error: `Unknown modifier ${modifier}.` };
}
