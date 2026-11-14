import type { Conversion } from '@vizscript/core';

/** UE's autocasts: the built-in conversion functions. */
export const CONVERSIONS: ReadonlyArray<Conversion> = [
  { from: 'number', to: 'string', template: 'str($value)' },
  { from: 'bool', to: 'string', template: 'str($value)' },
  { from: 'string', to: 'number', template: 'float($value)' },
  { from: 'bool', to: 'number', template: 'int($value)' },
  { from: 'number', to: 'bool', template: 'bool($value)' },
  { from: 'string', to: 'bool', template: 'bool($value)' },
];
