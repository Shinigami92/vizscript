import type {
  DeclarationSyntax,
  GraphDocument,
  ImportRequest,
  OpResult,
} from '@vizscript/core';
import { insertImport, joinImport, relativePath } from '@vizscript/core';

const SOURCE_EXTENSION = /\.(?:d\.)?[cm]?[jt]sx?$/;

/**
 * The module specifier of `path` as this file writes its relative imports:
 * without extension (`./util`), or with `.js` (TypeScript's ESM style).
 */
function moduleOf(doc: GraphDocument, request: ImportRequest): string {
  if (request.module) {
    return request.module;
  }

  const relative = relativePath(request.from, request.path);
  const base = relative.replace(SOURCE_EXTENSION, '');
  const jsStyle = (doc.symbols ?? []).some(
    (s) =>
      s.kind === 'import' &&
      s.module?.startsWith('.') &&
      /\.[cm]?js$/.test(s.module)
  );
  if (jsStyle) {
    return `${base}.js`;
  }

  // `./util/index` is imported as `./util`.
  return base.endsWith('/index') && base !== './index'
    ? base.slice(0, -'/index'.length)
    : base;
}

/**
 * `import { name } from './x';` (or `import name from` for a default
 * export), joined into an existing import of the module when there is one,
 * in the quotes and semicolon style of the file's imports.
 */
export function addTypeScriptImport(
  text: string,
  doc: GraphDocument,
  request: ImportRequest,
  syntax: DeclarationSyntax
): OpResult {
  const module = moduleOf(doc, request);
  const { name, imported } = request;
  if (imported !== '*' && imported !== 'default') {
    const joined = joinImport(doc, module, name, imported);
    if (joined) {
      return { ok: true, edits: [joined] };
    }
  }

  const first = (doc.symbols ?? []).find((s) => s.kind === 'import');
  const statement = first?.declarationRange
    ? text.slice(first.declarationRange.start, first.declarationRange.end)
    : undefined;
  const quote = statement?.match(/from\s*(["'])/)?.[1] ?? "'";
  const semicolon =
    statement === undefined || statement.endsWith(';') ? ';' : '';
  let names: string;
  if (imported === 'default') {
    names = name;
  } else if (imported === '*') {
    names = `* as ${name}`;
  } else {
    names = `{ ${imported === name ? name : `${imported} as ${name}`} }`;
  }

  const line = `import ${names} from ${quote}${module}${quote}${semicolon}`;
  return { ok: true, edits: [insertImport(text, doc, syntax, line)] };
}
