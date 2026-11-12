import type { DataType, FunctionGraph, SourceRange } from '@vizscript/core';
import { arrayOf } from '@vizscript/core';
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

/** Maps a type annotation (as written) to a pin type. */
export function dataTypeOf(annotation: string | undefined): DataType {
  if (!annotation) {
    return 'any';
  }

  const type = annotation.replaceAll(/\s+/g, '');
  const optional = type.match(/^(?:Optional\[(.+)\]|(.+)\|None|None\|(.+))$/);
  if (optional) {
    return dataTypeOf(optional[1] ?? optional[2] ?? optional[3]);
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

  // `list[int]`, `Sequence[Item]`, `tuple[str, ...]` → typed arrays.
  const generic = type.match(
    /^(?:list|List|Sequence|Iterable|Iterator|set|Set|frozenset|(?:collections\.abc\.)?\w*Sequence)\[(.+)\]$/
  );
  if (generic) {
    return arrayOf(dataTypeOf(generic[1]));
  }

  const homogeneous = type.match(/^(?:tuple|Tuple)\[(.+),\.\.\.\]$/);
  if (homogeneous) {
    return arrayOf(dataTypeOf(homogeneous[1]));
  }

  if (
    /^(list|List|tuple|Tuple|Sequence|Iterable|Iterator|set|Set|frozenset)\b/.test(
      type
    )
  ) {
    return 'array';
  }

  if (/^(dict|Dict|Mapping|MutableMapping|TypedDict)\b/.test(type)) {
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
