import type { GraphDocument, LanguageVersion } from '@vizscript/core';
import type { ComputedRef, Ref, ShallowRef } from 'vue';
import { computed, ref } from 'vue';
import { ecosystemOf } from '../../graph/add-package';
import type { ModuleInfo } from '../../graph/module-info';
import { typeRegistryAvailable } from '../../graph/type-registry';
import type { ScriptWorkspaceProps } from './types';
import { useModuleInfo } from './use-module-info';

export interface LibraryAdditions {
  /** Versions and dependency kinds of the imported modules (My Script). */
  moduleInfos: ShallowRef<ReadonlyMap<string, ModuleInfo>>;
  /** "+" in Imports: where its menu opens, while it is open. */
  addingPackage: Ref<{ x: number; y: number; library?: string } | null>;
  /** A package manager, a way to change the manifest, and the server. */
  canAddPackage: ComputedRef<boolean>;
  /** Changes another file; the imports' library info follows. */
  editOtherFile: (
    path: string,
    edit: (text: string) => string
  ) => Promise<void>;
}

/**
 * The libraries of My Script's Imports: their versions and kinds, and
 * adding one ("+", or an import's "not listed" warning).
 */
export function useLibraryAdditions(deps: {
  props: Readonly<ScriptWorkspaceProps>;
  doc: ShallowRef<GraphDocument | null>;
  version: Ref<LanguageVersion | null>;
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

  async function editOtherFile(
    path: string,
    edit: (text: string) => string
  ): Promise<void> {
    await props.editFile?.(path, edit);
    refresh();
  }

  return { moduleInfos: infos, addingPackage, canAddPackage, editOtherFile };
}
