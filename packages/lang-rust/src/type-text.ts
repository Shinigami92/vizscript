import type { Expr } from './ast';

/**
 * Types as text for the type lookup: reading them (`&'a Vec<Item>` →
 * `Vec<Item>`), what iterating or combining values gives, and literals.
 */

/** An integer or float literal without a suffix, like rustc's `{integer}`. */
export const INTEGER = '{integer}';
export const FLOAT = '{float}';

export const INTEGERS = new Set([
  'i8',
  'i16',
  'i32',
  'i64',
  'i128',
  'isize',
  'u8',
  'u16',
  'u32',
  'u64',
  'u128',
  'usize',
]);
export const FLOATS = new Set(['f32', 'f64']);
export const COMPARISONS = new Set([
  '==',
  '!=',
  '<',
  '>',
  '<=',
  '>=',
  '&&',
  '||',
]);
/** Smart pointers: their value is what they point to. */
export const POINTERS = new Set(['Box', 'Rc', 'Arc', 'RefCell', 'Cell', 'Cow']);
/** Collections that share the methods of a stub (`BTreeMap` → `HashMap`). */
export const STUB_OF: Record<string, string> = {
  String: 'String',
  str: 'str',
  Vec: 'Vec',
  VecDeque: 'Vec',
  Option: 'Option',
  Result: 'Result',
  HashMap: 'HashMap',
  BTreeMap: 'HashMap',
  HashSet: 'HashSet',
  BTreeSet: 'HashSet',
  Iter: 'Iter',
  Range: 'Iter',
  bool: 'bool',
  char: 'char',
};
/** Macros that print or check: they give nothing. */
export const UNIT_MACROS = new Set([
  'print',
  'println',
  'eprint',
  'eprintln',
  'assert',
  'assert_eq',
  'assert_ne',
  'debug_assert',
]);

/** Splits `A, B<C, D>` at its top-level commas. */
export function splitTop(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '<' || c === '(' || c === '[') {
      depth++;
    } else if (c === '>' || c === ')' || c === ']') {
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
  const match = type.match(/^([\w:]+)<(.*)>$/);
  return match?.[1] && match[2] !== undefined
    ? { name: match[1], args: splitTop(match[2]) }
    : { name: type, args: [] };
}

/**
 * A type as the lookup works with it: references, lifetimes and smart
 * pointers dropped (`&'a mut Box<Item>` → `Item`), paths shortened
 * (`std::collections::HashMap<K, V>` → `HashMap<K, V>`), arrays as slices,
 * `Self` resolved. `undefined` for `_` and what it can't read.
 */
