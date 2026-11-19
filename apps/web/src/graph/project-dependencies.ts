import type { ProjectDependency } from '@vizscript/core';
import { rustDependencies } from './cargo-project';
import { languageOf } from './languages';
import { npmDependencyChain } from './npm-project';
import { pythonDependencies } from './python-project';

/**
 * The dependencies of the project a file belongs to, read from its
 * ecosystem's manifest and lockfile (npm: also the manifests above it, up
 * to a monorepo's root; none for GDScript: addons are files of the
 * project).
 */
export function projectDependencies(
  files: ReadonlySet<string> | undefined,
  read: ((path: string) => Promise<string>) | undefined,
  path: string
): Promise<ProjectDependency[]> {
  switch (languageOf(path)) {
    case 'typescript': {
      return npmDependencyChain(files, read, path);
    }

    case 'python': {
      return pythonDependencies(files, read, path);
    }

    case 'rust': {
      return rustDependencies(files, read, path);
    }

    default: {
      return Promise.resolve([]);
    }
  }
}
