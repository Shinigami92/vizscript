import type { LanguageBackend } from '@vizscript/core';
import { LANGUAGE_ID, parsePythonDocument } from './lower';
import { applyPythonOp, PYTHON_TYPES } from './ops';
import { pythonReferences } from './references';
import { PYTHON_LIBRARIES, pythonLibrary } from './stdlib';

export type * from './ast';
export { parsePython } from './convert';
export { dataTypeOf, parsePythonDocument } from './lower';
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
};
export * from './stdlib';
