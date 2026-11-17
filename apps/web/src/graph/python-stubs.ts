import type { GraphDocument, ScriptSymbol } from '@vizscript/core';
import { exportedSymbols } from '@vizscript/core';
import { fetchText } from './npm-types';

/**
 * typeshed (`python/typeshed`), the stubs mypy and pyright read, through
 * jsDelivr's GitHub proxy (the host of the npm types), at a fixed commit:
 * its file listing and its files then always agree.
 */
export const TYPESHED_COMMIT = 'f0512c2d5d5d319570d2517d74419633c0174ec2';
export const TYPESHED = `https://cdn.jsdelivr.net/gh/python/typeshed@${TYPESHED_COMMIT}/`;
const LISTING = `https://data.jsdelivr.com/v1/packages/gh/python/typeshed@${TYPESHED_COMMIT}?structure=flat`;

/** How deep re-exports are followed (`from .api import get as get`). */
const MAX_DEPTH = 4;

/** Where a module's stub can be in a folder (`os.path`). */
function modulePaths(root: string, module: string): string[] {
  const path = module.replaceAll('.', '/');
  return [`${root}${path}.pyi`, `${root}${path}/__init__.pyi`];
}

/**
 * Files that may hold the stub of `module`: the standard library, then
 * the stubs of other distributions (`stubs/PyYAML/yaml/__init__.pyi`).
 * Without a listing only the standard library is tried.
 */
export function typeshedPaths(
  module: string,
  files: ReadonlySet<string> | undefined
): string[] {
  const stdlib = modulePaths('stdlib/', module);
  if (!files) {
    return stdlib;
  }

  const found = stdlib.filter((path) => files.has(path));
  if (found.length > 0) {
    return found;
  }

  const suffixes = modulePaths('', module).map((path) => `/${path}`);
  return [...files].filter(
    (path) =>
      path.startsWith('stubs/') &&
      suffixes.some(
        (suffix) =>
          path.endsWith(suffix) &&
          // `stubs/<distribution>/<module path>`, nothing in between.
          path.split('/').length === suffix.split('/').length + 1
      )
  );
}

/** The module a relative import of the stub at `path` names (`.api`). */
export function relativeModule(path: string, module: string): string {
  const dots = module.match(/^\.+/)?.[0].length ?? 0;
  const dirs = path.split('/').slice(0, -1);
  const base = dirs.slice(0, dirs.length - (dots - 1));
  const rest = module.slice(dots);
  return [...base, ...(rest ? rest.split('.') : [])].join('/');
}

/** The Python version stubs are read for: `≥3.11` → `3.11`. */
export function stubVersion(text: string | undefined): string | undefined {
  return text?.match(/\d+\.\d+/)?.[0];
}

/** What one stub file declares and imports from its package. */
interface StubFile {
  own: ScriptSymbol[];
  /** Relative imports that re-export (`get as get`, `*`). */
  imports: Array<{ module: string; imported: string }>;
}

/** The relative imports of a parsed stub that re-export names. */
function reexports(doc: GraphDocument, text: string): StubFile['imports'] {
  return [
    ...(doc.symbols ?? []).flatMap((symbol) =>
      symbol.kind === 'import' &&
      symbol.scope === '' &&
      symbol.module?.startsWith('.') &&
      symbol.imported === symbol.name &&
      // `from . import resolver`: a module of the package, not a name.
      !/^\.+$/.test(symbol.module)
        ? [{ module: symbol.module, imported: symbol.name }]
        : []
    ),
    // Star imports have no symbol of their own.
    ...[...text.matchAll(/^from\s+(\.[\w.]*)\s+import\s+\*/gm)].map(
      (match) => ({ module: match[1] ?? '.', imported: '*' })
    ),
  ];
}

/**
 * Exports of Python modules from typeshed: the stub of a module, prepared
 * by the backend for the project's Python version, with what it
 * re-exports from its other files. The files a module reaches are read
 * side by side first; re-exports are then resolved in memory, as stubs
 * import each other in cycles (`from .a import *` in `b`, and back).
 */
