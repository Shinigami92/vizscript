import type { GraphDocument, GraphOp, LanguageVersion } from '@vizscript/core';
import type { ComputedRef, Ref, ShallowRef } from 'vue';
import { computed, ref } from 'vue';
import { ecosystemOf } from '../../graph/add-package';
import type { ModuleInfo } from '../../graph/module-info';
import { typeRegistryAvailable } from '../../graph/type-registry';
import type { ScriptWorkspaceProps } from './types';
import type { FileEdit } from './use-layout-history';
import { useModuleInfo } from './use-module-info';

export interface LibraryAdditions {
  /** Versions and dependency kinds of the imported modules (My Script). */
  moduleInfos: ShallowRef<ReadonlyMap<string, ModuleInfo>>;
  /** "+" in Imports: where its menu opens, while it is open. */
  addingPackage: Ref<{ x: number; y: number; library?: string } | null>;
  /** A package manager, a way to change the manifest, and the server. */
  canAddPackage: ComputedRef<boolean>;
  /**
   * Adds a library: `edit` changes its manifest, `op` writes its import;
   * one undo step for both.
   */
  addLibrary: (
    manifest: string,
    edit: (text: string) => string,
    op?: GraphOp
  ) => Promise<boolean>;
  /** Undo and redo of a manifest change (`false`: it changed since). */
  restoreOtherFile: (
    path: string,
    from: string,
    to: string
  ) => Promise<boolean>;
}

/**
 * The libraries of My Script's Imports: their versions and kinds, and
 * adding one ("+", or an import's "not listed" warning).
 */
export function useLibraryAdditions(deps: {
  props: Readonly<ScriptWorkspaceProps>;
  doc: ShallowRef<GraphDocument | null>;
  version: Ref<LanguageVersion | null>;
  /** Writes an op into the code; resolves once it is written. */
  apply: (op: GraphOp) => Promise<void>;
  /** The code's version in the undo history. */
  codeVersion: () => number;
  recordFileEdit: (edit: FileEdit, beforeVersion: number) => void;
}): LibraryAdditions {
  const { props } = deps;
  const { infos, refresh } = useModuleInfo(deps);
  const addingPackage = ref<{ x: number; y: number; library?: string } | null>(
    null
  );
  const registryReady = ref(false);
  void (async (): Promise<void> => {
    registryReady.value = await typeRegistryAvailable();
  })();
  const canAddPackage = computed(
    () =>
      registryReady.value &&
      props.editFile !== undefined &&
      ecosystemOf(props.path) !== undefined
  );

  async function addLibrary(
    manifest: string,
    edit: (text: string) => string,
    op?: GraphOp
  ): Promise<boolean> {
    const beforeVersion = deps.codeVersion();
    let before = '';
    let after = '';
    await props.editFile?.(manifest, (text) => {
      before = text;
      after = edit(text);
      return after;
    });
    refresh();
    if (op) {
      // The editor reports its new version before the op resolves.
      await deps.apply(op);
    }

    if (before === after) {
      return false;
    }

    deps.recordFileEdit({ path: manifest, before, after }, beforeVersion);
    return true;
  }

  async function restoreOtherFile(
    path: string,
    from: string,
    to: string
  ): Promise<boolean> {
    let restored = false;
    await props.editFile?.(path, (text) => {
      restored = text === from;
      return restored ? to : text;
    });
    refresh();
    return restored;
  }

  return {
    moduleInfos: infos,
    addingPackage,
    canAddPackage,
    addLibrary,
    restoreOtherFile,
  };
}
