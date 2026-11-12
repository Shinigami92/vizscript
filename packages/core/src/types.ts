import type { DataType, NodeCategory } from './ir';

/**
 * Pin colors loosely follow Unreal Engine's Blueprint defaults.
 */
const PRIMITIVE_COLORS: Record<string, string> = {
  any: '#8c8c8c',
  bool: '#950000',
  number: '#9cf05a',
  bigint: '#1fe3af',
  string: '#fd00d0',
  object: '#0aa6f5',
  array: '#f5a60a',
  function: '#b48cff',
  null: '#5a5a5a',
  void: '#5a5a5a',
  regexp: '#ff7b54',
};

/** Darker variants that stay readable on a light canvas. */
const LIGHT_PRIMITIVE_COLORS: Record<string, string> = {
  ...PRIMITIVE_COLORS,
  any: '#71717a',
  number: '#3f8f12',
  bigint: '#0d9373',
  string: '#c400a3',
  object: '#0279b8',
  array: '#c47f00',
  function: '#7c4dff',
  regexp: '#e0552b',
};

const NAMED_TYPE_COLOR = '#2a5aff';

/** Light or dark appearance of the graph and the app. */
export type ColorScheme = 'dark' | 'light';

/** Color of exec pins and wires (white like Blueprint, dark when light). */
export function execColor(scheme: ColorScheme = 'dark'): string {
  return scheme === 'light' ? '#3f3f46' : '#ffffff';
}

/**
 * Arrays are `array` (element type unknown) or `<element>[]`, e.g.
 * `string[]` or `Vector3[]`, like Blueprint arrays of a pin type.
 */
export function isArrayType(type: DataType): boolean {
  return type === 'array' || type.endsWith('[]');
}

/** Element type of an array type (`any` when unknown). */
export function arrayElementType(type: DataType): DataType {
  return type.endsWith('[]') ? type.slice(0, -2) || 'any' : 'any';
}

/** The array type of an element type (`array` for `any`). */
export function arrayOf(element: DataType): DataType {
  return element === 'any' || element === '' ? 'array' : `${element}[]`;
}

/** Array type of a list of element types (typed only if they all agree). */
export function arrayOfAll(elements: ReadonlyArray<DataType>): DataType {
  const first = elements[0];
  return first !== undefined && elements.every((e) => e === first)
    ? arrayOf(first)
    : 'array';
}

/**
 * Whether a value of type `value` refines the declared pin type `pin`.
 * Empty values (`undefined`, `null`, `None`) don't: such an input is unset
 * and takes any wire.
 */
export function refinesType(pin: DataType, value: DataType): boolean {
  if (
    value === 'any' ||
    value === pin ||
    value === 'void' ||
    value === 'null'
  ) {
    return false;
  }

  return pin === 'any' || (pin === 'array' && isArrayType(value));
}

/** Arrays take the color of their elements, like Blueprint array pins. */
export function pinColor(type: DataType, scheme: ColorScheme = 'dark'): string {
  if (type !== 'array' && isArrayType(type)) {
    return pinColor(arrayElementType(type), scheme);
  }

  const colors = scheme === 'light' ? LIGHT_PRIMITIVE_COLORS : PRIMITIVE_COLORS;
  return colors[type] ?? NAMED_TYPE_COLOR;
}

export const CATEGORY_COLORS: Record<NodeCategory, string> = {
  event: '#8c1c1c',
  function: '#1d5a96',
  pure: '#4c7a2c',
  flow: '#5a5a5a',
  variable: '#2d2d2d',
  return: '#6c2d8c',
  latent: '#2d6c78',
  unknown: '#6b5a2d',
};

/** Named types are treated as objects. */
function isObjectLike(type: DataType): boolean {
  return (
    type === 'object' || (!(type in PRIMITIVE_COLORS) && !isArrayType(type))
  );
}

/**
 * Whether a value of type `from` may be wired into an input of type `to`.
 * Deliberately permissive: JavaScript is dynamically typed.
 */
export function isTypeCompatible(from: DataType, to: DataType): boolean {
  if (from === 'any' || to === 'any' || from === to) {
    return true;
  }

  if (from === 'void') {
    return false;
  }

  if (isArrayType(from) || isArrayType(to)) {
    if (!isArrayType(from) || !isArrayType(to)) {
      return false;
    }

    return isTypeCompatible(arrayElementType(from), arrayElementType(to));
  }

  return isObjectLike(from) && isObjectLike(to);
}
