import { LanguageRegistry } from '@vizscript/core';
import { gdscriptBackend } from '@vizscript/lang-gdscript';
import { pythonBackend } from '@vizscript/lang-python';
import { rustBackend } from '@vizscript/lang-rust';
import { typescriptBackend } from '@vizscript/lang-typescript';

/**
 * All language backends shipped with the app. Only imported by the worker so
 * parsers never end up in the main bundle. Add new languages here and their
 * extensions in `languages.ts`.
 */
export const registry = new LanguageRegistry()
  .register(typescriptBackend)
  .register(gdscriptBackend)
  .register(pythonBackend)
  .register(rustBackend);
