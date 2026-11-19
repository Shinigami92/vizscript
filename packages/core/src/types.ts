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

/** The name a type parameter declares: `T` of `const T extends X = Y`. */
export function typeParamName(param: string): string {
  return /^(?:(?:const|in|out)\s+)*([\w$]+)/.exec(param)?.[1] ?? param;
}

/**
 * A type a generic declares, where it is used: its type parameters are
 * unknown there, like UE's wildcard pins, so they become `any` (`T` →
 * `any`, `T[]` → `array`, `Map<K, V>` → `Map<any, any>`) until a checker
 * knows the real types.
 */
export function withoutTypeParams(
  type: DataType,
  params: ReadonlyArray<string> | undefined
): DataType {
  if (!params || params.length === 0) {
    return type;
  }

  const names = params
    .map((p) => typeParamName(p).replaceAll('$', String.raw`\$`))
    .join('|');
  const replaced = type.replaceAll(
    new RegExp(String.raw`(?<![\w$.])(?:${names})(?![\w$])`, 'g'),
    'any'
  );
  // Containers of unknown elements have names of their own.
  if (replaced === 'any[]') {
    return 'array';
  }

  if (isMapType(replaced)) {
    return mapOf(mapKeyType(replaced), mapValueType(replaced));
  }

  return isSetType(replaced) ? setOf(setElementType(replaced)) : replaced;
}

/**
 * Whether `value` fills in the wildcards of `pin`: `Promise<any>` is
 * refined by `Promise<string>`.
 */
function fillsWildcards(pin: DataType, value: DataType): boolean {
  if (!/\bany\b/.test(pin)) {
    return false;
  }

  const pattern = pin
    .replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
    .replaceAll(/\bany\b/g, '.+');
  return new RegExp(`^${pattern}$`).test(value);
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

/** The type arguments of `Name<A, B>` (nested ones stay whole), else none. */
function typeArguments(type: DataType, name: string): string[] | undefined {
  if (!type.startsWith(`${name}<`) || !type.endsWith('>')) {
    return undefined;
  }

  const args: string[] = [];
  let depth = 0;
  let start = name.length + 1;
  for (let i = start; i < type.length - 1; i++) {
    const char = type[i];
    if (char === '<' || char === '[' || char === '(') {
      depth++;
    } else if (char === '>' || char === ']' || char === ')') {
      depth--;
    } else if (char === ',' && depth === 0) {
      args.push(type.slice(start, i).trim());
      start = i + 1;
    }
  }

  args.push(type.slice(start, -1).trim());
  return args;
}

/**
 * Maps are `map` (key and value types unknown) or `Map<K, V>`, e.g.
 * `Map<string, number>` for Python's `dict[str, int]`, Rust's
 * `HashMap<String, i32>` or GDScript's `Dictionary[String, int]`, like
 * Blueprint maps.
 */
export function isMapType(type: DataType): boolean {
  return type === 'map' || typeArguments(type, 'Map')?.length === 2;
}

/** Key type of a map type (`any` when unknown). */
export function mapKeyType(type: DataType): DataType {
  return typeArguments(type, 'Map')?.[0] || 'any';
}

/** Value type of a map type (`any` when unknown). */
export function mapValueType(type: DataType): DataType {
  const args = typeArguments(type, 'Map');
  return (args?.length === 2 && args[1]) || 'any';
}

/** The map type of a key and a value type (`map` when both are unknown). */
export function mapOf(key: DataType, value: DataType): DataType {
  const k = key || 'any';
  const v = value || 'any';
  return k === 'any' && v === 'any' ? 'map' : `Map<${k}, ${v}>`;
}

/**
 * Sets are `set` (element type unknown) or `Set<T>`, e.g. `Set<string>`
 * for Python's `set[str]` or Rust's `HashSet<String>`, like Blueprint sets.
 */
export function isSetType(type: DataType): boolean {
  return type === 'set' || typeArguments(type, 'Set')?.length === 1;
}

/** Element type of a set type (`any` when unknown). */
export function setElementType(type: DataType): DataType {
  return typeArguments(type, 'Set')?.[0] || 'any';
}

/** The set type of an element type (`set` for `any`). */
export function setOf(element: DataType): DataType {
  return element === 'any' || element === '' ? 'set' : `Set<${element}>`;
}

/**
 * Type of what a loop over a value of `type` gets: the elements of arrays
 * and sets; the keys of maps (Python, GDScript) or, with `pairs`, their
 * entries (TypeScript's `for…of`, Rust).
 */
export function iteratedType(
  type: DataType,
  maps: 'keys' | 'pairs' = 'keys'
): DataType {
  if (isMapType(type)) {
    return maps === 'keys' ? mapKeyType(type) : 'array';
  }

  return isSetType(type) ? setElementType(type) : arrayElementType(type);
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

  return (
    pin === 'any' ||
    (pin === 'array' && isArrayType(value)) ||
    (pin === 'map' && isMapType(value)) ||
    (pin === 'set' && isSetType(value)) ||
    fillsWildcards(pin, value)
  );
}

/**
 * Arrays and sets take the color of their elements and maps of their keys,
 * like Blueprint container pins. Untyped maps and sets are objects.
 */
export function pinColor(type: DataType, scheme: ColorScheme = 'dark'): string {
  if (type !== 'array' && isArrayType(type)) {
    return pinColor(arrayElementType(type), scheme);
  }

  if (type === 'map' || type === 'set') {
    return pinColor('object', scheme);
  }

  if (isMapType(type)) {
    return pinColor(mapKeyType(type), scheme);
  }

  if (isSetType(type)) {
    return pinColor(setElementType(type), scheme);
  }

  const colors = scheme === 'light' ? LIGHT_PRIMITIVE_COLORS : PRIMITIVE_COLORS;
  return colors[type] ?? NAMED_TYPE_COLOR;
}

export const CATEGORY_COLORS: Record<NodeCategory, string> = {
  event: '#8c1c1c',
  entry: '#6c2d8c',
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

  // Maps and sets are objects too (`object` and named types take them),
  // but not each other; their parts must match.
  const fromMap = isMapType(from);
  const toMap = isMapType(to);
  if (fromMap && toMap) {
    return (
      isTypeCompatible(mapKeyType(from), mapKeyType(to)) &&
      isTypeCompatible(mapValueType(from), mapValueType(to))
    );
  }

  const fromSet = isSetType(from);
  const toSet = isSetType(to);
  if (fromSet && toSet) {
    return isTypeCompatible(setElementType(from), setElementType(to));
  }

  if ((fromMap || fromSet) && (toMap || toSet)) {
    return false;
  }

  return isObjectLike(from) && isObjectLike(to);
}
