import { withoutComments } from './npm-declarations';
import { folderOf, nearest } from './project-files';

/**
 * Where a TypeScript file runs, as its `tsconfig.json` says: with the DOM
 * (`lib` has `DOM`, or no `lib`, TypeScript's default) and / or Node.js
 * (`types` has `node`, or no `types` and the project depends on
 * `@types/node`). Without a config, a file importing Node.js modules runs
 * in Node.js too.
 */
export interface TsEnvironment {
  dom: boolean;
  node: boolean;
  /** The config it was read from, if any. */
  config?: string;
}

type Options = Record<string, unknown>;

interface Config {
  path: string;
  json: Record<string, unknown>;
}

/** `tsconfig.json` is JSON with comments and trailing commas. */
export function parseJsonc(text: string): Record<string, unknown> | undefined {
  try {
    const json = JSON.parse(
      withoutComments(text).replaceAll(/,(\s*[}\]])/g, '$1')
    ) as unknown;
    return json && typeof json === 'object'
      ? (json as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** `a/b/../c` → `a/c`. */
function normalize(parts: ReadonlyArray<string>): string {
  const out: string[] = [];
  for (const part of parts) {
    if (part === '..') {
      out.pop();
    } else if (part !== '.' && part !== '') {
      out.push(part);
    }
  }

  return out.join('/');
}

/** A path relative to a folder (`../base.json` from `apps/web`). */
function joinPath(dir: ReadonlyArray<string>, relative: string): string {
  return normalize([...dir, ...relative.split('/')]);
}

/** Whether `path` (relative to the config's folder) matches a pattern. */
export function matchesPattern(path: string, pattern: string): boolean {
  let glob = pattern.replace(/^\.\//, '').replace(/\/$/, '');
  // A folder (no wildcard, no extension) means everything in it.
  if (!/[*?]/.test(glob) && !/\.[^/]+$/.test(glob)) {
    glob = `${glob}/**/*`;
  }

  const source = glob
    .split('/')
    .map((part) =>
      part === '**'
        ? '\u0000'
        : part
            .replaceAll(/[.+^${}()|[\]\\]/g, String.raw`\$&`)
            .replaceAll('*', '[^/]*')
            .replaceAll('?', '[^/]')
    )
    .join('/')
    .replaceAll('\u0000/', '(?:.*/)?')
    .replaceAll('/\u0000', '(?:/.*)?')
    .replaceAll('\u0000', '.*');
  return new RegExp(`^${source}$`).test(path);
}

/** Whether a config's `files` / `include` / `exclude` take in `path`. */
function covers(config: Config, path: string): boolean {
  const dir = folderOf(config.path);
  const prefix = dir.length > 0 ? `${dir.join('/')}/` : '';
  if (!path.startsWith(prefix)) {
    return false;
  }

  const relative = path.slice(prefix.length);
  const list = (key: string): string[] | undefined => {
    const value = config.json[key];
    return Array.isArray(value)
      ? value.filter((v): v is string => typeof v === 'string')
      : undefined;
  };
  const files = list('files');
  const include = list('include') ?? (files ? [] : ['**/*']);
  const included =
    (files ?? []).some((f) => joinPath([], f) === relative) ||
    include.some((pattern) => matchesPattern(relative, pattern));
  return (
    included &&
    !(list('exclude') ?? []).some((pattern) =>
      matchesPattern(relative, pattern)
    )
  );
}

/** Reads and parses a config file; `undefined` when it isn't one. */
async function readConfig(
  files: ReadonlySet<string>,
  read: (path: string) => Promise<string>,
  path: string
): Promise<Config | undefined> {
  const candidates = path.endsWith('.json')
    ? [path]
    : [`${path}.json`, `${path}/tsconfig.json`];
  const found = candidates.find((candidate) => files.has(candidate));
  if (!found) {
    return undefined;
  }

  const json = parseJsonc(await read(found).catch(() => ''));
  return json ? { path: found, json } : undefined;
}

/**
 * The compiler options of a config with those it `extends` (relative ones;
 * a package's base config can't be read here): the nearer config wins per
 * option, like TypeScript.
 */
async function compilerOptions(
  files: ReadonlySet<string>,
  read: (path: string) => Promise<string>,
  config: Config,
  depth = 0
): Promise<Options> {
  const own = (config.json.compilerOptions ?? {}) as Options;
  const extendsValue = config.json.extends;
  const bases = (
    Array.isArray(extendsValue) ? extendsValue : [extendsValue]
  ).filter((base): base is string => typeof base === 'string');
  let merged: Options = {};
  for (const base of bases) {
    if (depth > 5 || !/^\.{1,2}\//.test(base)) {
      continue;
    }

    const parent = await readConfig(
      files,
      read,
      joinPath(folderOf(config.path), base)
    );
    if (parent) {
      merged = {
        ...merged,
        ...(await compilerOptions(files, read, parent, depth + 1)),
      };
    }
  }

  return { ...merged, ...own };
}

/**
 * The config that compiles `path`: the nearest `tsconfig.json` (or
 * `jsconfig.json`), or for a solution-style one (`references` to
 * `tsconfig.app.json`, `tsconfig.node.json`) the referenced config whose
 * `include` takes the file.
 */
async function configOf(
  files: ReadonlySet<string>,
  read: (path: string) => Promise<string>,
  path: string
): Promise<Config | undefined> {
  const found = nearest(files, folderOf(path), [
    'tsconfig.json',
    'jsconfig.json',
  ]);
  const config = found ? await readConfig(files, read, found) : undefined;
  if (!config) {
    return undefined;
  }

  const references = Array.isArray(config.json.references)
    ? config.json.references
    : [];
  for (const reference of references) {
    const target = (reference as { path?: unknown } | null)?.path;
    if (typeof target !== 'string') {
      continue;
    }

    const referenced = await readConfig(
      files,
      read,
      joinPath(folderOf(config.path), target)
    );
    if (referenced && covers(referenced, path)) {
      return referenced;
    }
  }

  return config;
}

/** Node.js's modules, as `node:fs` or the bare `fs`. */
export function importsNodeModules(
  text: string,
  builtins: ReadonlySet<string>
): boolean {
  return [
    ...withoutComments(text).matchAll(
      /\b(?:from|import|require\()\s*['"]([^'"]+)['"]/g
    ),
  ].some(([, specifier = '']) => {
    const name = specifier.replace(/^node:/, '').split('/')[0] ?? '';
    return specifier.startsWith('node:') || builtins.has(name);
  });
}

/**
 * The environment of the TypeScript file at `path` (`text` is its code, for
 * files without a config). `hasNodeTypes`: the project depends on
 * `@types/node`.
 */
export async function tsEnvironment(
  files: ReadonlySet<string> | undefined,
  read: ((path: string) => Promise<string>) | undefined,
  path: string,
  options: {
    text: string;
    hasNodeTypes: boolean;
    builtins: ReadonlySet<string>;
  }
): Promise<TsEnvironment> {
  const config = files && read ? await configOf(files, read, path) : undefined;
  if (!config || !files || !read) {
    return {
      dom: true,
      node:
        options.hasNodeTypes ||
        importsNodeModules(options.text, options.builtins),
    };
  }

  const compiler = await compilerOptions(files, read, config);
  const names = (key: string): string[] | undefined => {
    const value = compiler[key];
    return Array.isArray(value)
      ? value
          .filter((v): v is string => typeof v === 'string')
          .map((v) => v.toLowerCase())
      : undefined;
  };
  const lib = names('lib');
  const types = names('types');
  return {
    // TypeScript's default libraries include the DOM.
    dom: lib ? lib.some((l) => l === 'dom' || l.startsWith('dom.')) : true,
    // Without `types`, every installed `@types` package counts.
    node: types ? types.includes('node') : options.hasNodeTypes,
    config: config.path,
  };
}
