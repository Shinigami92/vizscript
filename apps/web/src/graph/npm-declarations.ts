import {
  CDN,
  fetchText,
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
 * Node.js modules: not on npm (or placeholder packages there), and
 * `@types/node` is large, so they stay unresolved.
 */
const SKIPPED = new Set([
  'node',
  'assert',
  'buffer',
  'child_process',
  'cluster',
  'crypto',
  'dgram',
  'dns',
  'events',
  'fs',
  'http',
  'http2',
  'https',
  'module',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'querystring',
  'readline',
  'stream',
  'string_decoder',
  'timers',
  'tls',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'worker_threads',
  'zlib',
]);

const SPECIFIERS = [
  /\b(?:import|export)\s[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/** Modules a declaration file refers to; `types` from `/// <reference>`. */
export function declarationSpecifiers(text: string): {
  modules: string[];
  types: string[];
  paths: string[];
} {
  const modules = new Set<string>();
  for (const pattern of SPECIFIERS) {
    for (const match of text.matchAll(pattern)) {
      if (match[1]) {
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

interface PackageResult {
  files: LibFile[];
  /** Packages its declarations import, with their version ranges. */
  dependencies: Array<[name: string, range: string]>;
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
  const dependencies = new Map<string, string>();
  const depend = (specifier: string): void => {
    const dependency = packageName(specifier);
    if (dependency && dependency !== name && !SKIPPED.has(dependency)) {
      dependencies.set(dependency, ranges[dependency] ?? 'latest');
    }
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
  if (entries.size === 0) {
    entries.add('index.d.ts');
  }

  const read = new Set<string>();
  const queue = [...entries].map((path) => [path]);
  let found = 0;
  while (queue.length > 0 && read.size < PACKAGE_LIMIT) {
    const options = queue.shift() ?? [];
    let text: string | undefined;
    let path: string | undefined;
    for (const option of options) {
      if (read.has(option)) {
        break;
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
      depend(reference);
    }
  }

  // No declarations of its own: TypeScript looks in `@types`.
  if (found === 0 && !name.startsWith('@types/')) {
    dependencies.set(typesPackage(name), 'latest');
  }

  return { files, dependencies: [...dependencies] };
}

function packageFiles(name: string, range: string): Promise<PackageResult> {
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
  let level = roots.filter(([name]) => !SKIPPED.has(name));
  while (level.length > 0 && files.length < limit) {
    const next = level.filter(([name]) => !seen.has(name));
    for (const [name] of next) {
      seen.add(name);
    }

    const results = await Promise.all(
      next.map(([name, range]) => packageFiles(name, range))
    );
    level = [];
    for (const result of results) {
      files.push(...result.files);
      level.push(...result.dependencies);
    }
  }

  return files.slice(0, limit);
}
