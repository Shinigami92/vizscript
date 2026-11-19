import type { DependencyKind, ProjectDependency } from '@vizscript/core';
import { folderOf, nearest } from './project-files';

/**
 * The npm dependencies of a file: the nearest `package.json` above it and
 * the exact versions of the nearest lockfile (pnpm, npm or yarn), so
 * library types are read in the version the project installs.
 */

/**
 * Sections in the order that names a package listed twice: a library's
 * peer dependency is often a devDependency too (for its own tests), and the
 * peer is what its users need.
 */
const SECTIONS: ReadonlyArray<readonly [string, DependencyKind]> = [
  ['dependencies', 'runtime'],
  ['peerDependencies', 'peer'],
  ['optionalDependencies', 'optional'],
  ['devDependencies', 'dev'],
];

const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock'];

/** Ranges that name a package of the repository, not of the registry. */
function isLocal(range: string): boolean {
  return /^(?:workspace|file|link|portal):/.test(range);
}

/** The dependencies a `package.json` lists (the first section wins). */
export function manifestDependencies(
  text: string,
  manifest: string
): ProjectDependency[] {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return [];
  }

  const found = new Map<string, ProjectDependency>();
  for (const [section, kind] of SECTIONS) {
    const entries = json[section];
    if (!entries || typeof entries !== 'object') {
      continue;
    }

    for (const [name, range] of Object.entries(entries)) {
      if (typeof range === 'string' && !found.has(name)) {
        found.set(name, {
          name,
          range,
          kind,
          manifest,
          ...(isLocal(range) ? { local: true } : {}),
        });
      }
    }
  }

  return [...found.values()];
}

/** `3.5.45(typescript@6.0.3)` → `3.5.45`; `link:…` stays (local). */
function cleanVersion(version: string): string {
  return version
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/\(.*$/, '')
    .replace(/_.*$/, '');
}

