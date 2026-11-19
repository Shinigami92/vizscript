import type { GraphDocument, ScriptSymbol } from '@vizscript/core';
import { exportedSymbols, withReexports } from '@vizscript/core';
import { MissingUrls } from './missing-urls';
import { registryUrl, typeRegistryAvailable } from './type-registry';

/**
 * Declarations of npm packages, read from their `.d.ts` files on jsDelivr
 * (the repository has no `node_modules`). Re-exports are followed, also
 * into other packages (`vue` → `@vue/runtime-dom` → … → `@vue/reactivity`).
 */
export const CDN = 'https://cdn.jsdelivr.net/npm/';

/** Files read during one session, by URL (shared by all workspaces). */
const texts = new Map<string, Promise<string | undefined>>();

/** Files that answered 404, also in earlier visits. */
const missing = new MissingUrls();

/** A request to jsDelivr gives up after this long. */
const FETCH_TIMEOUT_MS = 15_000;

/**
 * One request: the text, `null` for a 404, `undefined` for anything that
 * may work later (network errors, timeouts, rate limits).
 */
async function request(url: string): Promise<string | null | undefined> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (response.ok) {
      return await response.text();
    }

    return response.status === 404 ? null : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The file from the server's type registry when it has one (`/api/types`,
 * cached there for every user), else from jsDelivr; jsDelivr too when the
 * registry refuses or fails.
 */
async function load(url: string): Promise<string | null | undefined> {
  const proxied = (await typeRegistryAvailable())
    ? registryUrl(url)
    : undefined;
  const viaRegistry = proxied ? await request(proxied) : undefined;
  return viaRegistry ?? request(url);
}

/**
 * Text of a file, `undefined` when it can't be read. A missing file (404)
 * stays missing for the session and is remembered for later visits
 * (`MissingUrls`); other failures (network errors, timeouts, rate limits)
 * are tried again on the next request.
 */
export function fetchText(url: string): Promise<string | undefined> {
  let text = texts.get(url);
  if (!text && missing.has(url)) {
    text = Promise.resolve(undefined);
    texts.set(url, text);
  }

  if (!text) {
    text = load(url).then((result) => {
      if (result === null) {
        missing.add(url);
        return undefined;
      }

      if (result === undefined) {
        texts.delete(url);
      }

      return result;
    });
    texts.set(url, text);
  }

  return text;
}

const LISTING = 'https://data.jsdelivr.com/v1/packages/npm/';

const listings = new Map<string, Promise<ReadonlySet<string> | undefined>>();

/**
 * The files of an exact package version (paths inside it, no leading `/`),
 * from jsDelivr's listing: a file is only read when it exists, instead of
 * guessing `index.d.ts`, `x.d.ts` or `x/index.d.ts`. `undefined` when the
 * listing can't be read (then the files are guessed as before).
 */
