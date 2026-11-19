import type {
  DataType,
  GraphDocument,
  ImportRequest,
  ScriptSymbol,
} from '@vizscript/core';
import { relativePath } from '@vizscript/core';
import { languageOf } from './languages';
import { nearest } from './project-files';
import { typeParamsText } from './symbols';

/** A name of another file the action menu offers; using it imports it. */
export interface ExternalName {
  /** Local name in this file. */
  name: string;
  /** File that declares it. */
  path: string;
  /** The file relative to the importing one (`./util.ts`), for hints. */
  where: string;
  /**
   * Called (`fn()`, `Script.new()`), read (`LIMIT`), or constructed
   * (`new Command()`, a TypeScript class).
   */
  kind: 'function' | 'value' | 'class';
  /** What a call node calls (`fn`, `Bullet.new`, `math.sqrt`). */
  callee: string;
  /** The value as an input (`LIMIT`, `Bullet`, `math.pi`). */
  expression: string;
  /** Type of the first parameter and of the result, when known. */
  first?: DataType;
  returns?: DataType;
  /** Signature for the action menu's tooltip (`clamp(v: number) → number`). */
  detail?: string;
  request: ImportRequest;
}

/**
 * A function's signature in one neutral form for tooltips:
 * `greet(name: string, times = 2) → string`. `text` is the file that
 * declares it, for default values given as ranges.
 */
export function signatureText(
  symbol: ScriptSymbol,
  text?: string
): string | undefined {
  if (!symbol.params) {
    return undefined;
  }

  const params = symbol.params.map((p) => {
    const value =
      p.defaultText ??
      (p.defaultRange && text
        ? text.slice(p.defaultRange.start, p.defaultRange.end)
        : undefined);
    return `${p.rest ? '…' : ''}${p.name}${p.type ? `: ${p.type.text}` : ''}${value === undefined ? '' : ` = ${value}`}`;
  });
  const returns = symbol.returns?.text;
  return `${symbol.name}${typeParamsText(symbol)}(${params.join(', ')})${returns ? ` → ${returns}` : ''}`;
}

/**
 * Types of a function's first parameter and result (action menu filter),
 * and its signature for the tooltip.
 */
export function signature(
  symbol: ScriptSymbol,
  text?: string
): {
  first?: DataType;
  returns?: DataType;
  detail?: string;
} {
  const first = symbol.params?.find((p) => !p.rest)?.dataType;
  const detail = signatureText(symbol, text);
  return {
    ...(first === undefined ? {} : { first }),
    ...(symbol.returnType === undefined ? {} : { returns: symbol.returnType }),
    ...(detail === undefined ? {} : { detail }),
  };
}

/** Exports without the members of exported types. */
export function topLevel(exports: ReadonlyArray<ScriptSymbol>): ScriptSymbol[] {
  return exports.filter((s) => s.scope === '');
}

/** Folders whose files are never imported by hand. */
const SKIPPED = /(?:^|\/)(?:node_modules|dist|build|vendor|\.[^/]+)\//;

function sharedPrefix(a: string, b: string): number {
  const left = a.split('/');
  const right = b.split('/');
  let count = 0;
  while (count < left.length - 1 && left[count] === right[count]) {
    count++;
  }

  return count;
}

/** Files that make a folder a package or project of its own. */
const MANIFESTS = [
  'package.json',
  'pyproject.toml',
  'setup.py',
  'Cargo.toml',
  'project.godot',
];

/**
 * The folder of the package or project `path` belongs to (of its nearest
 * manifest), `''` for the repository.
 */
export function packageRoot(files: ReadonlySet<string>, path: string): string {
  const manifest = nearest(files, path.split('/').slice(0, -1), MANIFESTS);
  return manifest?.split('/').slice(0, -1).join('/') ?? '';
}

/**
 * Files of the same language that `current` may import, nearest folders
 * first (they are read one by one, so a limit keeps big repositories fast).
 * Only files of its own package: another package of a monorepo is
 * imported by its name, like a library.
 */
export function candidateFiles(
  files: ReadonlySet<string>,
  current: string,
  limit: number
): string[] {
  const language = languageOf(current);
  const root = packageRoot(files, current);
  return [...files]
    .filter(
      (path) =>
        path !== current &&
        (root === '' || path.startsWith(`${root}/`)) &&
        language !== undefined &&
        languageOf(path) === language &&
        !SKIPPED.test(path) &&
        !/\.(?:spec|test)\.[^.]+$/.test(path)
    )
    .map((path) => ({ path, near: sharedPrefix(path, current) }))
    .toSorted((a, b) => b.near - a.near || a.path.localeCompare(b.path))
    .slice(0, limit)
    .map((entry) => entry.path);
}

/** The folder of `project.godot` above `path` (Godot's `res://`). */
export function godotRoot(files: ReadonlySet<string>, path: string): string {
  const parts = path.split('/').slice(0, -1);
  while (parts.length > 0) {
    const dir = parts.join('/');
    if (files.has(`${dir}/project.godot`)) {
      return dir;
    }

    parts.pop();
  }

  return '';
}

/** `bullet_enemy.gd` → `BulletEnemy`, the usual name of a preload. */
function scriptName(path: string): string {
  const base = (path.split('/').at(-1) ?? path).replace(/\.gd$/, '');
  return base
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join('');
}

/**
 * Names of other files for the action menu: their exported functions and
 * values (a GDScript file is one script to preload). Names this file
 * declares or imports already are left out.
 */
