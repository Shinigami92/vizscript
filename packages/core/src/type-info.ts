import type { CallPinOptions } from './call-pins';
import { withParamPins } from './call-pins';
import type {
  DataType,
  FunctionGraph,
  GraphDocument,
  GraphNode,
  Pin,
  SourceRange,
} from './ir';
import type { ScriptSymbol, SymbolParam } from './symbols';
import { typeWildcardPins } from './wildcard-pins';

/** A field or method of a type, for the action menu (`response.ok`). */
export interface TypeMember {
  name: string;
  kind: 'property' | 'method';
  /** Type of the property, or the result of the method. */
  type: DataType;
  /** Signature as the language writes it (`json(): Promise<any>`). */
  detail?: string;
}

/** The type a type checker sees at a place in the code. */
export interface TypeInfo {
  /** As the language writes it: `Response`, `Promise<User[]>`. */
  text: string;
  /** The pin type it maps to (colors, compatibility of wires). */
  dataType: DataType;
  /** Fields and methods of the type, when it has any. */
  members?: ReadonlyArray<TypeMember>;
  /**
   * At a call: the parameters of what it calls (`headers.get(name)`), so
   * the call node gets a pin for each, like calls of the file's functions.
   * Portable: default values are text.
   */
  signature?: ReadonlyArray<SymbolParam>;
}

/** What `applyTypes` needs to give calls pins for their parameters. */
export interface CallTyping {
  /** The text the document was parsed from. */
  text: string;
  options: Pick<CallPinOptions, 'placeholder' | 'keywordArguments'>;
}

/**
 * Answers which type the code has at ranges of a text: a language service
 * (TypeScript's) or a backend's own type lookup. One answer per range,
 * `undefined` where it doesn't know.
 */
export interface TypeProvider {
  typesAt(
    text: string,
    fileName: string,
    ranges: ReadonlyArray<SourceRange>
  ): Promise<ReadonlyArray<TypeInfo | undefined>>;
}

/** Types by range, keyed with {@link rangeKey}. */
export type TypeMap = ReadonlyMap<string, TypeInfo>;

export function rangeKey(range: SourceRange): string {
  return `${range.start}:${range.end}`;
}

const VARIABLE_KINDS = new Set(['variable', 'constant', 'local', 'member']);

function isQueryPin(pin: Pin): pin is Pin & { range: SourceRange } {
  return pin.kind === 'data' && pin.direction === 'out' && !!pin.range;
}

function untyped(symbol: { type?: unknown }): boolean {
  return symbol.type === undefined;
}

/**
 * Places whose type a checker can make exact: the values of data outputs,
 * and the names of variables and parameters declared without a type.
 * Inputs keep the type of what they take (a parameter's type), which is
 * not the type of the value written into them. Sorted, without duplicates.
 */
export function typeQueries(doc: GraphDocument): SourceRange[] {
  const ranges = new Map<string, SourceRange>();
  const add = (range: SourceRange): void => {
    ranges.set(rangeKey(range), range);
  };

  for (const fn of doc.functions) {
    for (const node of fn.nodes) {
      if (node.graphOnly) {
        continue;
      }

      for (const pin of node.pins) {
        if (isQueryPin(pin)) {
          add(pin.range);
        }
      }
    }
  }

  for (const symbol of doc.symbols ?? []) {
    if (VARIABLE_KINDS.has(symbol.kind) && untyped(symbol)) {
      add(symbol.nameRange);
    }

    for (const param of symbol.params ?? []) {
      if (untyped(param)) {
        add(param.nameRange);
      }
    }
  }

  return [...ranges.values()].toSorted(
    (a, b) => a.start - b.start || a.end - b.end
  );
}

/** A checker's answer that says more than the parser: not `any`. */
function useful(info: TypeInfo | undefined): info is TypeInfo {
  return info !== undefined && info.dataType !== 'any';
}

function typedPin(pin: Pin, types: TypeMap): Pin {
  const info = isQueryPin(pin) ? types.get(rangeKey(pin.range)) : undefined;
  if (!useful(info)) {
    return pin;
  }

  return { ...pin, type: info.dataType, typeText: info.text };
}

/**
 * The parameters a call node calls, from the answer for its result, when
 * the parser couldn't complete its pins (no `param:` pins yet).
 */
function calledParams(
  node: GraphNode,
  types: TypeMap
): ReadonlyArray<SymbolParam> | undefined {
  if (
    node.kind !== 'call' ||
    node.pins.some((p) => p.id.startsWith('param:'))
  ) {
    return undefined;
  }

  const result = node.pins.find((p) => p.id === 'return' && p.range);
  return result?.range
    ? types.get(rangeKey(result.range))?.signature
    : undefined;
}

