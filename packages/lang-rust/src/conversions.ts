import type { Conversion } from '@vizscript/core';

/** UE's autocasts in Rust: `Display` values become strings. */
export const CONVERSIONS: ReadonlyArray<Conversion> = [
  { from: 'number', to: 'string', template: '$value.to_string()' },
  { from: 'bool', to: 'string', template: '$value.to_string()' },
];
