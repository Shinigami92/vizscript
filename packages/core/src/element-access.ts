import type { DataType, GraphNode } from './ir';
import { arrayElementType, isArrayType } from './types';

/** Title of UE's compact GET node: one element of a container. */
export const ELEMENT_GET = 'GET';

/** How a backend lowers reading one element (`items[0]`, `name[0]`). */
export interface ElementAccess {
  /** Type of the container pin: the array or string when known. */
  targetType: DataType;
  /** Type of the index pin. */
  keyType: DataType;
  /** Type of the element. */
  outType: DataType;
}

/**
 * Reading one element of a container of type `target`, drawn like UE's
 * compact GET node: the container, the index, and the element as output.
 */
export function elementAccess(target: DataType): ElementAccess {
  if (isArrayType(target)) {
    return {
      targetType: target,
      keyType: 'number',
      outType: arrayElementType(target),
    };
  }

  if (target === 'string') {
    return { targetType: 'string', keyType: 'number', outType: 'string' };
  }

  // Unknown: a wildcard that takes the type of its wire.
  return { targetType: 'any', keyType: 'any', outType: 'any' };
}

/** UE's GET node (`items[0]`), drawn as a word over the container's symbol. */
export function isElementGet(node: GraphNode): boolean {
  return node.kind === 'getProperty' && node.title === ELEMENT_GET;
}
