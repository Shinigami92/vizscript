import type { DataType, FunctionGraph, SourceRange } from '@vizscript/core';
import type { Expr, FuncDecl, Span, Stmt } from './ast';

export type EvalMode = 'eager' | 'lazy';

export interface Signature {
  params: string[];
  returnType: DataType;
}

export type GraphSource =
  | {
      type: 'class';
      name: string;
      body: Stmt[];
      subtitle: string;
      range: Span;
      /** Prefix of member function names (`Inner.` for inner classes). */
      prefix: string;
    }
  | { type: 'func'; name: string; kind: string; fn: FuncDecl };

/** What the function builders need from the document being lowered. */
export interface LoweringContext {
  readonly text: string;
  readonly fileName: string;
  readonly functions: FunctionGraph[];
  readonly queue: GraphSource[];
  readonly signatures: Map<string, Signature>;
  /** Types of the script's member variables and constants. */
  readonly memberTypes: Map<string, DataType>;
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

/** `a.b.c` style chains (including `self`, `super` and `$Node`). */
export function simpleChain(expr: Expr, text: string): string[] | undefined {
  const e = unwrap(expr);
  switch (e.type) {
    case 'Identifier': {
      return [e.name];
    }

    case 'Self': {
      return ['self'];
    }

    case 'Super': {
      return ['super'];
    }

    case 'NodePath': {
      return [text.slice(e.start, e.end)];
    }

    case 'Attribute': {
      const head = simpleChain(e.object, text);
      return head ? [...head, e.name] : undefined;
    }

    default: {
      return undefined;
    }
  }
}