function unquote(key: string): string {
  return key.trim().replace(/^['"]|['"]$/g, '');
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * Versions of one importer (`.` for the lockfile's own folder) in a
 * `pnpm-lock.yaml`. Read line by line: pnpm writes a fixed layout, and the
 * lockfile can have several documents (pnpm's own one first).
 */
export function pnpmVersions(
  text: string,
  importer: string
): Map<string, string> {
  const versions = new Map<string, string>();
  let inImporters = false;
  let inImporter = false;
  let name: string | undefined;
  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      continue;
    }

    const indent = indentOf(line);
    if (indent === 0) {
      inImporters = line.trim() === 'importers:';
      inImporter = false;
      continue;
    }

    if (!inImporters) {
      continue;
    }

    const [rawKey = '', ...rest] = line.trim().split(/:(?:\s+|$)/);
    const value = rest.join(': ').trim();
    if (indent === 2) {
      inImporter = unquote(rawKey) === importer;
      name = undefined;
    } else if (inImporter && indent === 6) {
      // `vue:` with `version:` below (v6+), or `vue: 3.2.0` (v5).
      name = unquote(rawKey);
      if (value) {
        versions.set(name, cleanVersion(value));
      }
    } else if (inImporter && indent === 8 && name && rawKey === 'version') {
      versions.set(name, cleanVersion(value));
    }
  }

  return versions;
}

/** Versions an npm `package-lock.json` installs for the importer's folder. */
export function npmLockVersions(
  text: string,
  importer: string
): Map<string, string> {
  const versions = new Map<string, string>();
  let json: {
    packages?: Record<string, { version?: unknown }>;
    dependencies?: Record<string, { version?: unknown }>;
  };
  try {
    json = JSON.parse(text) as typeof json;
  } catch {
    return versions;
  }

  const prefix = importer === '.' ? '' : `${importer}/`;
  // Hoisted to the root first, then the importer's own (nested) copy wins.
  for (const base of ['', prefix]) {
    for (const [key, entry] of Object.entries(json.packages ?? {})) {
      const name = key.startsWith(`${base}node_modules/`)
        ? key.slice(`${base}node_modules/`.length)
        : undefined;
      if (
        name &&
        !name.includes('/node_modules/') &&
        typeof entry.version === 'string'
      ) {
        versions.set(name, entry.version);
      }
    }
  }

  // lockfileVersion 1: the root's tree only.
  for (const [name, entry] of Object.entries(json.dependencies ?? {})) {
    if (!versions.has(name) && typeof entry.version === 'string') {
      versions.set(name, entry.version);
    }
  }

  return versions;
}

const YARN_VERSION = /^\s+version:?\s+(.+)$/;

/**
 * Versions of a `yarn.lock` (classic and berry) by `name@range`, as the
 * manifest writes the range.
 */
export function yarnVersions(text: string): Map<string, string> {
  const versions = new Map<string, string>();
  let descriptors: string[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.startsWith('#')) {
      continue;
    }

    if (indentOf(line) === 0) {
      descriptors = line
        .replace(/:\s*$/, '')
        .split(',')
        .map((d) => unquote(d).replace(/@npm:/, '@'));
      continue;
    }

    const version = line.match(YARN_VERSION)?.[1];
    if (version && indentOf(line) === 2) {
      for (const descriptor of descriptors) {
        versions.set(descriptor, cleanVersion(version));
      }
    }
  }

  return versions;
}

/** Versions of the importer at `importer` in the lockfile at `path`. */
export function lockedVersions(
  path: string,
  text: string,
  importer: string,
  dependencies: ReadonlyArray<ProjectDependency>
): Map<string, string> {
  if (path.endsWith('pnpm-lock.yaml')) {
    return pnpmVersions(text, importer);
  }

  if (path.endsWith('package-lock.json')) {
    return npmLockVersions(text, importer);
  }

  const byDescriptor = yarnVersions(text);
  const versions = new Map<string, string>();
  for (const dependency of dependencies) {
    const version = byDescriptor.get(`${dependency.name}@${dependency.range}`);
    if (version) {
      versions.set(dependency.name, version);
    }
  }

  return versions;
}

/** Parsed results, by manifest path; read again when a text changes. */
const projects = new Map<
  string,
  { manifest: string; lock: string; dependencies: ProjectDependency[] }
>();

/** The nearest `package.json` above `path` that parses, with its text. */
async function nearestManifest(
  files: ReadonlySet<string>,
  read: (path: string) => Promise<string>,
  path: string
): Promise<{ path: string; text: string } | undefined> {
  let dirs = folderOf(path);
  for (;;) {
    const found = nearest(files, dirs, ['package.json']);
    if (!found) {
      return undefined;
    }

    const text = await read(found).catch(() => '');
    try {
      JSON.parse(text);
      return { path: found, text };
    } catch {
      // Not JSON: look further up.
      const dir = folderOf(found);
      if (dir.length === 0) {
        return undefined;
      }

      dirs = dir.slice(0, -1);
    }
  }
}

/** The dependencies of a manifest, with the nearest lockfile's versions. */
async function dependenciesOf(
  files: ReadonlySet<string>,
  read: (path: string) => Promise<string>,
  manifest: { path: string; text: string }
): Promise<ProjectDependency[]> {
  const manifestDir = folderOf(manifest.path);
  const lockPath = nearest(files, manifestDir, LOCKFILES);
  const lockText = lockPath ? await read(lockPath).catch(() => '') : '';
  const cached = projects.get(manifest.path);
  if (cached?.manifest === manifest.text && cached.lock === lockText) {
    return cached.dependencies;
  }

  const declared = manifestDependencies(manifest.text, manifest.path);
  const lockDir = lockPath ? folderOf(lockPath) : [];
  const importer = manifestDir.slice(lockDir.length).join('/') || '.';
  const versions = lockPath
    ? lockedVersions(lockPath, lockText, importer, declared)
    : new Map<string, string>();
  const dependencies = declared.map((dependency) => {
    const version = versions.get(dependency.name);
    return version && !dependency.local && !isLocal(version)
      ? { ...dependency, version }
      : dependency;
  });
  projects.set(manifest.path, {
    manifest: manifest.text,
    lock: lockText,
    dependencies,
  });
  return dependencies;
}

/**
 * The dependencies of the nearest `package.json` above `path`, with the
 * versions of the nearest lockfile; `[]` without a manifest.
 */
export async function npmDependencies(
  files: ReadonlySet<string> | undefined,
  read: ((path: string) => Promise<string>) | undefined,
  path: string
): Promise<ProjectDependency[]> {
  if (!files || !read) {
    return [];
  }

  const manifest = await nearestManifest(files, read, path);
  return manifest ? dependenciesOf(files, read, manifest) : [];
}

/**
 * The dependencies of every `package.json` from the nearest one above
 * `path` up to the repository's root (a monorepo's root has the tools),
 * nearest first; a package listed twice counts where it is nearest.
 */
export async function npmDependencyChain(
  files: ReadonlySet<string> | undefined,
  read: ((path: string) => Promise<string>) | undefined,
  path: string
): Promise<ProjectDependency[]> {
  if (!files || !read) {
    return [];
  }

  const found = new Map<string, ProjectDependency>();
  let from = path;
  for (;;) {
    const manifest = await nearestManifest(files, read, from);
    if (!manifest) {
      break;
    }

    for (const dependency of await dependenciesOf(files, read, manifest)) {
      if (!found.has(dependency.name)) {
        found.set(dependency.name, dependency);
      }
    }

    const dir = folderOf(manifest.path);
    if (dir.length === 0) {
      break;
    }

    from = [...dir.slice(0, -1), 'package.json'].join('/');
  }

  return [...found.values()];
}

/**
 * The version to read a package's types in: the lockfile's exact version,
 * else the manifest's range, `latest` when no manifest lists it, `''` for
 * packages of the repository (nothing to fetch).
 */
export async function packageVersion(
  files: ReadonlySet<string> | undefined,
  read: ((path: string) => Promise<string>) | undefined,
  path: string,
  name: string
): Promise<string> {
  const dependency = (await npmDependencyChain(files, read, path)).find(
    (d) => d.name === name
  );
  if (!dependency) {
    return 'latest';
  }

  if (dependency.local) {
    return '';
  }

  // `catalog:` and other protocols mean nothing to the registry.
  return (
    dependency.version ??
    (/^[a-z]+:/.test(dependency.range) ? 'latest' : dependency.range)
  );
}
