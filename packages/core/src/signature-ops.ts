import type { DeclarationSyntax } from './declaration-syntax';
import type { GraphDocument, SourceRange } from './ir';
import type { OpResult, TextEdit, ValueKind } from './ops';
import { setSymbolType, setSymbolValue } from './symbol-edits';
import type { ScriptSymbol, SymbolParam } from './symbols';
import { qualifiedName } from './symbols';

/**
 * A call of a function in the same file, for keeping its arguments in sync
 * with the parameters (UE updates all call nodes when an input changes).
 */
export interface CallSite {
  /** Offset right after `(`. */
  open: number;
  /** Offset of `)`. */
  close: number;
  /** Positional arguments, in order. */
  args: SourceRange[];
  /** Keyword arguments (`name=value` in Python). */
  keywords?: Array<{ name: string; range: SourceRange }>;
}

function failed(error: string): OpResult {
  return { ok: false, error };
}

function succeeded(edits: TextEdit[]): OpResult {
  return { ok: true, edits };
}

/** Symbols with parameters: functions, methods and signals. */
const FUNCTION_KINDS = new Set(['function', 'method', 'signal']);

function functionSymbol(doc: GraphDocument, id: string): ScriptSymbol | string {
  const symbol = doc.symbols?.find((s) => s.id === id);
  if (!symbol) {
    return 'Unknown symbol.';
  }

  return FUNCTION_KINDS.has(symbol.kind) && symbol.params
    ? symbol
    : `${symbol.name} is not a function.`;
}

/** The parameter list: offsets after `(` and of `)`. */
function parameterList(
  text: string,
  symbol: ScriptSymbol
): { open: number; close: number } | undefined {
  const open = text.indexOf('(', symbol.nameRange.end);
  if (open === -1 || open > symbol.range.end) {
    return undefined;
  }

  let depth = 0;
  let quote: string | undefined;
  for (let i = open; i < symbol.range.end; i++) {
    const char = text[i];
    if (quote) {
      if (char === '\\') {
        i++;
      } else if (char === quote) {
        quote = undefined;
      }

      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char;
    } else if (char === '(' || char === '[' || char === '{') {
      depth++;
    } else if (char === ')' || char === ']' || char === '}') {
      depth--;
      if (depth === 0) {
        return { open: open + 1, close: i };
      }
    }
  }

  return undefined;
}

/** Whole text of a parameter: `...rest`, `*args`, `name: T = value`. */
function paramRange(text: string, param: SymbolParam): SourceRange {
  let start = param.nameRange.start;
  while (start > 0 && (text[start - 1] === '.' || text[start - 1] === '*')) {
    start--;
  }

  const end = Math.max(
    param.nameRange.end,
    param.type?.range.end ?? 0,
    param.defaultRange?.end ?? 0
  );
  return { start, end };
}

function isSpace(char: string | undefined): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r';
}

/** Removes an item of a comma separated list, with one of its commas. */
function removeItem(
  text: string,
  item: SourceRange,
  list: { open: number; close: number }
): TextEdit {
  let before = item.start;
  while (before > list.open && isSpace(text[before - 1])) {
    before--;
  }

  if (text[before - 1] === ',' && before - 1 >= list.open) {
    // `a, item` → `a`
    return { start: before - 1, end: item.end, text: '' };
  }

  let after = item.end;
  while (after < list.close && isSpace(text[after])) {
    after++;
  }

  if (text[after] === ',') {
    // `item, b` → `b`
    after++;
    while (after < list.close && isSpace(text[after])) {
      after++;
    }

    return { start: item.start, end: after, text: '' };
  }

  return { start: list.open, end: list.close, text: '' };
}

/** Appends an item to a list (`()` → `(item)`, `(a)` → `(a, item)`). */
function appendItem(
  text: string,
  list: { open: number; close: number },
  item: string
): TextEdit {
  let end = list.close;
  while (end > list.open && isSpace(text[end - 1])) {
    end--;
  }

  if (end === list.open) {
    return { start: list.open, end: list.close, text: item };
  }

  return {
    start: end,
    end,
    text: text[end - 1] === ',' ? ` ${item}` : `, ${item}`,
  };
}

/** Same-file calls, with a uniform error when a backend has none. */
function callsOf(
  text: string,
  doc: GraphDocument,
  symbol: ScriptSymbol,
  syntax: DeclarationSyntax
): CallSite[] {
  return syntax.callSites?.(text, doc, symbol) ?? [];
}

