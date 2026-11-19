import type { DependencyKind, ImportRequest } from '@vizscript/core';
import { languageOf } from './languages';
import {
  addCargoDependency,
  addNpmDependency,
  addPythonDependency,
} from './manifest-edits';
import { folderOf, nearest } from './project-files';

/**
 * Adding a library from My Script's Imports ("+"): which registry and
 * manifest a file uses, how the dependency is listed, the import written,
 * and what to run so the lockfile follows.
 */
export type Ecosystem = 'npm' | 'crates' | 'pypi';

export function ecosystemOf(path: string): Ecosystem | undefined {
  switch (languageOf(path)) {
    case 'typescript': {
      return 'npm';
    }

    case 'python': {
      return 'pypi';
    }

    case 'rust': {
      return 'crates';
    }

    default: {
      return undefined;
    }
  }
}

const MANIFESTS: Readonly<Record<Ecosystem, ReadonlyArray<string>>> = {
  npm: ['package.json'],
  pypi: ['pyproject.toml', 'requirements.txt'],
  crates: ['Cargo.toml'],
};

/** The manifest a new dependency of the file at `path` goes into. */
export function manifestFor(
  files: ReadonlySet<string> | undefined,
  path: string
): string | undefined {
  const ecosystem = ecosystemOf(path);
  return files && ecosystem
    ? nearest(files, folderOf(path), MANIFESTS[ecosystem])
    : undefined;
}

/** The kinds a manifest of the ecosystem can list a dependency as. */
export function kindsOf(ecosystem: Ecosystem): DependencyKind[] {
  switch (ecosystem) {
    case 'npm': {
      return ['runtime', 'dev', 'peer', 'optional'];
    }

    case 'crates': {
      return ['runtime', 'dev', 'build', 'optional'];
    }

    case 'pypi': {
      return ['runtime', 'dev'];
    }
  }
}

/** What the kinds are called in the ecosystem's manifest. */
export function kindLabel(ecosystem: Ecosystem, kind: DependencyKind): string {
  if (ecosystem === 'npm') {
    return (
      (
        {
          runtime: 'dependencies',
          dev: 'devDependencies',
          peer: 'peerDependencies',
          optional: 'optionalDependencies',
        } as Partial<Record<DependencyKind, string>>
      )[kind] ?? kind
    );
  }

  if (ecosystem === 'crates') {
    return (
      (
        {
          runtime: 'dependencies',
          dev: 'dev-dependencies',
          build: 'build-dependencies',
          optional: 'optional dependencies',
        } as Partial<Record<DependencyKind, string>>
      )[kind] ?? kind
    );
  }

  return kind === 'dev' ? 'dev dependency group' : 'dependencies';
}

/**
 * Where the file is used decides: tests, configs and type packages are
 * dev dependencies, a build script's are build ones, else runtime.
 */
export function defaultKind(path: string, name: string): DependencyKind {
  if (path.endsWith('/build.rs') || path === 'build.rs') {
    return 'build';
  }

  const tested =
    /(?:^|\/)(?:tests?|__tests__|benches|examples)\//.test(path) ||
    /\.(?:spec|test|stories)\.[^/]+$/.test(path) ||
    /(?:^|\/)(?:test_[^/]+|[^/]+_test)\.py$/.test(path) ||
    /(?:^|\/)[^/]+\.config\.[cm]?[jt]s$/.test(path) ||
    /(?:^|\/)conftest\.py$/.test(path);
  return tested || name.startsWith('@types/') ? 'dev' : 'runtime';
}

/** The manifest's text with the dependency added (in the file's style). */
export function manifestEdit(
  manifest: string,
  name: string,
  version: string,
  kind: DependencyKind
): (text: string) => string {
  if (manifest.endsWith('package.json')) {
    return (text) => addNpmDependency(text, name, version, kind);
  }

  if (manifest.endsWith('Cargo.toml')) {
    return (text) => addCargoDependency(text, name, version, kind);
  }

  return (text) => addPythonDependency(manifest, text, name, version, kind);
}

/**
 * The import of `imported` from `module` (a name of the library, or the
 * whole module when `undefined`).
 */
export function libraryImport(
  from: string,
  module: string,
  imported: string | undefined
): ImportRequest {
  // `import * as vue`, `import httpx`, `use serde_json;`
  const binding =
    module
      .split(/[/.]|::/)
      .at(-1)
      ?.replaceAll(/[^\w$]/g, '_')
      .replace(/^(\d)/, '_$1') ?? module;
  return imported
    ? { path: '', from, name: imported, imported, module }
    : { path: '', from, name: binding, imported: '*', module };
}

/** What to run so the lockfile lists the new dependency. */
export function installCommand(
  files: ReadonlySet<string> | undefined,
  manifest: string
): string {
  const dir = folderOf(manifest);
  const lock = (names: ReadonlyArray<string>): string | undefined =>
    files ? nearest(files, dir, names) : undefined;
  if (manifest.endsWith('package.json')) {
    const found = lock(['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json']);
    return found?.endsWith('pnpm-lock.yaml')
      ? 'pnpm install'
      : found?.endsWith('yarn.lock')
        ? 'yarn install'
        : 'npm install';
  }

  if (manifest.endsWith('Cargo.toml')) {
    return 'cargo build';
  }

  const found = lock(['uv.lock', 'poetry.lock', 'pdm.lock']);
  return found?.endsWith('uv.lock')
    ? 'uv sync'
    : found?.endsWith('poetry.lock')
      ? 'poetry lock'
      : found?.endsWith('pdm.lock')
        ? 'pdm lock'
        : 'pip install -r requirements.txt';
}
