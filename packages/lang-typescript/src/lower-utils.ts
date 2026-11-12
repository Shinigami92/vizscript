import type * as t from '@babel/types';
import type {
  DataType,
  FunctionGraph,
  Pin,
  PinLiteral,
  PinRef,
  SourceRange,
} from '@vizscript/core';
import { truncate } from '@vizscript/core';

export type AnyFunction =
  | t.FunctionDeclaration
  | t.FunctionExpression
  | t.ArrowFunctionExpression
  | t.ObjectMethod
  | t.ClassMethod
  | t.ClassPrivateMethod;

export interface PendingFunction {
  name: string;
  kind: string;
  fn: AnyFunction;
}

/** A value feeding an input pin: either a wire or an inline literal. */
export type ValueSource =
  | { pin: PinRef; type: DataType }
  | { literal: PinLiteral; type: DataType };

export type EvalMode = 'eager' | 'lazy';

export interface ScopeEntry {
  source?: PinRef;
  type: DataType;
}

export interface InputSpec {
  pin: Pin;
  value: ValueSource | undefined;
}

/** Top-level statements that do not produce exec nodes. */
export const DECLARATION_ONLY = new Set<string>([
  'ImportDeclaration',
  'ExportAllDeclaration',
  'FunctionDeclaration',
  'ClassDeclaration',
  'TSTypeAliasDeclaration',
  'TSInterfaceDeclaration',
  'TSModuleDeclaration',
  'TSEnumDeclaration',
  'TSDeclareFunction',
  'EmptyStatement',
]);

export const COMPARISON_OPERATORS = new Set([
  '==',
  '!=',
  '===',
  '!==',
  '<',
  '<=',
  '>',
  '>=',
  'in',
  'instanceof',
]);

/** Name of an export specifier (`export { a as "b" }`). */
export function exportName(node: t.Identifier | t.StringLiteral): string {
  return node.type === 'Identifier' ? node.name : node.value;
}

export function rangeOf(node: t.Node): SourceRange {
  return { start: node.start ?? 0, end: node.end ?? 0 };
}

export function unwrap(expr: t.Expression): t.Expression {
  let current: t.Expression = expr;
  for (;;) {
    switch (current.type) {
      case 'TSAsExpression':
      case 'TSSatisfiesExpression':
      case 'TSNonNullExpression':
      case 'TSTypeAssertion':
      case 'TSInstantiationExpression':
      case 'ParenthesizedExpression': {
        current = current.expression;
        break;
      }

      default: {
        return current;
      }
    }
  }
}

export function patternName(pattern: t.Node, text: string): string {
  if (pattern.type === 'Identifier') {
    return pattern.name;
  }

  if (pattern.type === 'AssignmentPattern') {
    return patternName(pattern.left, text);
  }

  if (pattern.type === 'RestElement') {
    return `...${patternName(pattern.argument, text)}`;
  }

  if (pattern.type === 'TSParameterProperty') {
    return patternName(pattern.parameter, text);
  }

  const r = rangeOf(pattern);
  return truncate(text.slice(r.start, r.end), 24);
}

/** Returns `['a', 'b', 'c']` for chains like `a.b.c` without computed keys. */
export function simpleChain(expr: t.Node): string[] | undefined {
  const e = expr.type === 'Super' ? expr : unwrap(expr as t.Expression);
  if (e.type === 'Identifier') {
    return [e.name];
  }

  if (e.type === 'ThisExpression') {
    return ['this'];
  }

  if (e.type === 'Super') {
    return ['super'];
  }

  if (
    (e.type === 'MemberExpression' || e.type === 'OptionalMemberExpression') &&
    !e.computed &&
    e.property.type === 'Identifier'
  ) {
    const head = simpleChain(e.object);
    return head ? [...head, e.property.name] : undefined;
  }

  return undefined;
}

/** What a function builder needs from the document being lowered. */
export interface DocumentContext {
  readonly text: string;
  readonly fileName: string;
  readonly functions: FunctionGraph[];
  readonly queue: PendingFunction[];
  readonly functionParams: Map<string, string[]>;
  readonly functionReturnTypes: Map<string, DataType>;
  uniqueFunctionId(name: string): string;
}

/** Variables bound by a declaration target, e.g. `{ a, b: [c] = [] }`. */
export function bindingNames(pattern: t.Node | null | undefined): string[] {
  switch (pattern?.type) {
    case 'Identifier': {
      return [pattern.name];
    }

    case 'ObjectPattern': {
      return pattern.properties.flatMap((p) =>
        bindingNames(p.type === 'RestElement' ? p.argument : p.value)
      );
    }

    case 'ArrayPattern': {
      return pattern.elements.flatMap((e) => bindingNames(e));
    }

    case 'AssignmentPattern': {
      return bindingNames(pattern.left);
    }

    case 'RestElement': {
      return bindingNames(pattern.argument);
    }

    default: {
      return [];
    }
  }
}
