import type { LanguageBackend } from '@vizscript/core';
import { LANGUAGE_ID, parseGDScriptDocument } from './lower';
import { applyGDScriptOp, GDSCRIPT_TYPES } from './ops';
import { gdscriptReferences } from './references';
import { GDSCRIPT_VERSION_FILES, gdscriptVersion } from './version';

export type * from './ast';
export { gdscriptVersion } from './version';
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
  versionFiles: GDSCRIPT_VERSION_FILES,
  version: gdscriptVersion,
};