function typedNode(
  node: GraphNode,
  types: TypeMap,
  wired: ReadonlySet<string>,
  calls: CallTyping | undefined
): GraphNode {
  let changed = false;
  const params = calls ? calledParams(node, types) : undefined;
  let pins = node.pins.flatMap((pin) => {
    const next = typedPin(pin, types);
    // A result of nothing (`void`) has no pin, like a UE function without
    // outputs, unless the code uses it anyway.
    if (next.type === 'void' && next !== pin && !wired.has(pin.id)) {
      changed = true;
      return [];
    }

    changed ||= next !== pin;
    return [next];
  });
  // A SET takes the type of its variable: its value input too, unless the
  // parser knew better (`const response = await fetch(url)`).
  const out =
    node.kind === 'setVar' ? pins.find((p) => p.id === 'out') : undefined;
  const value = pins.find(
    (p) => p.id === 'value' && p.direction === 'in' && p.type === 'any'
  );
  if (out?.typeText !== undefined && value) {
    pins[pins.indexOf(value)] = { ...value, type: out.type };
    changed = true;
  }

  if (calls && params && params.length > 0) {
    pins = withParamPins(calls.text, { ...node, pins }, params, calls.options);
    changed = true;
  }

  return changed ? { ...node, pins } : node;
}

function typedFunction(
  fn: FunctionGraph,
  types: TypeMap,
  calls: CallTyping | undefined
): FunctionGraph {
  const wired = new Map<string, Set<string>>();
  for (const edge of fn.edges) {
    const pins = wired.get(edge.from.node) ?? new Set<string>();
    pins.add(edge.from.pin);
    wired.set(edge.from.node, pins);
  }

  let changed = false;
  const nodes = fn.nodes.map((node) => {
    const next = typedNode(node, types, wired.get(node.id) ?? new Set(), calls);
    changed ||= next !== node;
    return next;
  });
  return changed ? { ...fn, nodes } : fn;
}

function typedParam(param: SymbolParam, types: TypeMap): SymbolParam {
  const info = untyped(param)
    ? types.get(rangeKey(param.nameRange))
    : undefined;
  return useful(info) ? { ...param, dataType: info.dataType } : param;
}

function typedSymbol(symbol: ScriptSymbol, types: TypeMap): ScriptSymbol {
  const info =
    VARIABLE_KINDS.has(symbol.kind) && untyped(symbol)
      ? types.get(rangeKey(symbol.nameRange))
      : undefined;
  let next = useful(info) ? { ...symbol, dataType: info.dataType } : symbol;
  if (symbol.params) {
    const params = symbol.params.map((p) => typedParam(p, types));
    if (params.some((p, i) => p !== symbol.params?.[i])) {
      next = { ...next, params };
    }
  }

  return next;
}

/**
 * The document with the checker's types: data outputs get the exact type
 * (and `Pin.typeText`), unwired `void` results lose their pin, untyped
 * variables and parameters get their inferred type, and `typeMembers` the
 * members of every type seen, by its text. Untyped operator inputs follow
 * their wires (`typeWildcardPins`). Answers of `any` keep what the
 * parser found. Unchanged parts are shared, not copied.
 *
 * With `calls`, calls whose answer has a `signature` get a pin for each
 * parameter (`withParamPins`).
 *
 * `types` must come from the same text the document was parsed from.
 */
export function applyTypes(
  doc: GraphDocument,
  types: TypeMap,
  calls?: CallTyping
): GraphDocument {
  if (types.size === 0) {
    return doc;
  }

  const typeMembers: Record<string, ReadonlyArray<TypeMember>> = {
    ...doc.typeMembers,
  };
  for (const info of types.values()) {
    if (useful(info) && info.members && !(info.text in typeMembers)) {
      typeMembers[info.text] = info.members;
    }
  }

  return {
    ...doc,
    functions: doc.functions.map((fn) =>
      typeWildcardPins(typedFunction(fn, types, calls))
    ),
    ...(doc.symbols
      ? { symbols: doc.symbols.map((s) => typedSymbol(s, types)) }
      : {}),
    ...(Object.keys(typeMembers).length > 0 ? { typeMembers } : {}),
  };
}

/**
 * Asks `provider` for the types of `doc` (parsed from `text`) and applies
 * them. A failing provider leaves the document as the parser made it.
 */
export async function resolveTypes(
  doc: GraphDocument,
  text: string,
  fileName: string,
  provider: TypeProvider,
  options?: CallTyping['options']
): Promise<GraphDocument> {
  const types = await checkTypes(doc, text, fileName, provider);
  return types
    ? applyTypes(doc, types, options ? { text, options } : undefined)
    : doc;
}

/**
 * Asks `provider` for the types of `doc` (parsed from `text`), by range;
 * `undefined` when there is nothing to ask or the provider failed.
 */
export async function checkTypes(
  doc: GraphDocument,
  text: string,
  fileName: string,
  provider: TypeProvider
): Promise<TypeMap | undefined> {
  const ranges = typeQueries(doc);
  if (ranges.length === 0) {
    return undefined;
  }

  let answers: ReadonlyArray<TypeInfo | undefined>;
  try {
    answers = await provider.typesAt(text, fileName, ranges);
  } catch {
    return undefined;
  }

  const types = new Map<string, TypeInfo>();
  for (const [index, range] of ranges.entries()) {
    const info = answers[index];
    if (info) {
      types.set(rangeKey(range), info);
    }
  }

  return types;
}
