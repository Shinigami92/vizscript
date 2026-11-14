import type { LanguageVersion, ProjectFile } from '@vizscript/core';
import { projectFilesAbove } from '@vizscript/core';
import type { Ref } from 'vue';
import { ref, watch } from 'vue';
import type { GraphClient } from '../../graph/graph-client';
import { languageOf } from '../../graph/languages';

interface LanguageVersionOptions {
  client: GraphClient;
  path: () => string;
  files: () => ReadonlySet<string> | undefined;
  readFile: () => ((path: string) => Promise<string>) | undefined;
}

/**
 * The language version the project states for the open file (VS Code's
 * status bar item), read from the nearest project files above it.
 */
export function useLanguageVersion(options: LanguageVersionOptions): {
  version: Ref<LanguageVersion | null>;
  /** Names of the files a version is read from (`pyproject.toml`). */
  versionFiles: Ref<ReadonlyArray<string>>;
} {
  const version = ref<LanguageVersion | null>(null);
  const versionFiles = ref<ReadonlyArray<string>>([]);
  let seq = 0;

  async function detect(): Promise<void> {
    const current = ++seq;
    const path = options.path();
    const files = options.files();
    const read = options.readFile();
    if (languageOf(path) === undefined) {
      version.value = null;
      versionFiles.value = [];
      return;
    }

    const names = await options.client.versionFiles(path);
    if (current !== seq) {
      return;
    }

    versionFiles.value = names;
    if (!files || !read) {
      version.value = null;
      return;
    }

    const paths = projectFilesAbove(path, names, (p) => files.has(p));
    const texts = await Promise.all(
      paths.map((p) => read(p).catch(() => undefined))
    );
    const found: ProjectFile[] = paths.flatMap((p, i) => {
      const text = texts[i];
      return text === undefined ? [] : [{ path: p, text }];
    });
    const detected =
      found.length > 0 ? await options.client.version(path, found) : null;
    if (current === seq) {
      version.value = detected;
    }
  }

  watch([options.path, options.files], () => void detect(), {
    immediate: true,
  });

  return { version, versionFiles };
}
