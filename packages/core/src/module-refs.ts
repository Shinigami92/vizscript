import type { GraphDocument, SourceRange } from './ir';

/**
 * A file referenced from source code (an import path, `preload("…")`, …),
 * so editors can open it on Ctrl/Cmd+click.
 */
export interface ModuleReference {
  /** Range of the path in the source (without quotes). */
  range: SourceRange;
  /** The path as written. */
  specifier: string;
  /**
   * Files the reference may point to, most likely first. `./x` and `../x` are
   * relative to the referencing file, `/x` to the repository root (or to the
   * `anchor` directory).
   */
  candidates: ReadonlyArray<string>;
  /**
   * Marker file of the root for `/x` candidates: the nearest ancestor
   * directory of the referencing file containing it (e.g. `project.godot`
   * for Godot's `res://`). Falls back to the repository root.
   */
  anchor?: string;
  /**
   * Name defined in the referenced file (a use of an imported function,
   * class or constant). Without it the reference points at the whole file.
   */
  symbol?: string;
  /** The name is only a type (`import type { X }`). */
  typeOnly?: boolean;
}

function dirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}

/**
 * Joins a repository directory and a relative path, resolving `.` and `..`.
 * Returns `null` for paths leaving the repository.
 */
export function joinRepoPath(dir: string, relative: string): string | null {
  const parts = dir === '' ? [] : dir.split('/');
  for (const segment of relative.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }

    if (segment === '..') {
      if (parts.length === 0) {
        return null;
      }

      parts.pop();
    } else {
      parts.push(segment);
    }
  }

  return parts.length === 0 ? null : parts.join('/');
}

function anchorDir(
  from: string,
  anchor: string | undefined,
  exists: (path: string) => boolean
): string {
  if (!anchor) {
    return '';
  }

  let dir = dirname(from);
  for (;;) {
    if (exists(dir === '' ? anchor : `${dir}/${anchor}`)) {
      return dir;
    }

    if (dir === '') {
      return '';
    }

    dir = dirname(dir);
  }
}

/**
 * Returns the repository path of the first candidate that exists, or `null`.
 * `from` is the repository path of the referencing file.
 */
export function resolveModuleReference(
  from: string,
  reference: ModuleReference,
  exists: (path: string) => boolean
): string | null {
  let root: string | undefined;
  for (const candidate of reference.candidates) {
    let path: string | null;
    if (candidate.startsWith('/')) {
      root ??= anchorDir(from, reference.anchor, exists);
      path = joinRepoPath(root, candidate);
    } else {
      path = joinRepoPath(dirname(from), candidate);
    }

    if (path !== null && path !== from && exists(path)) {
      return path;
    }
  }

  return null;
}

function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/**
 * Where `symbol` is defined in a parsed file: its function graph, or else
 * the first declaration-like line (`const x`, `class X`, `def x`, …).
 */
export function findDefinition(
  doc: GraphDocument | null,
  text: string,
  symbol: string
): SourceRange | undefined {
  const functions = doc?.functions ?? [];
  const fn =
    functions.find((f) => f.name === symbol) ??
    functions.find((f) => f.name.endsWith(`.${symbol}`));
  if (fn) {
    return fn.range;
  }

  const declaration = new RegExp(
    String.raw`^[ \t]*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum|namespace|def|func|signal|static\s+func)\s+(${escapeRegExp(symbol)})\b`,
    'm'
  );
  const match = text.match(declaration);
  if (match?.index === undefined) {
    return undefined;
  }

  const start = match.index + match[0].length - symbol.length;
  return { start, end: start + symbol.length };
}
