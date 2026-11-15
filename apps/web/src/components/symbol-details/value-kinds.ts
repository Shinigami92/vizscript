import type { DataType, ValueKind } from '@vizscript/core';

/** The text of a simple string literal (`"a"`, `'b'`), else `undefined`. */
export function stringValue(literal: string): string | undefined {
  const match = literal.match(/^([&^]?)(["'])((?:\\.|(?!\2).)*)\2$/s);
  if (!match) {
    return undefined;
  }

  return (match[3] ?? '').replaceAll(/\\(.)/g, (_, char: string) =>
    char === 'n' ? '\n' : char === 't' ? '\t' : char
  );
}

const BOOLEANS: ReadonlySet<string> = new Set([
  'true',
  'false',
  'True',
  'False',
]);

/** `undefined`, `null`, `None`: shown as an empty field, typing replaces it. */
export const PLACEHOLDER_VALUES: ReadonlySet<string> = new Set([
  'undefined',
  'null',
  'None',
]);

/**
 * How a value is edited, like UE: the widget follows the type (a number
 * field, a checkbox, a text field), code stays code.
 */
export function valueKindOf(dataType: DataType, code: string): ValueKind {
  const current = code.trim();
  if (dataType === 'bool' && (current === '' || BOOLEANS.has(current))) {
    return 'bool';
  }

  if (
    dataType === 'number' &&
    (current === '' || /^[-+]?[\d_.]+(?:e[-+]?\d+)?$/i.test(current))
  ) {
    return 'number';
  }

  if (
    dataType === 'string' &&
    (current === '' || stringValue(current) !== undefined)
  ) {
    return 'string';
  }

  return 'expression';
}
