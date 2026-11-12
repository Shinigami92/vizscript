import type { DataType, FunctionGraph, SourceRange } from '@vizscript/core';
import type { Block, Expr, FunctionItem, Param, Span, ValueItem } from './ast';

export interface Signature {
  params: string[];
  returnType: DataType;
}

export interface ClosureSource {
  params: Param[];
  body: Expr | Block;
  returns?: Span;
  start: number;
  end: number;
}

export type GraphSource =
  | { type: 'module'; items: ValueItem[] }
  | {
      type: 'function';
      name: string;
      kind: string;
      /** Type of `self` (the impl's type). */
      owner?: string;
      fn: FunctionItem | ClosureSource;
    };

/** What the function builders need from the document being lowered. */
export interface LoweringContext {
  readonly text: string;
  readonly fileName: string;
  readonly functions: FunctionGraph[];
  readonly queue: GraphSource[];
  readonly signatures: Map<string, Signature>;
  /** Types of constants and statics. */
  readonly globals: Map<string, DataType>;
  uniqueFunctionId(name: string): string;
}

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

/** `a.b.c` and `a::b` chains (no calls). */
export function simpleChain(expr: Expr): string[] | undefined {
  const e = unwrap(expr);
  if (e.type === 'Name') {
    return [e.name];
  }

  if (e.type === 'Field') {
    const head = simpleChain(e.object);
    return head ? [...head, e.name] : undefined;
  }

  return undefined;
}

/** Expressions that end in a block (no `;` needed as a statement). */
export function isBlock(body: Block | Expr): body is Block {
  return 'body' in body && 'open' in body && !('type' in body);
}

/** The value of a block that is just one expression (`{ a }`). */
export function only(block: Block | undefined): Expr | undefined {
  const [first] = block?.body ?? [];
  return block?.body.length === 1 && first?.type === 'Expr' && !first.semicolon
    ? first.value
    : undefined;
}
