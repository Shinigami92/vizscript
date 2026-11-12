import type { GraphDocument, ScriptSymbol } from '@vizscript/core';
import { exportedSymbols, withReexports } from '@vizscript/core';

/**
 * Declarations of npm packages, read from their `.d.ts` files on jsDelivr
 * (the repository has no `node_modules`). Re-exports are followed, also
 * into other packages (`vue` → `@vue/runtime-dom` → … → `@vue/reactivity`).
 */
const CDN = 'https://cdn.jsdelivr.net/npm/';

/** Files read during one session, by URL (shared by all workspaces). */
const texts = new Map<string, Promise<string | undefined>>();

function fetchText(url: string): Promise<string | undefined> {
  let text = texts.get(url);
  if (!text) {
    text = fetch(url)
      .then((response) => (response.ok ? response.text() : undefined))
      .catch(() => undefined);
    texts.set(url, text);
  }

  return text;
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
}

function typesOfExports(exports: unknown): string | undefined {
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
function typesPackage(name: string): string {
  return `@types/${name.replace(/^@/, '').replace('/', '__')}`;
}

export class NpmTypes {
  private readonly manifests = new Map<string, Promise<Manifest | undefined>>();
  private readonly files = new Map<string, Promise<ScriptSymbol[]>>();

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
      ).then((text) => {
        if (!text) {
          return undefined;
        }

        try {
          const json = JSON.parse(text) as Record<string, unknown>;
          const version =
            typeof json.version === 'string' ? json.version : range;
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
          };
        } catch {
          return undefined;
        }
      });
      this.manifests.set(key, manifest);
    }

    return manifest;
  }

  /** Exports of a package (`range` as in `package.json`, or `latest`). */
  public async exportsOf(
    name: string,
    range = 'latest'
  ): Promise<ScriptSymbol[]> {
    const manifest = await this.manifest(name, range);
    if (manifest?.types) {
      return this.fileExports(manifest.base + manifest.types, manifest, 0);
    }

    // No types of its own: DefinitelyTyped.
    if (!name.startsWith('@types/')) {
      const types = await this.manifest(typesPackage(name), 'latest');
      if (types) {
        return this.fileExports(
          types.base + (types.types ?? 'index.d.ts'),
          types,
          0
        );
      }
    }

    return [];
  }

  private fileExports(
    url: string,
    manifest: Manifest,
    depth: number
  ): Promise<ScriptSymbol[]> {
    let exports = this.files.get(url);
    if (!exports) {
      // Cycles end here: a file being read has no exports yet.
      this.files.set(url, Promise.resolve([]));
      exports = this.readFile(url, manifest, depth);
      this.files.set(url, exports);
    }

    return exports;
  }

  private async readFile(
    url: string,
    manifest: Manifest,
    depth: number
  ): Promise<ScriptSymbol[]> {
    if (depth > 8) {
      return [];
    }

    const text = await fetchText(url);
    if (text === undefined) {
      return [];
    }

    const doc = await this.parse(text, 'types.d.ts');
    return withReexports(
      exportedSymbols(doc, text),
      doc.reexports ?? [],
      async (specifier) => {
        const name = packageName(specifier);
        if (name) {
          return this.exportsOf(name, manifest.dependencies[name] ?? 'latest');
        }

        for (const candidate of declarationFiles(url, specifier)) {
          if ((await fetchText(candidate)) !== undefined) {
            return this.fileExports(candidate, manifest, depth + 1);
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
