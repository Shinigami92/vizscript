import type { SyntaxNode } from '@lezer/common';

/** Helpers for the nodes of Lezer's Rust syntax tree. */

export const COMMENTS = new Set(['LineComment', 'BlockComment']);

/** Tokens and helper nodes that are never expressions. */
const NOT_EXPRESSIONS = new Set([
  'ArgList',
  'ParamList',
  'TypeArgList',
  'TypeParamList',
  'Block',
  'MatchBlock',
  'FieldInitializerList',
  'LoopLabel',
  'ArithOp',
  'LogicOp',
  'BitOp',
  'CompareOp',
  'UpdateOp',
  'DerefOp',
  'Vis',
  'Attribute',
  'Guard',
]);

export const TYPE_NODES = new Set([
  'TypeIdentifier',
  'ScopedTypeIdentifier',
  'GenericType',
  'ReferenceType',
  'PointerType',
  'TupleType',
  'UnitType',
  'ArrayType',
  'FunctionType',
  'AbstractType',
  'DynamicType',
  'BoundedType',
  'SelfType',
  'MetaType',
  'InferredType',
  'EmptyType',
  'QualifiedScope',
]);

export function children(node: SyntaxNode): SyntaxNode[] {
  const result: SyntaxNode[] = [];
  for (let kid = node.firstChild; kid; kid = kid.nextSibling) {
    if (!COMMENTS.has(kid.name)) {
      result.push(kid);
    }
  }

  return result;
}

export function child(node: SyntaxNode, name: string): SyntaxNode | undefined {
  return children(node).find((c) => c.name === name);
}

export function isExpression(node: SyntaxNode): boolean {
  if (node.name === 'self' || node.name === 'super' || node.name === 'crate') {
    return true;
  }

  return (
    /^[A-Z]/.test(node.name) &&
    !NOT_EXPRESSIONS.has(node.name) &&
    !TYPE_NODES.has(node.name)
  );
}
