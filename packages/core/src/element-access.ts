import type { DataType, GraphNode } from './ir';
import {
  arrayElementType,
  isArrayType,
  isMapType,
  mapKeyType,
  mapValueType,
} from './types';

/** Title of UE's compact GET node: one element of an array or string. */
export const ELEMENT_GET = 'GET';

/** Title of UE's compact FIND node: the value of a key in a map. */
export const ELEMENT_FIND = 'FIND';

/**
 * How a backend lowers reading one element (`items[0]`, `name[0]`,
 * `prices["tea"]`).
 */
export interface ElementAccess {
  /** `GET`, or `FIND` for maps. */
  title: string;
  /** Type of the container pin: the array, string or map when known. */
  targetType: DataType;
  /** Type of the index or key pin. */
  keyType: DataType;
  /** Type of the element or value. */
  outType: DataType;
}

/**
 * Reading one element of a container of type `target`, drawn like UE's
 * compact GET node (FIND for a map's value): the container, the index or
 * key, and the element as output.
 */
export function elementAccess(target: DataType): ElementAccess {
  if (isArrayType(target)) {
    return {
      title: ELEMENT_GET,
      targetType: target,
      keyType: 'number',
      outType: arrayElementType(target),
    };
  }

  if (isMapType(target)) {
    return {
      title: ELEMENT_FIND,
      targetType: target,
      keyType: mapKeyType(target),
      outType: mapValueType(target),
    };
  }

  if (target === 'string') {
    return {
      title: ELEMENT_GET,
      targetType: 'string',
      keyType: 'number',
      outType: 'string',
    };
  }

  // Unknown: a wildcard that takes the type of its wire.
  return {
    title: ELEMENT_GET,
    targetType: 'any',
    keyType: 'any',
    outType: 'any',
  };
}

/** Title of UE's Set Array Elem node (`items[3] = x`). */
export const SET_ARRAY_ELEM = 'Set Array Elem';

/** How a backend lowers writing one element (`items[3] = x`). */
export interface ElementWrite {
  /** A map's key (`d["k"] = v`, UE's map ADD), else an array's index. */
  map: boolean;
  targetType: DataType;
  /** Type of the index or key pin. */
  keyType: DataType;
  /** Type of the item (array) or value (map) pin. */
  itemType: DataType;
}

/**
 * Writing one element of a container of type `target`: UE's Set Array
 * Elem for an array, the map's ADD for a map. `undefined` for other
 * targets (an object's computed key): those stay a SET.
 */
export function elementWrite(target: DataType): ElementWrite | undefined {
  if (isArrayType(target)) {
    return {
      map: false,
      targetType: target,
      keyType: 'number',
      itemType: arrayElementType(target),
    };
  }

  return isMapType(target)
    ? {
        map: true,
        targetType: target,
        keyType: mapKeyType(target),
        itemType: mapValueType(target),
      }
    : undefined;
}

/**
 * UE's GET or FIND node (`items[0]`, `prices["tea"]`), drawn as a word
 * over the container's symbol.
 */
export function isElementGet(node: GraphNode): boolean {
  return (
    node.kind === 'getProperty' &&
    (node.title === ELEMENT_GET || node.title === ELEMENT_FIND)
  );
}