export function externalNames(
  exports: ReadonlyMap<string, ReadonlyArray<ScriptSymbol>>,
  doc: GraphDocument | null,
  from: string,
  root: string
): ExternalName[] {
  const taken = new Set(
    (doc?.symbols ?? []).filter((s) => s.scope === '').map((s) => s.name)
  );
  const result: ExternalName[] = [];
  const add = (
    entry: Omit<ExternalName, 'request' | 'where' | 'expression'>,
    imported: string
  ): void => {
    if (!taken.has(entry.name) && /^[A-Za-z_$][\w$]*$/.test(entry.name)) {
      taken.add(entry.name);
      result.push({
        ...entry,
        expression: entry.kind === 'class' ? `new ${entry.name}()` : entry.name,
        where: relativePath(from, entry.path),
        request: { path: entry.path, from, name: entry.name, imported, root },
      });
    }
  };

  for (const [path, symbols] of exports) {
    if (languageOf(path) === 'gdscript') {
      const name = scriptName(path);
      add({ name, path, kind: 'value', callee: `${name}.new` }, '*');
      continue;
    }

    for (const symbol of symbols) {
      const imported = symbol.modifiers.includes('export default')
        ? 'default'
        : symbol.name;
      if (symbol.kind === 'function') {
        add(
          {
            name: symbol.name,
            path,
            kind: 'function',
            callee: symbol.name,
            ...signature(symbol),
          },
          imported
        );
      } else if (symbol.kind === 'variable' || symbol.kind === 'constant') {
        add(
          { name: symbol.name, path, kind: 'value', callee: symbol.name },
          imported
        );
      } else if (
        symbol.kind === 'class' &&
        CONSTRUCTED.has(languageOf(path) ?? '')
      ) {
        add(
          { name: symbol.name, path, kind: 'class', callee: symbol.name },
          imported
        );
      }
    }
  }

  return result.toSorted((a, b) => a.name.localeCompare(b.name));
}

/** Languages whose classes are made with `new` (offered as `new X()`). */
const CONSTRUCTED: ReadonlySet<string> = new Set(['typescript']);

/**
 * Names of a library module for the action menu. Python uses the module
 * (`import math` and `math.sqrt()`), TypeScript named imports (`import {
 * computed } from 'vue'`).
 */
export function libraryNames(
  module: string,
  exports: ReadonlyArray<ScriptSymbol>,
  style: 'module' | 'named',
  from: string
): ExternalName[] {
  const result: ExternalName[] = [];
  const binding = module.split('.')[0] ?? module;
  for (const symbol of exports) {
    const kind =
      symbol.kind === 'function'
        ? 'function'
        : symbol.kind === 'variable' || symbol.kind === 'constant'
          ? 'value'
          : symbol.kind === 'class' && style === 'named'
            ? 'class'
            : undefined;
    if (!kind || symbol.modifiers.includes('export default')) {
      continue;
    }

    const member = `${module}.${symbol.name}`;
    const typed = kind === 'function' ? signature(symbol) : {};
    result.push(
      style === 'module'
        ? {
            ...typed,
            name: binding,
            path: module,
            where: module,
            kind,
            callee: member,
            expression: member,
            request: { path: '', from, name: binding, imported: '*', module },
          }
        : {
            ...typed,
            name: symbol.name,
            path: module,
            where: module,
            kind,
            callee: symbol.name,
            expression: kind === 'class' ? `new ${symbol.name}()` : symbol.name,
            request: {
              path: '',
              from,
              name: symbol.name,
              imported: symbol.name,
              module,
            },
          }
    );
  }

  return result;
}

/** A type of another file or a library, for the type picker. */
export interface ExternalType {
  name: string;
  /** Where it comes from, for the hint (`./types.ts`, `vue`). */
  where: string;
  request: ImportRequest;
}

const TYPE_KINDS: ReadonlySet<string> = new Set(['type', 'class', 'enum']);

/** TypeScript imports what is used as a type only as `import type`. */
function typeRequest(request: ImportRequest): ImportRequest {
  return languageOf(request.from) === 'typescript'
    ? { ...request, typeOnly: true }
    : request;
}

/**
 * Types other files export (classes, interfaces, aliases, enums), for the
 * type picker; names this file declares or imports already are left out,
 * GDScript's scripts are global classes already.
 */
export function externalTypes(
  exports: ReadonlyMap<string, ReadonlyArray<ScriptSymbol>>,
  doc: GraphDocument | null,
  from: string,
  root: string
): ExternalType[] {
  const taken = new Set(
    (doc?.symbols ?? []).filter((s) => s.scope === '').map((s) => s.name)
  );
  const result: ExternalType[] = [];
  for (const [path, symbols] of exports) {
    if (languageOf(path) === 'gdscript') {
      continue;
    }

    for (const symbol of symbols) {
      if (!TYPE_KINDS.has(symbol.kind) || taken.has(symbol.name)) {
        continue;
      }

      taken.add(symbol.name);
      const imported = symbol.modifiers.includes('export default')
        ? 'default'
        : symbol.name;
      result.push({
        name: symbol.name,
        where: relativePath(from, path),
        request: typeRequest({
          path,
          from,
          name: symbol.name,
          imported,
          root,
        }),
      });
    }
  }

  return result.toSorted((a, b) => a.name.localeCompare(b.name));
}

/** Types a library module exports (named imports), for the type picker. */
export function libraryTypes(
  module: string,
  exports: ReadonlyArray<ScriptSymbol>,
  from: string
): ExternalType[] {
  return exports
    .filter(
      (s) => TYPE_KINDS.has(s.kind) && !s.modifiers.includes('export default')
    )
    .map((s) => ({
      name: s.name,
      where: module,
      request: typeRequest({
        path: '',
        from,
        name: s.name,
        imported: s.name,
        module,
      }),
    }));
}
