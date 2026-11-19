import {
  CDN,
  fetchText,
  hasDeclarations,
  packageFiles,
  packageName,
  typesOfExports,
  typesPackage,
} from './npm-types';

/**
 * Declaration files of npm packages for TypeScript's checker, read from
 * jsDelivr (the repository has no `node_modules`): each package's
 * `package.json` and the `.d.ts` files its types entry reaches, at the
 * paths TypeScript resolves (`node_modules/<name>/…`).
 */
export interface LibFile {
  /** `node_modules/<name>/<path in the package>`. */
  path: string;
  text: string;
}

/** Files of one package, at most. */
const PACKAGE_LIMIT = 250;

/**
 * Node.js modules (as Node's `builtinModules` lists them): not on npm, or
 * placeholder packages there, and `@types/node` is large, so they stay
 * unresolved.
 */
const SKIPPED = new Set([
  'node',
  'assert',
  'async_hooks',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'diagnostics_channel',
  'dns',
  'domain',
  'events',
  'fs',
  'http',
  'http2',
  'https',
  'inspector',
  'module',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'repl',
  'stream',
  'string_decoder',
  'sys',
  'timers',
  'tls',
  'trace_events',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'wasi',
  'worker_threads',
  'zlib',
]);

const SPECIFIERS = [
  /\b(?:import|export)\s[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/**
 * The text with its comments blanked out (strings stay), so examples in doc
 * comments (`import Home from './pages/Home.vue'`) aren't taken for imports.
 */
export function withoutComments(text: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const char = text[i] ?? '';
    if (quote) {
      out += char;
      if (char === '\\') {
        out += text[i + 1] ?? '';
        i++;
      } else if (char === quote || (char === '\n' && quote !== '`')) {
        quote = null;
      }
    } else if (char === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      out += ' '.repeat(stop - i);
      i = stop - 1;
    } else if (char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      // Line breaks stay, so nothing joins across lines.
      out += text.slice(i, stop).replaceAll(/[^\n]/g, ' ');
      i = stop - 1;
    } else {
      if (char === "'" || char === '"' || char === '`') {
        quote = char;
      }

      out += char;
    }
  }

  return out;
}

/**
 * A module specifier as written in code: a relative or absolute path, or a
 * package name with an optional subpath (`node:fs`, `@scope/pkg/sub`).
 */
function isSpecifier(value: string): boolean {
  return (
    /^\.{0,2}\/[^\s*,]*$/.test(value) ||
    /^(?:[a-z]+:)?(?:@[\w.-]+\/)?[\w.-]+(?:\/[\w.@/-]*)?$/.test(value)
  );
}

/** Modules a declaration file refers to; `types` from `/// <reference>`. */
export function declarationSpecifiers(text: string): {
  modules: string[];
  types: string[];
  paths: string[];
} {
  const code = withoutComments(text);
  const modules = new Set<string>();
  for (const pattern of SPECIFIERS) {
    for (const match of code.matchAll(pattern)) {
      if (match[1] && isSpecifier(match[1])) {
        modules.add(match[1]);
      }
    }
  }

  const types = new Set<string>();
  const paths = new Set<string>();
  for (const match of text.matchAll(
    /^\s*\/\/\/\s*<reference\s+(path|types)\s*=\s*["']([^"']+)["']/gm
  )) {
    const value = match[2];
    if (value) {
      (match[1] === 'path' ? paths : types).add(value);
    }
  }

  return { modules: [...modules], types: [...types], paths: [...paths] };
}

/**
 * Declaration files a relative specifier may mean, as paths inside the
 * package (`from` is the importing file's path there).
 */
export function candidates(from: string, specifier: string): string[] {
  const url = new URL(specifier, `https://pkg/${from}`).pathname.slice(1);
  if (url === '' || url.endsWith('/') || /(?:^|\/)\.{1,2}$/.test(specifier)) {
    return [`${url.replace(/\/?$/, '/')}index.d.ts`.replace(/^\//, '')];
  }

  if (/\.d\.[cm]?ts$/.test(url)) {
    return [url];
  }

  const js = /^(.*)\.([cm]?)(?:js|ts)$/.exec(url);
  if (js) {
    return [`${js[1]}.d.${js[2]}ts`];
  }

  return [`${url}.d.ts`, `${url}/index.d.ts`];
}

/** Every declaration file named in an `exports` map (subpaths too). */
function exportedTypes(exports: unknown, into: Set<string>): void {
  if (typeof exports === 'string') {
    // Patterns (`./lib/*.d.ts`) name no file to read.
    if (/\.d\.[cm]?ts$/.test(exports) && !exports.includes('*')) {
      into.add(exports.replace(/^\.\//, ''));
    }

    return;
  }

  if (exports && typeof exports === 'object') {
    for (const value of Object.values(exports)) {
      exportedTypes(value, into);
    }
  }
}

/**
 * A package to read: the first option that has declarations (`x` or its
 * DefinitelyTyped `@types/x`, in the order TypeScript would find them).
 */
interface Dependency {
  options: Array<{ name: string; range: string }>;
}

interface PackageResult {
  files: LibFile[];
  /** Packages its declarations import, with their version ranges. */
  dependencies: Dependency[];
}

/** Packages read during one session, by `name@range`. */
const packages = new Map<string, Promise<PackageResult>>();

async function readPackage(
  name: string,
  range: string
): Promise<PackageResult> {
  const manifestText = await fetchText(
    `${CDN}${name}@${encodeURIComponent(range)}/package.json`
  );
  if (manifestText === undefined) {
    return { files: [], dependencies: [] };
  }

  let json: Record<string, unknown>;
  try {
    json = JSON.parse(manifestText) as Record<string, unknown>;
  } catch {
    return { files: [], dependencies: [] };
  }

  const version = typeof json.version === 'string' ? json.version : range;
  const base = `${CDN}${name}@${version}/`;
  const ranges: Record<string, string> = {
    ...(json.peerDependencies as Record<string, string> | undefined),
    ...(json.dependencies as Record<string, string> | undefined),
  };
  const files: LibFile[] = [
    { path: `node_modules/${name}/package.json`, text: manifestText },
  ];
  // Only files that exist are read (unless the listing is unavailable).
  const listing = await packageFiles(name, version);
  const exists = (path: string): boolean => !listing || listing.has(path);
  const dependencies = new Map<string, Dependency>();
  const depend = (specifier: string, typesFirst = false): void => {
    const dependency = packageName(specifier);
    if (
      !dependency ||
      dependency === name ||
      SKIPPED.has(dependency) ||
      dependencies.has(dependency)
    ) {
      return;
    }

    const types = typesPackage(dependency);
    // What the package depends on says which one exists (`rollup` depends
    // on `@types/estree`, `@types/bun` on `bun-types`); else `@types/x`
    // first for `/// <reference types>`, the package itself for imports.
    const order =
      dependency.startsWith('@types/') || ranges[dependency]
        ? [dependency]
        : ranges[types]
          ? [types]
          : typesFirst
            ? [types, dependency]
            : [dependency, types];
    dependencies.set(dependency, {
      options: order.map((option) => ({
        name: option,
        range: ranges[option] ?? 'latest',
      })),
    });
  };

  const entries = new Set<string>();
  const entry =
    (typeof json.types === 'string' ? json.types : undefined) ??
    (typeof json.typings === 'string' ? json.typings : undefined) ??
    typesOfExports(json.exports);
  if (entry) {
    entries.add(entry.replace(/^\.\//, ''));
  }

  exportedTypes(json.exports, entries);
  if (entries.size === 0 && exists('index.d.ts')) {
    entries.add('index.d.ts');
  }

  const read = new Set<string>();
  // A listing without declarations: straight to `@types`.
  const queue =
    listing && !hasDeclarations(listing)
      ? []
      : [...entries].map((path) => [path]);
  let found = 0;
  while (queue.length > 0 && read.size < PACKAGE_LIMIT) {
    const options = queue.shift() ?? [];
    let text: string | undefined;
    let path: string | undefined;
    for (const option of options) {
      if (read.has(option)) {
        break;
      }

      if (!exists(option)) {
        continue;
      }

      text = await fetchText(base + option);
      if (text !== undefined) {
        path = option;
        break;
      }
    }

    if (text === undefined || path === undefined) {
      continue;
    }

    read.add(path);
    found++;
    files.push({ path: `node_modules/${name}/${path}`, text });
    const refs = declarationSpecifiers(text);
    for (const specifier of refs.modules) {
      if (specifier.startsWith('.')) {
        queue.push(candidates(path, specifier));
      } else {
        depend(specifier);
      }
    }

    for (const reference of refs.paths) {
      queue.push(candidates(path, reference));
    }

    for (const reference of refs.types) {
      depend(reference, true);
    }
  }

  // No declarations of its own: TypeScript looks in `@types`.
  if (found === 0 && !name.startsWith('@types/')) {
    dependencies.set(typesPackage(name), {
      options: [{ name: typesPackage(name), range: 'latest' }],
    });
  }

  return { files, dependencies: [...dependencies.values()] };
}

function packageResult(name: string, range: string): Promise<PackageResult> {
  const key = `${name}@${range}`;
  let result = packages.get(key);
  if (!result) {
    result = readPackage(name, range).catch(() => ({
      files: [],
      dependencies: [],
    }));
    packages.set(key, result);
  }

  return result;
}

/**
 * Declaration files of `roots` and the packages their declarations import
 * (one version per package name, the first one met), up to `limit` files.
 */
export async function npmDeclarations(
  roots: ReadonlyArray<readonly [name: string, range: string]>,
  limit = 800
): Promise<LibFile[]> {
  const seen = new Set<string>();
  const files: LibFile[] = [];
  let level: Dependency[] = roots
    .filter(([name]) => !SKIPPED.has(name))
    .map(([name, range]) => ({ options: [{ name, range }] }));
  while (level.length > 0 && files.length < limit) {
    const key = (dependency: Dependency): string =>
      dependency.options[0]?.name ?? '';
    const next = level.filter((dependency) => !seen.has(key(dependency)));
    for (const dependency of next) {
      seen.add(key(dependency));
    }

    const results = await Promise.all(
      next.map(async ({ options }) => {
        // The first option with declarations (beyond its `package.json`).
        for (const [index, { name, range }] of options.entries()) {
          const result = await packageResult(name, range);
          if (result.files.length > 1 || index === options.length - 1) {
            return result;
          }
        }

        return { files: [], dependencies: [] };
      })
    );
    level = [];
    for (const result of results) {
      files.push(...result.files);
      level.push(...result.dependencies);
    }
  }

  return files.slice(0, limit);
}