export function addParameter(
  text: string,
  doc: GraphDocument,
  id: string,
  name: string,
  typeText: string | undefined,
  argument: string | undefined,
  placeholder: string,
  syntax: DeclarationSyntax
): OpResult {
  const symbol = functionSymbol(doc, id);
  if (typeof symbol === 'string') {
    return failed(symbol);
  }

  const params = symbol.params ?? [];
  if (params.some((p) => p.name === name)) {
    return failed(`"${name}" already exists here.`);
  }

  if (!syntax.identifier.test(name) || syntax.keywords.has(name)) {
    return failed(`"${name}" is not a valid name.`);
  }

  const type = typeText?.trim() || syntax.typeSystem.requiredType;
  if (type) {
    const error = syntax.validType(type);
    if (error) {
      return failed(error);
    }
  }

  const list = parameterList(text, symbol);
  if (!list && symbol.kind === 'signal' && params.length === 0) {
    // `signal changed` → `signal changed(value)`
    const param = `${name}${type ? `: ${type}` : ''}`;
    const at = symbol.nameRange.end;
    const value = argument ?? placeholder;
    return succeeded([
      { start: at, end: at, text: `(${param})` },
      // Emits pass every argument (`changed.emit()` → `changed.emit(null)`).
      ...callsOf(text, doc, symbol, syntax)
        .filter((call) => call.args.length === 0)
        .map((call) => appendItem(text, call, value)),
    ]);
  }

  if (!list) {
    return failed(`Cannot find the parameters of ${symbol.name}.`);
  }

  if (params.at(-1)?.rest) {
    return failed('Parameters cannot follow a rest parameter.');
  }

  // After parameters with defaults a new one needs a default too.
  const value = argument ?? placeholder;
  const needsDefault = params.some((p) => p.defaultRange);
  const param = `${name}${type ? `: ${type}` : ''}${needsDefault ? ` = ${value}` : ''}`;
  const edits: TextEdit[] = [appendItem(text, list, param)];

  if (!needsDefault) {
    // Calls that pass every argument get one for the new parameter.
    for (const call of callsOf(text, doc, symbol, syntax)) {
      if (call.args.length === params.length && !call.keywords?.length) {
        edits.push(appendItem(text, call, value));
      }
    }
  }

  return succeeded(edits);
}

export function removeParameter(
  text: string,
  doc: GraphDocument,
  id: string,
  index: number,
  syntax: DeclarationSyntax
): OpResult {
  const symbol = functionSymbol(doc, id);
  if (typeof symbol === 'string') {
    return failed(symbol);
  }

  const param = symbol.params?.[index];
  const list = parameterList(text, symbol);
  if (!param || !list) {
    return failed('Unknown parameter.');
  }

  const edits: TextEdit[] = [removeItem(text, paramRange(text, param), list)];
  for (const call of callsOf(text, doc, symbol, syntax)) {
    const arg = call.args[index];
    const keyword = call.keywords?.find((k) => k.name === param.name);
    if (arg && !param.rest) {
      edits.push(removeItem(text, arg, call));
    } else if (keyword) {
      edits.push(removeItem(text, keyword.range, call));
    }
  }

  return succeeded(edits);
}

/** Reorders items: the text of `from` goes to `to`, the others shift. */
function reorder(
  text: string,
  items: ReadonlyArray<SourceRange>,
  from: number,
  to: number
): TextEdit[] {
  const sources = items.map((r) => text.slice(r.start, r.end));
  const moved = [...sources];
  const [item] = moved.splice(from, 1);
  moved.splice(to, 0, item ?? '');
  return items
    .map((range, i) => ({
      start: range.start,
      end: range.end,
      text: moved[i] ?? '',
    }))
    .filter((edit, i) => edit.text !== sources[i]);
}

export function moveParameter(
  text: string,
  doc: GraphDocument,
  id: string,
  from: number,
  to: number,
  syntax: DeclarationSyntax
): OpResult {
  const symbol = functionSymbol(doc, id);
  if (typeof symbol === 'string') {
    return failed(symbol);
  }

  const params = symbol.params ?? [];
  if (!params[from] || !params[to] || from === to) {
    return succeeded([]);
  }

  if (params.some((p) => p.rest)) {
    return failed('Parameters cannot be moved around a rest parameter.');
  }

  const edits = reorder(
    text,
    params.map((p) => paramRange(text, p)),
    from,
    to
  );
  const last = Math.max(from, to);
  for (const call of callsOf(text, doc, symbol, syntax)) {
    if (call.args.length > last) {
      edits.push(...reorder(text, call.args.slice(0, last + 1), from, to));
    }
  }

  return succeeded(edits);
}

