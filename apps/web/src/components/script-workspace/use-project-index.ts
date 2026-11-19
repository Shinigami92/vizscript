import type {
  GraphDocument,
  GraphOp,
  ImportRequest,
  ScriptSymbol,
} from '@vizscript/core';
import type { ComputedRef, ShallowRef } from 'vue';
import { computed, shallowRef } from 'vue';
import { trackTask } from '../../composables/use-background-tasks';
import type { GraphClient } from '../../graph/graph-client';
import { languageOf } from '../../graph/languages';
import {
  referencedNames,
  withImports,
  writtenCode,
} from '../../graph/needed-imports';
import { packageName } from '../../graph/npm-types';
import type { ExternalName, ExternalType } from '../../graph/project-index';
import {
  candidateFiles,
  externalNames,
  externalTypes,
  godotRoot,
  libraryNames,
  libraryTypes,
  topLevel,
} from '../../graph/project-index';
import type { ScriptWorkspaceProps } from './types';

/** Files read for the index: nearest folders first. */
const INDEX_LIMIT = 150;

export interface ProjectIndex {
  /** Reads the project's and libraries' names (once, when first needed). */
  onActionMenu: () => void;
  /** Names of other files and libraries for the action menu. */
  externals: ComputedRef<ExternalName[]>;
  /** Types of other files and libraries for the type picker. */
  externalTypes: ComputedRef<ExternalType[]>;
  /** The op with the imports the names it writes need. */
  withNeededImport: (op: GraphOp) => Promise<GraphOp>;
}

/**
 * What other files of the package and the libraries the file imports from
 * offer (read on demand): names for the action menu, types for the type
 * picker, and the imports code using them needs.
 */
export function useProjectIndex(deps: {
  props: Readonly<ScriptWorkspaceProps>;
  doc: ShallowRef<GraphDocument | null>;
  client: GraphClient;
  exportsOf: (path: string) => Promise<ScriptSymbol[]>;
  libraryExports: (module: string) => Promise<ScriptSymbol[]>;
}): ProjectIndex {
  const { props, doc, client, exportsOf, libraryExports } = deps;

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
        const exports = topLevel(await exportsOf(path));
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
  /** Types of the libraries the file imports from (type picker). */
  const libraryTypeNames = shallowRef<ExternalType[]>([]);
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
    const types: ExternalType[] = [];
    for (const module of new Set(modules)) {
      const exports = topLevel(await libraryExports(module));
      found.push(
        ...libraryNames(
          module,
          exports,
          language === 'python' ? 'module' : 'named',
          props.path
        )
      );
      libraryExternals.value = [...found];
      // Python's standard library is too much to list.
      if (language !== 'python') {
        types.push(...libraryTypes(module, exports, props.path));
        libraryTypeNames.value = [...types];
      }
    }
  }

  function onActionMenu(): void {
    void trackTask('Indexing project files', indexProject());
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

  const projectTypes = computed(() => {
    const taken = new Set(
      (doc.value?.symbols ?? [])
        .filter((s) => s.scope === '')
        .map((s) => s.name)
    );
    const own = props.files
      ? externalTypes(
          projectExports.value,
          doc.value,
          props.path,
          godotRoot(props.files, props.path)
        )
      : [];
    // A library the file imports from first: a repository package's type
    // comes by its name (`@acme/api`), not by a path into the package.
    const libraries = libraryTypeNames.value.filter((t) => !taken.has(t.name));
    const named = new Set(libraries.map((t) => t.name));
    return [...libraries, ...own.filter((t) => !named.has(t.name))];
  });

  /**
   * The import `name` needs, when the file neither declares nor imports
   * it: from a library the file imports from (joined into that import;
   * their exports are known from linking the imports), else from another
   * file the action menu has indexed already.
   */
  async function importFor(
    name: string,
    asType: boolean
  ): Promise<ImportRequest | undefined> {
    const typeOnly = asType && languageOf(props.path) === 'typescript';
    const symbols = doc.value?.symbols ?? [];
    if (symbols.some((s) => s.scope === '' && s.name === name)) {
      return undefined;
    }

    const modules = new Set(
      symbols.flatMap((s) =>
        s.kind === 'import' &&
        s.module !== undefined &&
        packageName(s.module) === s.module
          ? [s.module]
          : []
      )
    );
    for (const module of modules) {
      const exported = topLevel(await libraryExports(module)).some(
        (s) => s.name === name
      );
      if (exported) {
        return {
          path: '',
          from: props.path,
          name,
          imported: name,
          module,
          ...(typeOnly ? { typeOnly } : {}),
        };
      }
    }

    const value = externals.value.find(
      (e) => e.name === name && e.request.imported !== '*'
    )?.request;
    if (value) {
      return typeOnly ? { ...value, typeOnly } : value;
    }

    const type = projectTypes.value.find((t) => t.name === name)?.request;
    if (!type) {
      return undefined;
    }

    // A type used as a value (a class in a decorator) is a value import.
    const { typeOnly: _, ...plain } = type;
    return typeOnly ? type : plain;
  }

  async function withNeededImport(op: GraphOp): Promise<GraphOp> {
    const requests: ImportRequest[] = [];
    for (const code of writtenCode(op)) {
      for (const name of referencedNames(code.text)) {
        if (requests.some((r) => r.name === name)) {
          continue;
        }

        const request = await importFor(name, code.asType);
        if (request) {
          requests.push(request);
        }
      }
    }

    return withImports(op, requests);
  }

  return {
    onActionMenu,
    externals,
    externalTypes: projectTypes,
    withNeededImport,
  };
}
