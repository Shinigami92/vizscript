import type * as t from '@babel/types';
import type { DataType } from '@vizscript/core';
import { arrayOf } from '@vizscript/core';

/** Pin type of a TypeScript type annotation. */
export function typeFromAnnotation(
  annotation: t.Node | null | undefined
): DataType {
  if (!annotation) {
    return 'any';
  }

  const node =
    annotation.type === 'TSTypeAnnotation'
      ? annotation.typeAnnotation
      : annotation;
  switch (node.type) {
    case 'TSStringKeyword': {
      return 'string';
    }

    case 'TSNumberKeyword': {
      return 'number';
    }

    case 'TSBooleanKeyword': {
      return 'bool';
    }

    case 'TSBigIntKeyword': {
      return 'bigint';
    }

    case 'TSVoidKeyword':
    case 'TSUndefinedKeyword': {
      return 'void';
    }

    case 'TSNullKeyword': {
      return 'null';
    }

    case 'TSObjectKeyword':
    case 'TSTypeLiteral': {
      return 'object';
    }

    case 'TSArrayType': {
      return arrayOf(typeFromAnnotation(node.elementType));
    }

    case 'TSTupleType': {
      return 'array';
    }

    case 'TSFunctionType': {
      return 'function';
    }

    case 'TSLiteralType': {
      const literal = node.literal;
      if (
        literal.type === 'StringLiteral' ||
        literal.type === 'TemplateLiteral'
      ) {
        return 'string';
      }

      if (literal.type === 'BooleanLiteral') {
        return 'bool';
      }

      if (literal.type === 'BigIntLiteral') {
        return 'bigint';
      }

      return 'number';
    }

    case 'TSTypeReference': {
      const name =
        node.typeName.type === 'Identifier' ? node.typeName.name : undefined;
      if (name === 'Array' || name === 'ReadonlyArray') {
        return arrayOf(typeFromAnnotation(node.typeArguments?.params[0]));
      }

      return name ?? 'object';
    }

    case 'TSUnionType': {
      const types = new Set(node.types.map((ty) => typeFromAnnotation(ty)));
      types.delete('null');
      types.delete('void');
      return types.size === 1 ? ([...types][0] ?? 'any') : 'any';
    }

    default: {
      return 'any';
    }
  }
}

/** The type annotation of a parameter or binding pattern. */
export function patternAnnotation(pattern: t.Node): t.Node | null | undefined {
  if (pattern.type === 'AssignmentPattern') {
    return patternAnnotation(pattern.left);
  }

  if (pattern.type === 'TSParameterProperty') {
    return patternAnnotation(pattern.parameter);
  }

  if ('typeAnnotation' in pattern && pattern.typeAnnotation) {
    return pattern.typeAnnotation;
  }

  return undefined;
}
