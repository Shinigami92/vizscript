import type {
  GraphDocument,
  GraphOp,
  ImportedDeclaration,
  ModuleReference,
  ScriptSymbol,
} from '@vizscript/core';
import {
  defaultExport,
  exportedSymbols,
  exportedTypeMembers,
  resolveModuleReference,
  withReexports,
} from '@vizscript/core';
import type { ComputedRef, Ref, ShallowRef } from 'vue';
import { computed, shallowRef } from 'vue';
import { trackTask, useBusy } from '../../composables/use-background-tasks';
import { localLibraries, rustDependencies } from '../../graph/cargo-project';
import {
  crateModule,
  crateStubs,
  moduleFiles,
  usePath,
} from '../../graph/crate-types';
import type { GraphClient } from '../../graph/graph-client';
import { languageOf } from '../../graph/languages';
import { pythonDistribution } from '../../graph/module-info';
import { packageVersion } from '../../graph/npm-project';
import { NpmTypes, packageName } from '../../graph/npm-types';
import type { ExternalName, ExternalType } from '../../graph/project-index';
import { topLevel } from '../../graph/project-index';
import { packageTypes, pythonPackageVersion } from '../../graph/pypi-types';
import { normalizeName, pythonDependencies } from '../../graph/python-project';
import {
  packageSource,
  stubVersion,
  TypeshedStubs,
} from '../../graph/python-stubs';
import { isUncallableImport } from '../../graph/symbols';
import type { FileLinkSource } from '../../monaco/file-links';
import type { ResolveReference } from './symbol-lookup';
import type { ScriptWorkspaceProps } from './types';
import { useProjectIndex } from './use-project-index';

/**
 * A parsed file's exports and, after them, the members of its exported
 * types (scoped by the type), which an import of the type brings along.
 */
function withTypeMembers(doc: GraphDocument, text: string): ScriptSymbol[] {
  return [...exportedSymbols(doc, text), ...exportedTypeMembers(doc, text)];
}

/**
 * The export `named` of a module as the import `name`; a type brings its
 * members along (Rust's `impl` methods).
 */
function namedDeclaration(
  all: ReadonlyArray<ScriptSymbol>,
  named: string,
  name: string
): ImportedDeclaration | undefined {
  const declaration = all.find((s) => s.scope === '' && s.name === named);
  const members = all.filter((s) => s.scope !== '' && s.scope === named);
  return declaration
    ? { name, declaration, ...(members.length > 0 ? { members } : {}) }
    : undefined;
}

export interface ImportDeps {
  props: Readonly<ScriptWorkspaceProps>;
  client: GraphClient;
  doc: ShallowRef<GraphDocument | null>;
  text: Ref<string>;
  visualizable: ComputedRef<boolean>;
  /** Number of the latest parse: results of older ones are dropped. */
  parseSeq: () => number;
  reparse: () => Promise<void>;
  /** Opens another repository file, at the definition of `symbol`. */
  open: (path: string, symbol?: string) => void;
  /** The language version of the project (`3.12`, `≥3.11`), if stated. */
  version?: () => string | undefined;
}

export interface WorkspaceImports {
  resolveReference: ResolveReference;
  /** Import paths and uses of imported names that resolve to repository files. */
  fileLinks: ComputedRef<FileLinkSource | undefined>;
  /** File references of the current text, for "Go to definition". */
  references: ShallowRef<ModuleReference[]>;
  /** Imported names used in the file, offered by the graph's action menu. */
  importedNames: ComputedRef<string[]>;
  importTarget: (
    symbol: ScriptSymbol
  ) => { path: string; symbol?: string } | null | undefined;
  canOpenImport: (symbol: ScriptSymbol) => boolean;
  openImport: (id: string) => void;
  updateReferences: (seq: number) => Promise<void>;
  /** Reads the imported files; parses again when their declarations change. */
  updateImports: (seq: number) => Promise<void>;
  onActionMenu: () => void;
  /** Names of other files and libraries for the action menu. */
  externals: ComputedRef<ExternalName[]>;
  /**
   * Types of other files and of the libraries the file imports from, for
   * the type picker (read once it opens, see `onActionMenu`).
   */
  externalTypes: ComputedRef<ExternalType[]>;
  /** The imports' declarations are still being read. */
  busy: ComputedRef<boolean>;
  /** Files read so far may have changed (a newer tree): read them again. */
  forgetFiles: () => void;
  /** Declarations of the imported names, sent along with every parse. */
  declarations: () => ImportedDeclaration[];
  /**
   * The op with the imports it needs: names in a decorator or type it
   * writes (`@Header()`, `RepoSummary`) that a library this file imports
   * from or another file exports get their imports.
   */
  withNeededImport: (op: GraphOp) => Promise<GraphOp>;
  /**
   * What a library to add exports (not in the manifest yet): its module
   * as code names it (`httpx`, `serde_json`, `vue`) and its exports.
   */
  packageOffer: (
    name: string,
    version: string
  ) => Promise<{ module: string; exports: ScriptSymbol[] }>;
}

