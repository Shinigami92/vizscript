import type {
  GraphDocument,
  ImportedDeclaration,
  ModuleReference,
  ScriptSymbol,
} from '@vizscript/core';
import {
  defaultExport,
  exportedSymbols,
  resolveModuleReference,
} from '@vizscript/core';
import type { ComputedRef, Ref, ShallowRef } from 'vue';
import { computed, shallowRef } from 'vue';
import type { GraphClient } from '../../graph/graph-client';
import { languageOf } from '../../graph/languages';
import {
  nearestPackageRange,
  NpmTypes,
  packageName,
} from '../../graph/npm-types';
import type { ExternalName } from '../../graph/project-index';
import {
  candidateFiles,
  externalNames,
  godotRoot,
  libraryNames,
} from '../../graph/project-index';
import type { FileLinkSource } from '../../monaco/file-links';
import type { ResolveReference } from './symbol-lookup';
import type { ScriptWorkspaceProps } from './types';

/** Files read for the index: nearest folders first. */
const INDEX_LIMIT = 150;

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
  /** Declarations of the imported names, sent along with every parse. */
  declarations: () => ImportedDeclaration[];
}

/**
 * Imports of the file: links to repository files, the declarations of
 * imported names (repository files, Python stubs, npm types) and the
 * names of other files and libraries the action menu offers.
 */
export function useImports(deps: ImportDeps): WorkspaceImports {
  const { props, client, doc, text } = deps;

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

  const importedNames = computed(() => [
    ...new Set(
      references.value
        .filter((r) => r.symbol && !r.typeOnly)
        .map((r) => text.value.slice(r.range.start, r.range.end))
        .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name))
    ),
  ]);

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

  function exportsOf(path: string): Promise<ScriptSymbol[]> {
    let exports = exportsByPath.get(path);
    if (!exports) {
      const read = props.readFile;
      exports = read
        ? read(path)
            .then(async (source) =>
              exportedSymbols(await client.parse(source, path), source)
            )
            .catch(() => [])
        : Promise.resolve([]);
      exportsByPath.set(path, exports);
    }

    return exports;
  }

  // ----------------------------------------------------- project index

  /** Exports of the repository's files of this language (action menu). */
  const projectExports = shallowRef<ReadonlyMap<string, ScriptSymbol[]>>(
    new Map()
  );
  let indexing = false;

  /**
   * Reads the exports of other files the first time the action menu opens,
   * so it can offer their functions (using one adds the import).
   */
  async function indexProject(): Promise<void> {
    const files = props.files;
    if (indexing || !files || !props.readFile) {
      return;
    }

    indexing = true;
    const queue = candidateFiles(files, props.path, INDEX_LIMIT);
    const found = new Map<string, ScriptSymbol[]>();
    const worker = async (): Promise<void> => {
      for (let path = queue.shift(); path; path = queue.shift()) {
        const exports = await exportsOf(path);
        if (exports.length > 0) {
          found.set(path, exports);
          projectExports.value = new Map(found);
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  }

  /** Functions and values of libraries for the action menu. */
  const libraryExternals = shallowRef<ExternalName[]>([]);
  let librariesIndexed = false;

  /**
   * Python: the standard-library modules the backend knows. TypeScript: the
   * packages this file imports from (their other exports).
   */
  async function indexLibraries(): Promise<void> {
    if (librariesIndexed) {
      return;
    }

    librariesIndexed = true;
    const language = languageOf(props.path);
    const modules =
      language === 'python'
        ? (await client.library(props.path)).modules
        : (doc.value?.symbols ?? [])
            .filter(
              (s) =>
                s.kind === 'import' &&
                s.module !== undefined &&
                packageName(s.module) === s.module
            )
            .map((s) => s.module ?? '');
    const found: ExternalName[] = [];
    for (const module of new Set(modules)) {
      found.push(
        ...libraryNames(
          module,
          await libraryExports(module),
          language === 'python' ? 'module' : 'named',
          props.path
        )
      );
      libraryExternals.value = [...found];
    }
  }

  function onActionMenu(): void {
    void indexProject();
    void indexLibraries();
  }

  const externals = computed(() => {
    const taken = new Set(
      (doc.value?.symbols ?? [])
        .filter((s) => s.scope === '')
        .map((s) => s.name)
    );
    return [
      ...(props.files
        ? externalNames(
            projectExports.value,
            doc.value,
            props.path,
            godotRoot(props.files, props.path)
          )
        : []),
      // Library names the file declares itself are left out; its imports of
      // a whole module (`import math`) are fine.
      ...libraryExternals.value.filter(
        (e) =>
          !taken.has(e.name) ||
          doc.value?.symbols?.some(
            (s) =>
              s.kind === 'import' &&
              s.name === e.name &&
              s.imported === '*' &&
              e.request.imported === '*'
          )
      ),
    ];
  });

  /** Declarations of the imported names, sent along with every parse. */
  let importDeclarations: ImportedDeclaration[] = [];

  // --------------------------------------------------------- libraries

  const npm = new NpmTypes((source, fileName) =>
    client.parse(source, fileName)
  );
  const libraryCache = new Map<string, Promise<ScriptSymbol[]>>();

  function packageRange(name: string): Promise<string> {
    return nearestPackageRange(props.files, props.readFile, props.path, name);
  }

  /**
   * Exports of a library module: Python's standard library (stubs of the
   * backend), npm packages (`.d.ts` files from jsDelivr).
   */
  function libraryExports(module: string): Promise<ScriptSymbol[]> {
    let exports = libraryCache.get(module);
    if (!exports) {
      exports = (async (): Promise<ScriptSymbol[]> => {
        const language = languageOf(props.path);
        if (language === 'python' && !module.startsWith('.')) {
          const { stub } = await client.library(props.path, module);
          return stub
            ? exportedSymbols(
                await client.parse(stub.text, stub.fileName),
                stub.text
              )
            : [];
        }

        const name = packageName(module);
        if (language === 'typescript' && name === module) {
          const range = await packageRange(name);
          return range === '' ? [] : npm.exportsOf(name, range);
        }

        return [];
      })().catch(() => []);
      libraryCache.set(module, exports);
    }

    return exports;
  }

  async function declarationOf(
    symbol: ScriptSymbol
  ): Promise<ImportedDeclaration | undefined> {
    // A file of the repository, else a library.
    const target = importTarget(symbol);
    let exports: ScriptSymbol[];
    let named: string | undefined;
    if (target) {
      exports = await exportsOf(target.path);
      named = target.symbol;
    } else if (symbol.module) {
      exports = await libraryExports(symbol.module);
      named =
        symbol.imported === '*' || symbol.imported === 'default'
          ? undefined
          : symbol.imported;
    } else {
      return undefined;
    }

    if (exports.length === 0) {
      return undefined;
    }

    if (symbol.imported === 'default') {
      const declaration = defaultExport(exports);
      return declaration ? { name: symbol.name, declaration } : undefined;
    }

    if (named) {
      const declaration = exports.find((s) => s.name === named);
      return declaration ? { name: symbol.name, declaration } : undefined;
    }

    // A whole module: `ns.fn()`, `module.fn()`, `Script.new()`.
    return { name: symbol.name, members: exports };
  }

  async function updateImports(seq: number): Promise<void> {
    const imports = (doc.value?.symbols ?? []).filter(
      (s) => s.kind === 'import'
    );
    if (imports.length === 0 && importDeclarations.length === 0) {
      return;
    }

    const found = await Promise.all(imports.map((s) => declarationOf(s)));
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
    externals,
    declarations: () => importDeclarations,
  };
}
