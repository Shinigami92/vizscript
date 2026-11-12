import type { DataType } from '@vizscript/core';
import { arrayOf } from '@vizscript/core';

const NUMBER = /^(?:[iu](?:8|16|32|64|128|size)|f32|f64)$/;

/** Splits `A, B<C, D>` at top-level commas. */
function splitTypes(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '<' || char === '(' || char === '[') {
      depth++;
    } else if (char === '>' || char === ')' || char === ']') {
      depth--;
    } else if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  if (current.trim() !== '') {
    parts.push(current);
  }

  return parts;
}

/** Maps a type as written (`&mut Vec<Item>`) to a pin type. */
export function dataTypeOf(
  annotation: string | undefined,
  self?: string
): DataType {
  if (!annotation) {
    return 'any';
  }

  let type = annotation.replaceAll(/\s+/g, ' ').trim();
  // References, raw pointers and lifetimes don't change the value.
  for (;;) {
    const stripped = type
      .replace(/^&\s*(?:'\w+\s*)?(?:mut\s+)?/, '')
      .replace(/^\*\s*(?:const|mut)\s+/, '')
      .replace(/^(?:dyn|impl)\s+(?=(?:Fn|FnMut|FnOnce)\b)/, '');
    if (stripped === type) {
      break;
    }

    type = stripped;
  }

  type = type.replaceAll(' ', '');
  if (type === '()' || type === '!') {
    return 'void';
  }

  if (NUMBER.test(type)) {
    return 'number';
  }

  if (type === 'bool') {
    return 'bool';
  }

  if (/^(?:String|str|char|(?:std::borrow::)?Cow<(?:'\w+,)?str>)$/.test(type)) {
    return 'string';
  }

  if (type === 'Self') {
    return self ?? 'Self';
  }

  const generic = type.match(/^((?:\w+::)*\w+)<(.*)>$/);
  const name = generic?.[1]?.split('::').at(-1);
  const args = generic ? splitTypes(generic[2] ?? '') : [];
  if (name === 'Option' || name === 'Box' || name === 'Rc' || name === 'Arc') {
    return dataTypeOf(args[0], self);
  }

  if (
    name &&
    /^(?:Vec|VecDeque|HashSet|BTreeSet|LinkedList|BinaryHeap)$/.test(name)
  ) {
    return arrayOf(dataTypeOf(args[0], self));
  }

  if (name && /^(?:HashMap|BTreeMap|IndexMap)$/.test(name)) {
    return 'object';
  }

  const slice = type.match(/^\[(.+?)(?:;.+)?\]$/);
  if (slice) {
    return arrayOf(dataTypeOf(slice[1], self));
  }

  if (/^(?:Fn|FnMut|FnOnce)\(|^fn\(/.test(type)) {
    return 'function';
  }

  if (type.startsWith('(')) {
    return 'array';
  }

  const bare = (type.split('<')[0] ?? type).split('::').at(-1) ?? type;
  return bare === 'Self' ? (self ?? 'Self') : bare;
}
