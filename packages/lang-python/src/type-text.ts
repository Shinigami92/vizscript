import type { Expr } from './ast';

/**
 * Types as text for the type lookup: reading them (`List[int]` →
 * `list[int]`), and what iterating, indexing or combining values gives.
 */

export const NUMBERS = new Set(['int', 'float', 'bool']);
export const BOOLEAN_OPS = new Set([
  '==',
  '!=',
  '<',
  '>',
  '<=',
  '>=',
  'in',
  'not in',
  'is',
  'is not',
]);
export const ARITHMETIC_OPS = new Set(['+', '-', '*', '/', '//', '%', '**']);
export const BITWISE_OPS = new Set(['&', '|', '^', '<<', '>>']);
/** Spellings of the typing module for the built-in generics. */
export const ALIASES: Record<string, string> = {
  List: 'list',
  Dict: 'dict',
  Set: 'set',
  FrozenSet: 'set',
  frozenset: 'set',
  Tuple: 'tuple',
  Sequence: 'list',
  MutableSequence: 'list',
  Iterable: 'list',
  Iterator: 'list',
  Generator: 'list',
  Collection: 'list',
  Mapping: 'dict',
  MutableMapping: 'dict',
  DefaultDict: 'dict',
  defaultdict: 'dict',
  OrderedDict: 'dict',
  Text: 'str',
  LiteralString: 'str',
};
/** Built-in calls whose result follows their arguments. */
export const GENERIC_CALLS = new Set([
  'abs',
  'round',
  'sum',
  'min',
  'max',
  'sorted',
  'reversed',
  'list',
  'set',
  'tuple',
  'dict',
  'enumerate',
  'zip',
  'iter',
  'next',
  'str',
  'int',
  'float',
  'bool',
  'bytes',
  'type',
]);

/** Splits `a, b[c, d], e` at its top-level commas. */
export function splitTop(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '[' || c === '(') {
      depth++;
    } else if (c === ']' || c === ')') {
      depth--;
    } else if (c === ',' && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }

  const last = text.slice(start).trim();
  if (last) {
    parts.push(last);
  }

  return parts;
}

export interface Generic {
  name: string;
  args: string[];
}

export function generic(type: string): Generic {
  const match = type.match(/^([\w.]+)\[(.*)\]$/);
  return match?.[1] && match[2] !== undefined
    ? { name: match[1], args: splitTop(match[2]) }
    : { name: type, args: [] };
}

/**
 * A type as the lookup works with it: built-in generics spelled as such
 * (`List[int]` → `list[int]`), `Optional` and `| None` dropped, quotes of
 * forward references removed.
 */
export function normalize(text: string | undefined): string | undefined {
  if (text === undefined) {
    return undefined;
  }

  let type = text.trim().replaceAll(/^["']|["']$/g, '');
  type = type.replace(/^typing\./, '').replace(/^collections\.abc\./, '');
  const optional = type.match(/^Optional\[(.+)\]$/);
  if (optional?.[1]) {
    return normalize(optional[1]);
  }

  const union = splitUnion(type);
  if (union.length > 1) {
    const rest = union.filter((t) => t !== 'None');
    return rest.length === 1 ? normalize(rest[0]) : undefined;
  }

  const { name, args } = generic(type);
  const base = ALIASES[name] ?? name;
  if (base === 'Any' || base === 'object') {
    return undefined;
  }

  if (args.length === 0) {
    return base;
  }

  const inner = args.map((a) => (a === '...' ? a : (normalize(a) ?? 'Any')));
  return `${base}[${inner.join(', ')}]`;
}

/** `A | B` at the top level. */
export function splitUnion(type: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < type.length; i++) {
    const c = type[i];
    if (c === '[') {
      depth++;
    } else if (c === ']') {
      depth--;
    } else if (c === '|' && depth === 0) {
      parts.push(type.slice(start, i).trim());
      start = i + 1;
    }
  }

  parts.push(type.slice(start).trim());
  return parts;
}

/** What iterating a value gives (`list[Item]` → `Item`, `str` → `str`). */
export function itemOf(type: string | undefined): string | undefined {
  if (type === undefined) {
    return undefined;
  }

  const { name, args } = generic(type);
  if (name === 'str') {
    return 'str';
  }

  if (name === 'bytes') {
    return 'int';
  }

  if (name === 'tuple') {
    if (args[1] === '...') {
      return args[0];
    }

    return args.length > 0 && args.every((a) => a === args[0])
      ? args[0]
      : undefined;
  }

  return name === 'list' || name === 'set' || name === 'dict'
    ? known(args[0])
    : undefined;
}

/** `Any` as an argument of a generic means unknown. */
export function known(type: string | undefined): string | undefined {
  return type === 'Any' ? undefined : type;
}

/** `xs[i]`: an item of a list, the value of a dict, a part of a tuple. */
export function subscriptOf(
  type: string | undefined,
  index: Expr
): string | undefined {
  if (type === undefined) {
    return undefined;
  }

  const { name, args } = generic(type);
  if (index.type === 'Opaque') {
    // A slice: the same kind of sequence.
    return name === 'list' || name === 'str' || name === 'tuple'
      ? type
      : undefined;
  }

  if (name === 'dict') {
    return known(args[1]);
  }

  if (name === 'tuple' && index.type === 'Literal' && index.kind === 'int') {
    return args[1] === '...'
      ? known(args[0])
      : known(args[Number(index.value)]);
  }

  return itemOf(type);
}

export function arithmetic(
  op: string,
  left: string | undefined,
  right: string | undefined
): string | undefined {
  if (left === undefined || right === undefined) {
    return undefined;
  }

  if (NUMBERS.has(left) && NUMBERS.has(right)) {
    if (op === '/') {
      return 'float';
    }

    return left === 'float' || right === 'float' ? 'float' : 'int';
  }

  if (left === 'str' && (op === '%' || (op === '+' && right === 'str'))) {
    return 'str';
  }

  if (
    op === '*' &&
    ((left === 'str' && right === 'int') || (left === 'int' && right === 'str'))
  ) {
    return 'str';
  }

  const kind = generic(left).name;
  if ((op === '+' && left === right) || (op === '*' && right === 'int')) {
    return kind === 'list' || kind === 'tuple' ? left : undefined;
  }

  return undefined;
}

export function binaryType(
  rawOp: string,
  left: string | undefined,
  right: string | undefined
): string | undefined {
  const op = rawOp.replaceAll(/\s+/g, ' ');
  if (BOOLEAN_OPS.has(op)) {
    return 'bool';
  }

  if (op === 'and' || op === 'or') {
    return left === right ? left : undefined;
  }

  if (ARITHMETIC_OPS.has(op)) {
    return arithmetic(op, left, right);
  }

  if (BITWISE_OPS.has(op)) {
    if (left === 'int' && right === 'int') {
      return 'int';
    }

    return left === right ? left : undefined;
  }

  return undefined;
}

/** The common type of values (`[1, 2]`), `undefined` when they differ. */
export function common(
  types: ReadonlyArray<string | undefined>
): string | undefined {
  const [first] = types;
  if (first === undefined || types.some((t) => t !== first)) {
    return types.length > 0 && types.every((t) => t && NUMBERS.has(t))
      ? 'float'
      : undefined;
  }

  return first;
}
