import type { ModuleReference } from '@vizscript/core';
import { resolveModuleReference } from '@vizscript/core';
import type { Ref, ShallowRef } from 'vue';
import { onBeforeUnmount, watch } from 'vue';
import type { GraphClient } from '../../graph/graph-client';
import { languageOf } from '../../graph/languages';
import {
  declarationSpecifiers,
  npmDeclarations,
} from '../../graph/npm-declarations';
import { nearestPackageRange, packageName } from '../../graph/npm-types';
import { clearProjectLibs, setProjectLibs } from '../../monaco/project-libs';
import type { ScriptWorkspaceProps } from './types';

/** Repository files read for the checker, at most (nearest imports first). */
const FILE_LIMIT = 60;

/** Imports followed from the open file (its imports' imports …). */
const DEPTH = 3;

/** npm packages a source imports (`commander`, `@scope/pkg`). */
function packagesOf(text: string): string[] {
  return declarationSpecifiers(text).modules.flatMap((specifier) => {
    const name = packageName(specifier);
    return name ? [name] : [];
  });
}

interface TypeLibDeps {
  props: Readonly<ScriptWorkspaceProps>;
  client: GraphClient;
  /** File references of the open file (updated after each parse). */
  references: ShallowRef<ModuleReference[]>;
  /** Text of the open file. */
  text: Ref<string>;
}

/**
 * Gives TypeScript's checker (Monaco's worker) what the open file imports:
 * the repository files it imports (and theirs, a few levels deep) and the
 * declarations of the npm packages they use. Problems then see real types
 * instead of unresolved modules, and later the pins can too.
 */
export function useTypeLibs(deps: TypeLibDeps): void {
  const { props, client } = deps;
  const owner = Symbol('workspace');
  /** Texts and references of repository files, read once per workspace. */
  const texts = new Map<string, Promise<string | undefined>>();
  const refs = new Map<string, Promise<ModuleReference[]>>();
  let seq = 0;

  function readText(path: string): Promise<string | undefined> {
    let text = texts.get(path);
    if (!text) {
      const read = props.readFile;
      text = read
        ? read(path).catch(() => undefined)
        : Promise.resolve(undefined);
      texts.set(path, text);
    }

    return text;
  }

  function referencesOf(path: string): Promise<ModuleReference[]> {
    let found = refs.get(path);
    if (!found) {
      found = readText(path).then((text) =>
        text === undefined ? [] : client.references(text, path)
      );
      refs.set(path, found);
    }

    return found;
  }

  /** Repository files of this language that `references` of `from` name. */
  function targets(
    from: string,
    references: ReadonlyArray<ModuleReference>
  ): string[] {
    const files = props.files;
    if (!files) {
      return [];
    }

    return references.flatMap((reference) => {
      const path = reference.symbol
        ? null
        : resolveModuleReference(from, reference, (p) => files.has(p));
      return path && languageOf(path) === 'typescript' ? [path] : [];
    });
  }

  async function update(): Promise<void> {
    const current = ++seq;
    const path = props.path;
    if (languageOf(path) !== 'typescript') {
      setProjectLibs(owner, new Map());
      return;
    }

    const files = new Map<string, string>();
    const packages = new Set(packagesOf(deps.text.value));
    const seen = new Set([path]);
    let level = [{ from: path, references: deps.references.value }];
    for (let depth = 0; depth < DEPTH && level.length > 0; depth++) {
      const next: string[] = [];
      for (const { from, references } of level) {
        for (const target of targets(from, references)) {
          if (!seen.has(target) && seen.size <= FILE_LIMIT) {
            seen.add(target);
            next.push(target);
          }
        }
      }

      const read = await Promise.all(
        next.map(async (target) => ({
          from: target,
          text: await readText(target),
          references: await referencesOf(target),
        }))
      );
      level = [];
      for (const entry of read) {
        if (entry.text !== undefined) {
          files.set(entry.from, entry.text);
          level.push(entry);
          for (const name of packagesOf(entry.text)) {
            packages.add(name);
          }
        }
      }
    }

    const roots = await Promise.all(
      [...packages].map(
        async (name) =>
          [
            name,
            await nearestPackageRange(props.files, props.readFile, path, name),
          ] as const
      )
    );
    const declarations = await npmDeclarations(
      roots.filter(([, range]) => range !== '')
    );
    if (current !== seq) {
      return;
    }

    for (const file of declarations) {
      files.set(file.path, file.text);
    }

    setProjectLibs(owner, files);
  }

  /** The same imports as last time: nothing to read again. */
  let lastKey = '';
  watch(
    () => deps.references.value,
    (references) => {
      const key = [
        props.path,
        ...references.filter((r) => !r.symbol).map((r) => r.specifier),
        ...packagesOf(deps.text.value),
      ].join('\n');
      if (key !== lastKey) {
        lastKey = key;
        void update();
      }
    },
    { immediate: true }
  );

  onBeforeUnmount(() => {
    seq++;
    clearProjectLibs(owner);
  });
}