export class TypeshedStubs {
  private files: Promise<ReadonlySet<string> | undefined> | undefined;
  private readonly stubs = new Map<string, Promise<StubFile | undefined>>();

  public constructor(
    /** Makes a stub ready for the parser. */
    private readonly prepare: (text: string) => Promise<string>,
    /** Parses a prepared stub like a Python file. */
    private readonly parse: (
      text: string,
      fileName: string
    ) => Promise<GraphDocument>
  ) {}

  /** Exports of `module`; none when typeshed has no stub of it. */
  public async exportsOf(module: string): Promise<ScriptSymbol[]> {
    const files = await this.listing();
    for (const path of typeshedPaths(module, files)) {
      const loaded = await this.loadAll(path, files);
      if (loaded.has(path)) {
        return resolve(path, loaded, files, []);
      }
    }

    return [];
  }

  /** All files of typeshed (`stdlib/json/__init__.pyi`), if listed. */
  private listing(): Promise<ReadonlySet<string> | undefined> {
    this.files ??= fetchText(LISTING)
      .then((text) => {
        if (text === undefined) {
          return undefined;
        }

        const json = JSON.parse(text) as { files?: Array<{ name: string }> };
        return new Set(
          (json.files ?? []).map((file) => file.name.replace(/^\//, ''))
        );
      })
      .catch(() => undefined);
    return this.files;
  }

  /** The stub at `path` and the files it re-exports from, read in waves. */
  private async loadAll(
    path: string,
    files: ReadonlySet<string> | undefined
  ): Promise<Map<string, StubFile>> {
    const loaded = new Map<string, StubFile>();
    let wave = [path];
    for (let depth = 0; depth <= MAX_DEPTH && wave.length > 0; depth++) {
      const read = await Promise.all(wave.map((p) => this.load(p)));
      const next = new Set<string>();
      for (const [i, stub] of read.entries()) {
        const at = wave[i] ?? '';
        if (!stub) {
          continue;
        }

        loaded.set(at, stub);
        for (const { module } of stub.imports) {
          for (const file of candidates(at, module, files)) {
            if (!loaded.has(file)) {
              next.add(file);
            }
          }
        }
      }

      wave = [...next];
    }

    return loaded;
  }

  /** One stub file; `undefined` when it can't be read. */
  private load(path: string): Promise<StubFile | undefined> {
    let stub = this.stubs.get(path);
    if (!stub) {
      stub = this.read(path).catch(() => undefined);
      this.stubs.set(path, stub);
    }

    return stub;
  }

  private async read(path: string): Promise<StubFile | undefined> {
    const raw = await fetchText(`${TYPESHED}${path}`);
    if (raw === undefined) {
      return undefined;
    }

    const text = await this.prepare(raw);
    // Parsed as Python (`.pyi` files aren't opened like code).
    const doc = await this.parse(
      text,
      `typeshed/${path.replace(/\.pyi$/, '.py')}`
    );
    return { own: exportedSymbols(doc, text), imports: reexports(doc, text) };
  }
}

/** Files a relative import of the stub at `path` may name. */
function candidates(
  path: string,
  module: string,
  files: ReadonlySet<string> | undefined
): string[] {
  const target = relativeModule(path, module);
  return [`${target}.pyi`, `${target}/__init__.pyi`].filter(
    (file) => file !== path && (!files || files.has(file))
  );
}

/** Exports of a loaded stub with its re-exports; `chain` breaks cycles. */
function resolve(
  path: string,
  loaded: ReadonlyMap<string, StubFile>,
  files: ReadonlySet<string> | undefined,
  chain: ReadonlyArray<string>
): ScriptSymbol[] {
  const stub = loaded.get(path);
  if (!stub) {
    return [];
  }

  const result = [...stub.own];
  const names = new Set(result.map((s) => s.name));
  for (const { module, imported } of stub.imports) {
    const file = candidates(path, module, files).find(
      (f) => loaded.has(f) && !chain.includes(f)
    );
    const from = file ? resolve(file, loaded, files, [...chain, path]) : [];
    for (const s of from) {
      if ((imported === '*' || s.name === imported) && !names.has(s.name)) {
        names.add(s.name);
        result.push(s);
      }
    }
  }

  return result;
}
