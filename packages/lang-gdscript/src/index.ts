import type { LanguageBackend } from '@vizscript/core';
import { LANGUAGE_ID, parseGDScriptDocument } from './lower';
import { applyGDScriptOp, GDSCRIPT_TYPES } from './ops';
import { gdscriptReferences } from './references';

export type * from './ast';
export { dataTypeOf } from './data-type';
export { parseGDScriptDocument } from './lower';
export { applyGDScriptOp, GDSCRIPT_SYNTAX } from './ops';
export { parseGDScript } from './parser';
export { gdscriptReferences } from './references';

export const gdscriptBackend: LanguageBackend = {
  id: LANGUAGE_ID,
  name: 'GDScript',
  extensions: ['.gd'],
  parse: parseGDScriptDocument,
  applyOp: applyGDScriptOp,
  references: gdscriptReferences,
  typeSystem: GDSCRIPT_TYPES,
};
