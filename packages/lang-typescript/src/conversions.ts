import type { Conversion } from '@vizscript/core';

/** UE's autocasts in TypeScript: the global conversion functions. */
export const CONVERSIONS: ReadonlyArray<Conversion> = [
  { from: 'number', to: 'string', template: 'String($value)' },
  { from: 'bool', to: 'string', template: 'String($value)' },
  { from: 'bigint', to: 'string', template: 'String($value)' },
  { from: 'string', to: 'number', template: 'Number($value)' },
  { from: 'bool', to: 'number', template: 'Number($value)' },
  { from: 'bigint', to: 'number', template: 'Number($value)' },
  { from: 'number', to: 'bigint', template: 'BigInt($value)' },
  { from: 'string', to: 'bigint', template: 'BigInt($value)' },
  { from: 'number', to: 'bool', template: 'Boolean($value)' },
  { from: 'string', to: 'bool', template: 'Boolean($value)' },
];