export function packageFiles(
  name: string,
  version: string
): Promise<ReadonlySet<string> | undefined> {
  const key = `${name}@${version}`;
  let files = listings.get(key);
  if (!files) {
    files = fetchText(`${LISTING}${key}?structure=flat`).then((text) => {
      if (text === undefined) {
        listings.delete(key);
        return undefined;
      }

      try {
        const json = JSON.parse(text) as { files?: Array<{ name?: unknown }> };
        return new Set(
          (json.files ?? [])
            .map((file) => file.name)
            .filter((path): path is string => typeof path === 'string')
            .map((path) => path.replace(/^\//, ''))
        );
      } catch {
        return undefined;
      }
    });
    listings.set(key, files);
  }

  return files;
}

/** Whether a listing names any declaration file. */
export function hasDeclarations(files: ReadonlySet<string>): boolean {
  return [...files].some((path) => /\.d\.[cm]?ts$/.test(path));
}

/** `@scope/pkg/sub` → `@scope/pkg`; relative, absolute and `node:` → none. */
export function packageName(specifier: string): string | undefined {
  if (/^(?:\.|\/|[a-z]+:)/.test(specifier)) {
    return undefined;
  }

  const [first, second] = specifier.split('/');
  if (specifier.startsWith('@')) {
    return second ? `${first}/${second}` : undefined;
  }

  return first || undefined;
}

interface Manifest {
  /** URL of the package version's folder (ends with `/`). */
  base: string;
  /** Path of the types entry inside it. */
  types: string | undefined;
  dependencies: Record<string, string>;
  /** The files of the version (`packageFiles`), if listed. */
  files: ReadonlySet<string> | undefined;
}

export function typesOfExports(exports: unknown): string | undefined {
  if (typeof exports === 'string') {
    return /\.d\.[cm]?ts$/.test(exports) ? exports : undefined;
  }

  if (!exports || typeof exports !== 'object') {
    return undefined;
  }

  const record = exports as Record<string, unknown>;
  if (typeof record.types === 'string') {
    return record.types;
  }

  // `{ ".": … }`, then conditions (`import`, `require`, `default`).
  for (const key of ['.', 'import', 'require', 'default', 'node']) {
    const found = typesOfExports(record[key]);
    if (found) {
      return found;
    }
  }

  return undefined;
}

/** Folder name of a package's DefinitelyTyped types (`@types/…`). */
export function typesPackage(name: string): string {
  return `@types/${name.replace(/^@/, '').replace('/', '__')}`;
}

/**
 * One resolution of a package's exports. Re-exports are followed one after
 * another, so every file on `path` is an ancestor of the one being read.
 */
interface Walk {
  /** Files being read on the current re-export path: a cycle ends there. */
  readonly path: Set<string>;
  /** Exports of the files this walk has read. */
  readonly done: Map<string, ScriptSymbol[]>;
}

interface ParsedFile {
  text: string;
  doc: GraphDocument;
}

export class NpmTypes {
  private readonly manifests = new Map<string, Promise<Manifest | undefined>>();
  /** Parsed declaration files, by URL. Reading one never waits on another. */
  private readonly parsed = new Map<string, Promise<ParsedFile | undefined>>();
  /** Exports of packages, by `name@range`. */
  private readonly packages = new Map<string, Promise<ScriptSymbol[]>>();

  public constructor(
    private readonly parse: (
      text: string,
      fileName: string
    ) => Promise<GraphDocument>
  ) {}

  private manifest(name: string, range: string): Promise<Manifest | undefined> {
    const key = `${name}@${range}`;
    let manifest = this.manifests.get(key);
    if (!manifest) {
      manifest = fetchText(
        `${CDN}${name}@${encodeURIComponent(range)}/package.json`
      ).then(async (text) => {
        if (!text) {
          this.manifests.delete(key);
          return undefined;
        }

        let json: Record<string, unknown>;
        try {
          json = JSON.parse(text) as Record<string, unknown>;
        } catch {
          return undefined;
        }

        const version = typeof json.version === 'string' ? json.version : range;
        const types =
          (typeof json.types === 'string' ? json.types : undefined) ??
          (typeof json.typings === 'string' ? json.typings : undefined) ??
          typesOfExports(json.exports);
        return {
          base: `${CDN}${name}@${version}/`,
          types: types?.replace(/^\.\//, ''),
          dependencies: {
            ...(json.peerDependencies as Record<string, string> | undefined),
            ...(json.dependencies as Record<string, string> | undefined),
          },
          files: await packageFiles(name, version),
        };
      });
      this.manifests.set(key, manifest);
    }

    return manifest;
  }

  /** Exports of a package (`range` as in `package.json`, or `latest`). */
  public exportsOf(name: string, range = 'latest'): Promise<ScriptSymbol[]> {
    const key = `${name}@${range}`;
    let exports = this.packages.get(key);
    if (!exports) {
      exports = this.packageExports(name, range, {
        path: new Set(),
        done: new Map(),
      });
      this.packages.set(key, exports);
    }

    return exports;
  }

  private async packageExports(
    name: string,
    range: string,
    walk: Walk
  ): Promise<ScriptSymbol[]> {
    const manifest = await this.manifest(name, range);
    // Without a types entry, TypeScript reads `index.d.ts` when there is one.
    const entry =
      manifest?.types ??
      (manifest?.files?.has('index.d.ts') ? 'index.d.ts' : undefined);
    if (manifest && entry) {
      return this.fileExports(manifest.base + entry, manifest, 0, walk);
    }

    // No types of its own: DefinitelyTyped.
    if (!name.startsWith('@types/')) {
      const types = await this.manifest(typesPackage(name), 'latest');
      if (types) {
        return this.fileExports(
          types.base + (types.types ?? 'index.d.ts'),
          types,
          0,
          walk
        );
      }
    }

    return [];
  }

  private async fileExports(
    url: string,
    manifest: Manifest,
    depth: number,
    walk: Walk
  ): Promise<ScriptSymbol[]> {
    const done = walk.done.get(url);
    if (done) {
      return done;
    }

    // A cycle (`a` re-exports `b`, `b` re-exports `a`): the file being read
    // has no exports yet.
    if (walk.path.has(url) || depth > 8) {
      return [];
    }

    walk.path.add(url);
    try {
      const exports = await this.readFile(url, manifest, depth, walk);
      walk.done.set(url, exports);
      return exports;
    } finally {
      walk.path.delete(url);
    }
  }

  private parsedFile(url: string): Promise<ParsedFile | undefined> {
    let file = this.parsed.get(url);
    if (!file) {
      file = fetchText(url).then(async (text) => {
        if (text === undefined) {
          // Not cached: `fetchText` knows whether to try again.
          this.parsed.delete(url);
          return undefined;
        }

        return { text, doc: await this.parse(text, 'types.d.ts') };
      });
      this.parsed.set(url, file);
    }

    return file;
  }

  private async readFile(
    url: string,
    manifest: Manifest,
    depth: number,
    walk: Walk
  ): Promise<ScriptSymbol[]> {
    const file = await this.parsedFile(url);
    if (!file) {
      return [];
    }

    return withReexports(
      exportedSymbols(file.doc, file.text),
      file.doc.reexports ?? [],
      async (specifier) => {
        const name = packageName(specifier);
        if (name) {
          return this.packageExports(
            name,
            manifest.dependencies[name] ?? 'latest',
            walk
          );
        }

        for (const candidate of declarationFiles(url, specifier)) {
          const listed =
            !manifest.files ||
            manifest.files.has(candidate.slice(manifest.base.length));
          if (listed && (await fetchText(candidate)) !== undefined) {
            return this.fileExports(candidate, manifest, depth + 1, walk);
          }
        }

        return [];
      }
    );
  }
}

/** `.d.ts` files a relative specifier of a declaration file may mean. */
function declarationFiles(from: string, specifier: string): string[] {
  const url = new URL(specifier, from).href;
  if (/\.d\.[cm]?ts$/.test(url)) {
    return [url];
  }

  const js = url.match(/^(.*)\.([cm]?)js$/);
  if (js) {
    return [`${js[1]}.d.${js[2]}ts`];
  }

  return [`${url}.d.ts`, `${url}/index.d.ts`];
}