/** A parameter as a variable of the function, for the variable ops. */
function paramSymbol(symbol: ScriptSymbol, param: SymbolParam): ScriptSymbol {
  return {
    id: `param:${qualifiedName(symbol)}.${param.name}`,
    kind: 'local',
    name: param.name,
    scope: qualifiedName(symbol),
    range: param.nameRange,
    nameRange: param.nameRange,
    ...(param.type ? { type: param.type } : {}),
    dataType: param.dataType,
    ...(param.defaultRange ? { defaultRange: param.defaultRange } : {}),
    modifiers: [],
  };
}

/** Runs a variable op on a parameter (type, default value, rename). */
function withParam(
  doc: GraphDocument,
  id: string,
  index: number,
  run: (doc: GraphDocument, param: ScriptSymbol, fn: ScriptSymbol) => OpResult
): OpResult {
  const symbol = functionSymbol(doc, id);
  if (typeof symbol === 'string') {
    return failed(symbol);
  }

  const param = symbol.params?.[index];
  if (!param) {
    return failed('Unknown parameter.');
  }

  const variable = paramSymbol(symbol, param);
  return run(
    { ...doc, symbols: [...(doc.symbols ?? []), variable] },
    variable,
    symbol
  );
}

export function renameParameter(
  text: string,
  doc: GraphDocument,
  id: string,
  index: number,
  name: string,
  syntax: DeclarationSyntax
): OpResult {
  return withParam(doc, id, index, (withVariable, param, fn) => {
    if (param.name === name) {
      return succeeded([]);
    }

    if (!syntax.identifier.test(name) || syntax.keywords.has(name)) {
      return failed(`"${name}" is not a valid name.`);
    }

    const taken = [
      ...(fn.params ?? []).map((p) => p.name),
      ...(doc.symbols ?? [])
        .filter((s) => s.kind === 'local' && s.scope === qualifiedName(fn))
        .map((s) => s.name),
    ];
    if (taken.includes(name)) {
      return failed(`"${name}" already exists here.`);
    }

    return syntax.rename(text, withVariable, param, name);
  });
}

export function setParameterType(
  text: string,
  doc: GraphDocument,
  id: string,
  index: number,
  typeText: string | null,
  syntax: DeclarationSyntax
): OpResult {
  return withParam(doc, id, index, (withVariable, param) =>
    !typeText?.trim() && syntax.typeSystem.requiredType !== undefined
      ? failed(`${param.name} needs a type.`)
      : setSymbolType(text, withVariable, param.id, typeText, {
          ...syntax,
          valueRequired: () => false,
        })
  );
}

export function setParameterValue(
  text: string,
  doc: GraphDocument,
  id: string,
  index: number,
  value: string | null,
  kind: ValueKind,
  syntax: DeclarationSyntax
): OpResult {
  return withParam(doc, id, index, (withVariable, param) =>
    setSymbolValue(text, withVariable, param.id, value, kind, {
      ...syntax,
      valueRequired: () => false,
    })
  );
}

export function setReturnType(
  text: string,
  doc: GraphDocument,
  id: string,
  typeText: string | null,
  syntax: DeclarationSyntax
): OpResult {
  const symbol = functionSymbol(doc, id);
  if (typeof symbol === 'string') {
    return failed(symbol);
  }

  if (symbol.kind === 'signal') {
    return failed('Signals have no output.');
  }

  const type = typeText?.trim() || null;
  if (type) {
    const error = syntax.validType(type);
    if (error) {
      return failed(error);
    }
  }

  const list = parameterList(text, symbol);
  if (!list) {
    return failed(`Cannot find the parameters of ${symbol.name}.`);
  }

  const after = list.close + 1;
  if (symbol.returns) {
    return succeeded([
      {
        start: after,
        end: symbol.returns.range.end,
        text: type ? `${syntax.returnArrow}${type}` : '',
      },
    ]);
  }

  return succeeded(
    type
      ? [{ start: after, end: after, text: `${syntax.returnArrow}${type}` }]
      : []
  );
}
