import type { DataType, FunctionGraph, SourceRange } from '@vizscript/core';
import { arrayOf, mapOf, setOf } from '@vizscript/core';
import type { ClassDef, Expr, FunctionDef, Param, Span, Stmt } from './ast';

export const COMPARISONS = new Set([
  '==',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  'in',
  'not in',
  'is',
  'is not',
]);

/** Splits `A, B[C, D]` at top-level commas (or another separator). */
function splitTypes(text: string, separator = ','): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '[' || char === '(') {
      depth++;
    } else if (char === ']' || char === ')') {
      depth--;
    } else if (char === separator && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }

  parts.push(text.slice(start));
  return parts.filter((part) => part !== '');
}

/** Maps a type annotation (as written) to a pin type. */
export function dataTypeOf(annotation: string | undefined): DataType {
  if (!annotation) {
    return 'any';
  }

  const type = annotation.replaceAll(/\s+/g, '');
  const optional = type.match(/^Optional\[(.+)\]$/);
  if (optional) {
    return dataTypeOf(optional[1]);
  }

  // `int | str`, `Union[int, str]`: one pin type when all parts agree.
  const union = type.match(/^Union\[(.+)\]$/);
  const parts = union ? splitTypes(union[1] ?? '') : splitTypes(type, '|');
  if (parts.length > 1) {
    const types = new Set(
      parts.filter((p) => p !== 'None').map((p) => dataTypeOf(p))
    );
    const [only] = types;
    return types.size === 1 && only !== undefined ? only : 'any';
  }

  // `Literal["a", "b"]`: the type of its values.
  const literal = type.match(/^(?:typing\.)?Literal\[(.+)\]$/);
  if (literal) {
    const first = splitTypes(literal[1] ?? '')[0] ?? '';
    return /^["']/.test(first)
      ? 'string'
      : /^(?:True|False)$/.test(first)
        ? 'bool'
        : /^-?\d/.test(first)
          ? 'number'
          : 'any';
  }

  if (/^(int|float|complex|Decimal)$/.test(type)) {
    return 'number';
  }

  if (/^(str|LiteralString)$/.test(type)) {
    return 'string';
  }

  if (type === 'bool') {
    return 'bool';
  }

  if (type === 'None') {
    return 'void';
  }

  if (type === 'Any' || type === 'object') {
    return 'any';
  }

  // `set[int]` → typed sets, `dict[str, int]` → typed maps.
  const set = type.match(
    /^(?:typing\.)?(?:set|Set|frozenset|FrozenSet|AbstractSet|MutableSet)(?:\[(.+)\])?$/
  );
  if (set) {
    return setOf(dataTypeOf(set[1]));
  }

  const map = type.match(
    /^(?:typing\.|collections\.)?(?:dict|Dict|Mapping|MutableMapping|defaultdict|DefaultDict|OrderedDict|Counter)(?:\[(.+)\])?$/
  );
  if (map) {
    const [key, value] = splitTypes(map[1] ?? '');
    return mapOf(
      dataTypeOf(key),
      (type.split('[')[0] ?? '').endsWith('Counter')
        ? 'number'
        : dataTypeOf(value)
    );
  }

  // `list[int]`, `Sequence[Item]`, `tuple[str, ...]` → typed arrays.
  const generic = type.match(
    /^(?:list|List|Sequence|Iterable|Iterator|(?:collections\.abc\.)?\w*Sequence)\[(.+)\]$/
  );
  if (generic) {
    return arrayOf(dataTypeOf(generic[1]));
  }

  const homogeneous = type.match(/^(?:tuple|Tuple)\[(.+),\.\.\.\]$/);
  if (homogeneous) {
    return arrayOf(dataTypeOf(homogeneous[1]));
  }

  if (/^(list|List|tuple|Tuple|Sequence|Iterable|Iterator)\b/.test(type)) {
    return 'array';
  }

  if (/^TypedDict\b/.test(type)) {
    return 'object';
  }

  if (/^(Callable|collections\.abc\.Callable)\b/.test(type)) {
    return 'function';
  }

  return type.split('[')[0] ?? type;
}

export interface Signature {
  params: string[];
  returnType: DataType;
}

export interface LambdaSource {
  params: Param[];
  body: Expr;
  start: number;
  end: number;
}

export type GraphSource =
  | { type: 'module'; body: Stmt[] }
  | { type: 'class'; name: string; cls: ClassDef }
  | {
      type: 'function';
      name: string;
      kind: string;
      fn: FunctionDef | LambdaSource;
    };

export function rangeOf(node: Span): SourceRange {
  return { start: node.start, end: node.end };
}

export function unwrap(expr: Expr): Expr {
  let current = expr;
  while (current.type === 'Paren') {
    current = current.expr;
  }

  return current;
}

/** `a.b.c` style chains. */
export function simpleChain(expr: Expr): string[] | undefined {
  const e = unwrap(expr);
  if (e.type === 'Name') {
    return [e.name];
  }

  if (e.type === 'Attribute') {
    const head = simpleChain(e.object);
    return head ? [...head, e.name] : undefined;
  }

  return undefined;
}

/** Statements that only declare things (no exec node in the graph). */
export function isDeclarationOnly(stmt: Stmt): boolean {
  return (
    stmt.type === 'Import' ||
    stmt.type === 'Scope' ||
    stmt.type === 'Pass' ||
    stmt.type === 'FunctionDef' ||
    stmt.type === 'ClassDef' ||
    // Docstrings
    (stmt.type === 'Expr' && unwrap(stmt.value).type === 'Literal')
  );
}

/** What a function builder needs from the document being lowered. */
export interface DocumentContext {
  readonly text: string;
  readonly fileName: string;
  readonly functions: FunctionGraph[];
  readonly queue: GraphSource[];
  readonly signatures: Map<string, Signature>;
  readonly globals: Map<string, DataType>;
  uniqueFunctionId(name: string): string;
}
