import type { LanguageBackend } from '@vizscript/core';
import { LANGUAGE_ID, parsePythonDocument } from './lower';
import { applyPythonOp, PYTHON_TYPES } from './ops';
import { pythonReferences } from './references';
import { PYTHON_LIBRARIES, pythonLibrary } from './stdlib';
import { PYTHON_VERSION_FILES, pythonVersion } from './version';

export type * from './ast';
export { pythonVersion } from './version';
export { parsePython } from './convert';
export { parsePythonDocument } from './lower';
export { dataTypeOf } from './lower-utils';
export { applyPythonOp, PYTHON_SYNTAX } from './ops';
export { pythonReferences } from './references';

export const pythonBackend: LanguageBackend = {
  id: LANGUAGE_ID,
  name: 'Python',
  extensions: ['.py', '.pyw'],
  parse: parsePythonDocument,
  applyOp: applyPythonOp,
  references: pythonReferences,
  typeSystem: PYTHON_TYPES,
  library: pythonLibrary,
  libraries: PYTHON_LIBRARIES,
  versionFiles: PYTHON_VERSION_FILES,
  version: pythonVersion,
};
export * from './stdlib';