/**
 * Imports of the file: links to repository files, the declarations of
 * imported names (repository files, Python stubs, npm types) and the
 * names of other files and libraries the action menu offers.
 */
export function useImports(deps: ImportDeps): WorkspaceImports {
  const { props, client, doc, text } = deps;
  const { busy, run } = useBusy();

  function resolveReference(
    reference: ModuleReference
  ): { path: string; symbol?: string } | undefined {
    const files = props.files;
    const path = files
      ? resolveModuleReference(props.path, reference, (p) => files.has(p))
      : null;
    return path ? { path, symbol: reference.symbol } : undefined;
  }

  const fileLinks = computed<FileLinkSource | undefined>(() => {
    if (!props.files || !deps.visualizable.value) {
      return undefined;
    }

    return {
      links: async (value) => {
        const references = await client.references(value, props.path);
        return references.flatMap((reference) => {
          const target = resolveReference(reference);
          return target ? [{ range: reference.range, ...target }] : [];
        });
      },
      open: (path, symbol) => deps.open(path, symbol),
    };
  });

  const references = shallowRef<ModuleReference[]>([]);

  const importedNames = computed(() => {
    // A type alias or interface has no value to call, nor has a namespace.
    const types = new Set(
      (doc.value?.symbols ?? []).filter(isUncallableImport).map((s) => s.name)
    );
    return [
      ...new Set(
        references.value
          .filter((r) => r.symbol && !r.typeOnly)
          .map((r) => text.value.slice(r.range.start, r.range.end))
          .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name) && !types.has(name))
      ),
    ];
  });

  /**
   * The file an import comes from and the name to open there; `null` when it
   * is not a repository file, `undefined` without a repository (playground).
   */
  function importTarget(
    symbol: ScriptSymbol
  ): { path: string; symbol?: string } | null | undefined {
    if (!props.files || symbol.kind !== 'import') {
      return undefined;
    }

    const within = symbol.declarationRange ?? symbol.range;
    const paths = references.value.filter(
      (r) =>
        !r.symbol && r.range.start >= within.start && r.range.end <= within.end
    );
    // `from . import utils`: the name is a module itself.
    const submodule = paths.find((r) => r.specifier === symbol.imported);
    const reference =
      paths.find((r) => r.specifier === symbol.module) ?? submodule;
    const target = reference ? resolveReference(reference) : undefined;
    if (!target) {
      return null;
    }

    const name =
      reference === submodule ||
      symbol.imported === '*' ||
      symbol.imported === 'default'
        ? undefined
        : symbol.imported;
    return { path: target.path, ...(name ? { symbol: name } : {}) };
  }

  function canOpenImport(symbol: ScriptSymbol): boolean {
    return Boolean(importTarget(symbol));
  }

  function openImport(id: string): void {
    const symbol = doc.value?.symbols?.find((s) => s.id === id);
    const target = symbol ? importTarget(symbol) : undefined;
    if (target) {
      deps.open(target.path, target.symbol);
    }
  }

  async function updateReferences(seq: number): Promise<void> {
    const refs = await client.references(text.value, props.path);
    if (seq === deps.parseSeq()) {
      references.value = refs;
      void updateImports(seq);
    }
  }

  // ----------------------------------------------- declarations of imports

  /** What imported files export, by path (parsed once per workspace). */
  const exportsByPath = new Map<string, Promise<ScriptSymbol[]>>();

  /** A file parsed for its exports (once per workspace). */
  interface ParsedFile {
    source: string;
    doc: GraphDocument;
    exports: ScriptSymbol[];
  }

  const parsedFiles = new Map<string, Promise<ParsedFile | undefined>>();

  function parsedFile(path: string): Promise<ParsedFile | undefined> {
    let parsed = parsedFiles.get(path);
    if (!parsed) {
      const read = props.readFile;
      parsed = read
        ? read(path)
            .then(async (source) => {
              const fileDoc = await client.parse(source, path, undefined, {
                background: true,
              });
              return {
                source,
                doc: fileDoc,
                exports: withTypeMembers(fileDoc, source),
              };
            })
            .catch(() => undefined)
        : Promise.resolve(undefined);
      parsedFiles.set(path, parsed);
    }

    return parsed;
  }

  /**
   * Exports of a file of the repository; a Rust file's with what it
   * re-exports (`pub use crate::walk::WalkBuilder;`, globs), followed
   * through the files and crates they come from.
   */
  function exportsOf(path: string): Promise<ScriptSymbol[]> {
    let exports = exportsByPath.get(path);
    if (!exports) {
      exports = followed(path, new Set());
      exportsByPath.set(path, exports);
    }

    return exports;
  }

  /** `seen`: files on the way here (re-exports may run in a circle). */
  async function followed(
    path: string,
    seen: ReadonlySet<string>
  ): Promise<ScriptSymbol[]> {
    const file = await parsedFile(path);
    const reexports = file?.doc.reexports ?? [];
    if (
      !file ||
      file.doc.language !== 'rust' ||
      reexports.length === 0 ||
      seen.has(path)
    ) {
      return file?.exports ?? [];
    }

    const next = new Set([...seen, path]);
    const fileReferences = await client
      .references(file.source, path)
      .catch(() => []);
    const files = props.files;
    return withReexports(file.exports, reexports, async (module) => {
      const reference = fileReferences.find(
        (r) => !r.symbol && r.specifier === module
      );
      if (!reference) {
        // Another crate (`pub use serde_json::Value;`).
        return libraryExports(module);
      }

      const target = files
        ? resolveModuleReference(path, reference, (p) => files.has(p))
        : null;
      return target ? followed(target, next) : [];
    }).catch(() => file.exports);
  }

  const {
    onActionMenu,
    externals,
    externalTypes: projectTypes,
    withNeededImport,
  } = useProjectIndex({
    props,
    client,
    doc,
    exportsOf,
    libraryExports: (module) => libraryExports(module),
  });

  /** Declarations of the imported names, sent along with every parse. */
  let importDeclarations: ImportedDeclaration[] = [];

  // --------------------------------------------------------- libraries

  // Declarations of libraries wait for the parses the user waits for.
  const npm = new NpmTypes((source, fileName) =>
    client.parse(source, fileName, undefined, { background: true })
  );
  const libraryCache = new Map<string, Promise<ScriptSymbol[]>>();

  function packageRange(name: string): Promise<string> {
    return packageVersion(props.files, props.readFile, props.path, name);
  }

  /** Exports of a stub file, parsed like a file of the language. */
  async function stubExports(stub: {
    text: string;
    fileName: string;
  }): Promise<ScriptSymbol[]> {
    const parsed = await client.parse(stub.text, stub.fileName, undefined, {
      background: true,
    });
    return exportedSymbols(parsed, stub.text);
  }

  /** typeshed's stubs, per Python version (they differ between them). */
  const typeshed = new Map<string, TypeshedStubs>();

  function typeshedFor(version: string | undefined): TypeshedStubs {
    const key = version ?? '';
    let stubs = typeshed.get(key);
    if (!stubs) {
      stubs = new TypeshedStubs(
        (raw) => client.prepareLibrary(props.path, raw, version),
        (source, fileName) =>
          client.parse(source, fileName, undefined, { background: true })
      );
      typeshed.set(key, stubs);
    }

    return stubs;
  }

  /**
   * Exports of a Python library module: typeshed's stub (the standard
   * library and stubs of other packages, for the project's Python
   * version), with the backend's own stubs taking precedence by name
   * (simpler, and with the classes they return, like `urlopen()` →
   * `HTTPResponse`, where typeshed says `Any`).
   */
  async function pythonExports(module: string): Promise<ScriptSymbol[]> {
    const [{ stub }, packaged, read] = await Promise.all([
      client.library(props.path, module),
      packageExports(module),
      typeshedFor(stubVersion(deps.version?.()))
        .exportsOf(module)
        .catch(() => []),
    ]);
    const own = stub ? await stubExports(stub) : [];
    // PEP 561: the package's own types before typeshed's stubs of it.
    const result = [...own];
    const names = new Set(own.map((s) => s.name));
    for (const symbol of [...packaged, ...read]) {
      if (!names.has(symbol.name)) {
        names.add(symbol.name);
        result.push(symbol);
      }
    }

    return result;
  }

  /** Readers of packages' own typed files, by `name@version`. */
  const packageStubs = new Map<string, Promise<TypeshedStubs | undefined>>();

  /**
   * Exports of a module of a package the project depends on, from its own
   * typed files (its wheel on PyPI, through the server), in the locked or
   * pinned version; none for packages without types (typeshed then).
   */
  async function packageExports(module: string): Promise<ScriptSymbol[]> {
    const top = module.split('.')[0] ?? '';
    const wanted = normalizeName(pythonDistribution(top));
    const dependency = (
      await pythonDependencies(props.files, props.readFile, props.path)
    ).find((d) => normalizeName(d.name) === wanted);
    if (!dependency || dependency.local) {
      return [];
    }

    const key = `${wanted}@${pythonPackageVersion(dependency)}`;
    let stubs = packageStubs.get(key);
    if (!stubs) {
      stubs = packageTypes(wanted, pythonPackageVersion(dependency)).then(
        (found) =>
          found
            ? new TypeshedStubs(
                (raw) =>
                  client.prepareLibrary(
                    props.path,
                    raw,
                    stubVersion(deps.version?.())
                  ),
                (source, fileName) =>
                  client.parse(source, fileName, undefined, {
                    background: true,
                  }),
                packageSource(found.files)
              )
            : undefined
      );
      packageStubs.set(key, stubs);
    }

    return (await stubs)?.exportsOf(module).catch(() => []) ?? [];
  }

  /**
   * Exports of a module of a Rust crate (`nom::bytes::complete`): the
   * crate's API as Rust declarations (from docs.rs through the server), in
   * the version of `Cargo.lock`, parsed like a file. The crate is found by
   * the name the code uses (a renamed dependency's `alias`).
   */
  async function rustExports(module: string): Promise<ScriptSymbol[]> {
    const found = crateModule(module);
    if (!found) {
      return [];
    }

    // A crate of the repository: the crate's own library, as its
    // binaries and tests name it (`hsml::parser`), or a path dependency.
    const local = (
      await localLibraries(props.files, props.readFile, props.path)
    ).find((library) => library.name === found.crate);
    if (local) {
      const file = moduleFiles(local.root, found.path).find((f) =>
        props.files?.has(f)
      );
      return file ? exportsOf(file) : [];
    }

    const dependency = (
      await rustDependencies(props.files, props.readFile, props.path)
    ).find((d) => (d.alias ?? d.name).replaceAll('-', '_') === found.crate);
    if (!dependency || dependency.local) {
      return [];
    }

    const version =
      dependency.version ??
      (/^[\w.^~<>=*, -]+$/.test(dependency.range)
        ? dependency.range
        : 'latest');
    const stubs = await crateStubs(dependency.name, version);
    const declarations = stubs?.modules[found.path];
    if (!declarations) {
      return [];
    }

    const parsed = await client.parse(
      declarations,
      `${found.crate}.rs`,
      undefined,
      { background: true }
    );
    return withTypeMembers(parsed, declarations);
  }

  async function packageOffer(
    name: string,
    version: string
  ): Promise<{ module: string; exports: ScriptSymbol[] }> {
    const language = languageOf(props.path);
    if (language === 'typescript') {
      return {
        module: name,
        exports: await npm.exportsOf(name, version).catch(() => []),
      };
    }

    if (language === 'rust') {
      const module = name.replaceAll('-', '_');
      const root = (await crateStubs(name, version))?.modules[''];
      if (!root) {
        return { module, exports: [] };
      }

      const parsed = await client.parse(root, `${module}.rs`, undefined, {
        background: true,
      });
      return { module, exports: exportedSymbols(parsed, root) };
    }

    if (language === 'python') {
      const found = await packageTypes(normalizeName(name), version);
      // The package's top folder named like it (`attrs`, not its legacy
      // `attr`), else its only one (`PIL` of Pillow), else its name.
      const named = name.toLowerCase().replaceAll('-', '_');
      const folders = Object.keys(found?.files ?? {}).flatMap((path) => {
        const parts = path.split('/');
        return parts.length === 2 && parts[1]?.startsWith('__init__')
          ? [parts[0] ?? '']
          : [];
      });
      const module =
        folders.find((folder) => folder.toLowerCase() === named) ??
        folders[0] ??
        named;
      const stubs = found
        ? new TypeshedStubs(
            (raw) =>
              client.prepareLibrary(
                props.path,
                raw,
                stubVersion(deps.version?.())
              ),
            (source, fileName) =>
              client.parse(source, fileName, undefined, { background: true }),
            packageSource(found.files)
          )
        : typeshedFor(stubVersion(deps.version?.()));
      return {
        module,
        exports: await stubs.exportsOf(module).catch(() => []),
      };
    }

    return { module: name, exports: [] };
  }

  /**
   * Exports of a library module: Python's standard library (typeshed and
   * the backend's stubs), npm packages (`.d.ts` files from jsDelivr), Rust
   * crates (docs.rs through the server).
   */
  function libraryExports(module: string): Promise<ScriptSymbol[]> {
    // Stubs differ between Python versions.
    const key = `${module}@${deps.version?.() ?? ''}`;
    let exports = libraryCache.get(key);
    if (!exports) {
      exports = (async (): Promise<ScriptSymbol[]> => {
        const language = languageOf(props.path);
        if (language === 'python' && !module.startsWith('.')) {
          return pythonExports(module);
        }

        if (language === 'rust') {
          return rustExports(module);
        }

        const name = packageName(module);
        if (language === 'typescript' && name === module) {
          const range = await packageRange(name);
          return range === '' ? [] : npm.exportsOf(name, range);
        }

        return [];
      })().catch(() => []);
      libraryCache.set(key, exports);
    }

    return exports;
  }

  async function declarationOf(
    symbol: ScriptSymbol
  ): Promise<ImportedDeclaration | undefined> {
    // A file of the repository, else a library.
    const target = importTarget(symbol);
    let all: ScriptSymbol[];
    let named: string | undefined;
    if (target) {
      all = await exportsOf(target.path);
      named = target.symbol;
    } else if (symbol.module) {
      all = await libraryExports(symbol.module);
      named =
        symbol.imported === '*' || symbol.imported === 'default'
          ? undefined
          : symbol.imported;
    } else {
      return undefined;
    }

    const exports = topLevel(all);
    if (exports.length === 0) {
      return undefined;
    }

    if (symbol.imported === 'default') {
      const declaration = defaultExport(exports);
      return declaration ? { name: symbol.name, declaration } : undefined;
    }

    if (named) {
      return namedDeclaration(all, named, symbol.name);
    }

    // A whole module: `ns.fn()`, `module.fn()`, `Script.new()`.
    return { name: symbol.name, members: exports };
  }

  /**
   * An item the code names by its path without importing it, as an import
   * named by the path: of a module of the crate, a file of the repository
   * the backend found (`crate::parser::parse`, `parser::parse` after `use
   * crate::parser;`), else of a library (Rust's `serde_json::to_string`,
   * also through a `use` of its module: `overrides::OverrideBuilder`).
   */
  async function pathDeclaration(
    path: string,
    uses: ReadonlyArray<ScriptSymbol>
  ): Promise<ImportedDeclaration | undefined> {
    const end = path.lastIndexOf('::');
    const module = path.slice(0, end);
    const reference = references.value.find(
      (r) => !r.symbol && r.specifier === module
    );
    const target = reference ? resolveReference(reference) : undefined;
    if (end !== -1 && target) {
      return namedDeclaration(
        await exportsOf(target.path),
        path.slice(end + 2),
        path
      );
    }

    const full = usePath(path, uses);
    const at = full.lastIndexOf('::');
    return at === -1
      ? undefined
      : namedDeclaration(
          await libraryExports(full.slice(0, at)),
          full.slice(at + 2),
          path
        );
  }

  function updateImports(seq: number): Promise<void> {
    return trackTask('Reading imports', run(readImports(seq)));
  }

  async function readImports(seq: number): Promise<void> {
    const imports = (doc.value?.symbols ?? []).filter(
      (s) => s.kind === 'import'
    );
    const paths = doc.value?.libraryPaths ?? [];
    if (
      imports.length === 0 &&
      paths.length === 0 &&
      importDeclarations.length === 0
    ) {
      return;
    }

    const found = await Promise.all([
      ...imports.map((s) => declarationOf(s)),
      ...paths.map((path) => pathDeclaration(path, imports)),
    ]);
    if (seq !== deps.parseSeq()) {
      return;
    }

    // Plain JSON: the declarations are posted to the worker.
    const next = JSON.parse(
      JSON.stringify(found.filter((d) => d !== undefined))
    ) as ImportedDeclaration[];
    if (JSON.stringify(next) !== JSON.stringify(importDeclarations)) {
      importDeclarations = next;
      void deps.reparse();
    }
  }

  return {
    resolveReference,
    fileLinks,
    references,
    importedNames,
    importTarget,
    canOpenImport,
    openImport,
    updateReferences,
    updateImports,
    onActionMenu,
    packageOffer,
    externals,
    externalTypes: projectTypes,
    declarations: () => importDeclarations,
    withNeededImport,
    busy,
    forgetFiles: () => {
      exportsByPath.clear();
      parsedFiles.clear();
      libraryCache.clear();
    },
  };
}
