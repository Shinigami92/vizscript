import type { LanguageBackend } from '@vizscript/core';
import { LANGUAGE_ID, parseRustDocument } from './lower';
import { applyRustOp, RUST_TYPES } from './ops';
import { rustReferences } from './references';

export type * from './ast';
export { parseRust } from './convert';
export { dataTypeOf } from './data-type';
export { modulePathOf, rustUses } from './imports';
export { parseRustDocument } from './lower';
export { applyRustOp, RUST_SYNTAX, RUST_TYPES } from './ops';
export { rustReferences } from './references';

export const rustBackend: LanguageBackend = {
  id: LANGUAGE_ID,
  name: 'Rust',
  extensions: ['.rs'],
  parse: parseRustDocument,
  applyOp: applyRustOp,
  references: rustReferences,
  typeSystem: RUST_TYPES,
};
