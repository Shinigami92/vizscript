import type { GraphDocument, LanguageVersion } from '@vizscript/core';
import type { Ref, ShallowRef } from 'vue';
import { shallowRef, watch } from 'vue';
import { languageOf } from '../../graph/languages';
import type { ModuleInfo } from '../../graph/module-info';
import { moduleInfo } from '../../graph/module-info';
import { packageVersion } from '../../graph/npm-project';
import { projectDependencies } from '../../graph/project-dependencies';
import { pythonStdlibModules } from '../../graph/python-stubs';
import type { ScriptWorkspaceProps } from './types';

const RUNTIMES: Readonly<Record<string, string>> = {
  typescript: 'Node.js',
  python: 'Python',
  rust: "Rust's standard library",
};

/**
 * The library, version and dependency kind of each module the open file
 * imports (My Script's Imports), from the project's manifests and
 * lockfiles; read again when the imports or the project files change.
 */
export function useModuleInfo(deps: {
  props: Readonly<ScriptWorkspaceProps>;
  doc: ShallowRef<GraphDocument | null>;
  version: Ref<LanguageVersion | null>;
}): ShallowRef<ReadonlyMap<string, ModuleInfo>> {
  const { props } = deps;
  const infos = shallowRef<ReadonlyMap<string, ModuleInfo>>(new Map());
  let seq = 0;

  async function update(modules: ReadonlyArray<string>): Promise<void> {
    const current = ++seq;
    const path = props.path;
    const language = languageOf(path);
    if (!language || modules.length === 0) {
      infos.value = new Map();
      return;
    }

    const [dependencies, stdlib, nodeTypes] = await Promise.all([
      projectDependencies(props.files, props.readFile, path),
      language === 'python' ? pythonStdlibModules() : undefined,
      language === 'typescript'
        ? packageVersion(props.files, props.readFile, path, '@types/node')
        : undefined,
    ]);
    if (current !== seq) {
      return;
    }

    const version = deps.version.value?.text;
    const runtime =
      language === 'typescript'
        ? `Node.js${nodeTypes && nodeTypes !== 'latest' ? ` (types: @types/node ${nodeTypes})` : ''}`
        : language === 'python' && version
          ? `Python ${version}`
          : (RUNTIMES[language] ?? language);
    const result = new Map<string, ModuleInfo>();
    for (const module of modules) {
      const info = moduleInfo(module, language, {
        dependencies,
        runtime,
        ...(stdlib ? { pythonStdlib: stdlib } : {}),
      });
      if (info) {
        result.set(module, info);
      }
    }

    infos.value = result;
  }

  watch(
    () =>
      [
        [
          ...new Set(
            (deps.doc.value?.symbols ?? [])
              .filter((s) => s.kind === 'import' && s.module)
              .map((s) => s.module ?? '')
          ),
        ].join('\n'),
        props.path,
        props.files,
        deps.version.value?.text,
      ] as const,
    ([modules]) => void update(modules ? modules.split('\n') : []),
    { immediate: true }
  );

  return infos;
}
