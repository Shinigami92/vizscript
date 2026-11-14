import type { LanguageBackend } from '@vizscript/core';
import { LANGUAGE_ID, parseTypeScript } from './lower';
import { applyTypeScriptOp, TYPESCRIPT_TYPES } from './ops';
import { typeScriptReferences } from './references';
import { TS_VERSION_FILES, typescriptVersion } from './version';

export { typescriptVersion } from './version';

export { applyTypeScriptOp } from './ops';
export { parseTypeScript } from './lower';
export { moduleCandidates, typeScriptReferences } from './references';

export const typescriptBackend: LanguageBackend = {
  id: LANGUAGE_ID,
  name: 'TypeScript / JavaScript',
  extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
  parse: parseTypeScript,
  applyOp: applyTypeScriptOp,
  references: typeScriptReferences,
  typeSystem: TYPESCRIPT_TYPES,
  versionFiles: TS_VERSION_FILES,
  version: typescriptVersion,
};