export function normalize(
  text: string | undefined,
  self?: string
): string | undefined {
  if (text === undefined) {
    return undefined;
  }

  let type = text.replaceAll(/\s+/g, ' ').trim();
  for (;;) {
    const stripped = type
      .replace(/^&\s*(?:'\w+\s*)?(?:mut\s+)?/, '')
      .replace(/^\*\s*(?:const|mut)\s+/, '')
      .replace(/^dyn\s+/, '');
    if (stripped === type) {
      break;
    }

    type = stripped;
  }

  if (type === '_' || type === '') {
    return undefined;
  }

  if (type === 'Self') {
    return self;
  }

  const iterator = type.match(/^impl\s+Iterator\s*<\s*Item\s*=\s*(.+)>$/);
  if (iterator) {
    const item = normalize(iterator[1], self);
    return item ? `Iter<${item}>` : undefined;
  }

  if (type.startsWith('impl ')) {
    return undefined;
  }

  if (type.startsWith('(')) {
    const inner = type.slice(1, -1);
    const parts = splitTop(inner).map((p) => normalize(p, self));
    if (parts.length === 0) {
      return '()';
    }

    return parts.every((p) => p !== undefined)
      ? `(${parts.join(', ')})`
      : undefined;
  }

  const array = type.match(/^\[(.+?)(?:;.+)?\]$/);
  if (array) {
    const item = normalize(array[1], self);
    return item ? `[${item}]` : undefined;
  }

  const { name, args } = generic(type.replaceAll(' ', ''));
  const short = name.split('::').at(-1) ?? name;
  if (POINTERS.has(short) && args[0] !== undefined) {
    return normalize(args[0], self);
  }

  if (short === 'Self') {
    return self;
  }

  if (args.length === 0) {
    return short;
  }

  const inner = args.map((a) => normalize(a, self) ?? '_');
  return `${short}<${inner.join(', ')}>`;
}

/** What iterating a value gives (`Vec<Item>` → `Item`). */
export function itemOf(type: string | undefined): string | undefined {
  if (type === undefined) {
    return undefined;
  }

  const slice = type.match(/^\[(.+)\]$/);
  if (slice) {
    return slice[1];
  }

  const { name, args } = generic(type);
  if (name === 'HashMap' || name === 'BTreeMap') {
    return args[0] && args[1] ? `(${args[0]}, ${args[1]})` : undefined;
  }

  const item = args[0];
  return item === '_' ? undefined : item;
}

export function isInteger(type: string | undefined): boolean {
  return type === INTEGER || (type !== undefined && INTEGERS.has(type));
}

export function isFloat(type: string | undefined): boolean {
  return type === FLOAT || (type !== undefined && FLOATS.has(type));
}

/** The type two numbers of an operation share (`{integer}` adapts). */
export function unify(
  left: string | undefined,
  right: string | undefined
): string | undefined {
  if (left === right) {
    return left;
  }

  if (left === INTEGER && isInteger(right)) {
    return right;
  }

  if (right === INTEGER && isInteger(left)) {
    return left;
  }

  if (left === FLOAT && isFloat(right)) {
    return right;
  }

  return right === FLOAT && isFloat(left) ? left : undefined;
}

export function binaryType(
  op: string,
  left: string | undefined,
  right: string | undefined
): string | undefined {
  if (COMPARISONS.has(op)) {
    return 'bool';
  }

  if (op === '+' && left === 'String') {
    return 'String';
  }

  if (op === '<<' || op === '>>') {
    return left;
  }

  return unify(left, right);
}

/** The pattern text of a binding pattern without `&`, `ref` and `mut`. */
export function bare(pattern: string): string {
  return pattern
    .trim()
    .replace(/^&\s*(?:mut\s+)?/, '')
    .replace(/^ref\s+/, '')
    .replace(/^mut\s+/, '')
    .trim();
}

/**
 * Types of the names a pattern binds, matched against the value's type
 * (`Some(item)` of an `Option<Item>`, `(i, x)` of a tuple).
 */
export function patternTypes(
  pattern: string,
  type: string | undefined,
  types: Map<string, string | undefined>
): void {
  const text = bare(pattern);
  if (/^[a-z_]\w*$/.test(text)) {
    types.set(text, type);
    return;
  }

  const variant = text.match(/^(?:Option::|Result::)?(Some|Ok|Err)\((.*)\)$/);
  if (variant?.[1] && variant[2] !== undefined) {
    const { name, args } = generic(type ?? '');
    const inner =
      (variant[1] === 'Some' && name === 'Option') ||
      (variant[1] === 'Ok' && name === 'Result')
        ? args[0]
        : variant[1] === 'Err' && name === 'Result'
          ? args[1]
          : undefined;
    patternTypes(variant[2], inner === '_' ? undefined : inner, types);
    return;
  }

  if (text.startsWith('(') && text.endsWith(')')) {
    const parts = splitTop(text.slice(1, -1));
    const tuple =
      type?.startsWith('(') === true ? splitTop(type.slice(1, -1)) : [];
    for (const [i, part] of parts.entries()) {
      patternTypes(part, tuple[i], types);
    }
  }
}

/** The type of a literal (`1u8` is a `u8`, `1` an `{integer}`). */
export function literalType(expr: Extract<Expr, { type: 'Literal' }>): string {
  switch (expr.kind) {
    case 'int':
    case 'float': {
      const suffix = expr.value.match(
        /(?:[iu](?:8|16|32|64|128|size)|f32|f64)$/
      );
      if (suffix) {
        return suffix[0];
      }

      return expr.kind === 'int' && !/[.eE]/.test(expr.value) ? INTEGER : FLOAT;
    }

    case 'string': {
      return 'str';
    }

    case 'bytes': {
      return '[u8]';
    }

    case 'unit': {
      return '()';
    }

    default: {
      return expr.kind;
    }
  }
}

export function macroType(
  name: string,
  args: ReadonlyArray<string | undefined>,
  repeat?: boolean
): string | undefined {
  if (name === 'format') {
    return 'String';
  }

  if (name === 'vec') {
    const item = concrete(repeat ? args[0] : common(args));
    return item ? `Vec<${item}>` : undefined;
  }

  if (name === 'write' || name === 'writeln') {
    return 'fmt::Result';
  }

  return UNIT_MACROS.has(name) ? '()' : undefined;
}

/** The type of values that must agree (`[1, 2]`), else `undefined`. */
export function common(
  types: ReadonlyArray<string | undefined>
): string | undefined {
  let result = types[0];
  for (const type of types.slice(1)) {
    result = unify(result, type);
  }

  return result;
}

export function same(
  types: ReadonlyArray<string | undefined>
): string | undefined {
  return types.length > 0 ? common(types) : undefined;
}

/** A literal's default type once nothing else decided it. */
export function concrete(type: string | undefined): string | undefined {
  if (type === INTEGER) {
    return 'i32';
  }

  return type === FLOAT ? 'f64' : type;
}
