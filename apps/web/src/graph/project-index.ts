import type {
  GraphDocument,
  ImportRequest,
  ScriptSymbol,
} from '@vizscript/core';
import { relativePath } from '@vizscript/core';
import { languageOf } from './languages';

/** A name of another file the action menu offers; using it imports it. */
export interface ExternalName {
  /** Local name in this file. */
  name: string;
  /** File that declares it. */
  path: string;
  /** The file relative to the importing one (`./util.ts`), for hints. */
  where: string;
  /** Called (`fn()`, `Script.new()`) or read (`LIMIT`). */
  kind: 'function' | 'value';
  /** What a call node calls (`fn`, `Bullet.new`). */
  callee: string;
  request: ImportRequest;
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

/**
 * Files of the same language that `current` may import, nearest folders
 * first (they are read one by one, so a limit keeps big repositories fast).
 */
export function candidateFiles(
  files: Iterable<string>,
  current: string,
  limit: number
): string[] {
  const language = languageOf(current);
  return [...files]
    .filter(
      (path) =>
        path !== current &&
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
    entry: Omit<ExternalName, 'request' | 'where'>,
    imported: string
  ): void => {
    if (!taken.has(entry.name) && /^[A-Za-z_$][\w$]*$/.test(entry.name)) {
      taken.add(entry.name);
      result.push({
        ...entry,
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
          { name: symbol.name, path, kind: 'function', callee: symbol.name },
          imported
        );
      } else if (symbol.kind === 'variable' || symbol.kind === 'constant') {
        add(
          { name: symbol.name, path, kind: 'value', callee: symbol.name },
          imported
        );
      }
    }
  }

  return result.toSorted((a, b) => a.name.localeCompare(b.name));
}
