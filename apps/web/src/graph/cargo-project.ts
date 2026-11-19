import type { DependencyKind, ProjectDependency } from '@vizscript/core';
import { parse } from 'smol-toml';
import { folderOf, nearest } from './project-files';

/**
 * The Rust dependencies of a file: the nearest `Cargo.toml` above it
 * (with `workspace = true` entries from the workspace root's
 * `[workspace.dependencies]`) and the versions of the nearest `Cargo.lock`.
 */

type Table = Record<string, unknown>;

function table(value: unknown): Table | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Table)
    : undefined;
}

const SECTIONS: ReadonlyArray<readonly [string, DependencyKind]> = [
  ['dependencies', 'runtime'],
  ['dev-dependencies', 'dev'],
  ['build-dependencies', 'build'],
];

/**
 * One entry: `serde = "1"`, `serde = { version = "1", features = […] }`,
 * `local = { path = "../x" }`, `json = { package = "serde_json", … }` or
 * `tokio = { workspace = true }` (resolved by `workspace`).
 */
function cargoDependency(
  key: string,
  value: unknown,
  kind: DependencyKind,
  manifest: string,
  workspace: Table | undefined
): ProjectDependency | undefined {
  if (typeof value === 'string') {
    return { name: key, range: value, kind, manifest };
  }

  let spec = table(value);
  if (!spec) {
    return undefined;
  }

  if (spec.workspace === true) {
    const inherited = workspace?.[key];
    spec =
      typeof inherited === 'string'
        ? { ...spec, version: inherited }
        : { ...table(inherited), ...spec };
  }

  const name = typeof spec.package === 'string' ? spec.package : key;
  const range =
    typeof spec.version === 'string'
      ? spec.version
      : typeof spec.git === 'string'
        ? `git+${spec.git}`
        : '*';
  return {
    name,
    range,
    kind: spec.optional === true ? 'optional' : kind,
    manifest,
    ...(typeof spec.path === 'string' ? { local: true } : {}),
    ...(name === key ? {} : { alias: key }),
  };
}

/**
 * The dependencies a `Cargo.toml` lists (also per target, `[target.'cfg(…)'
 * .dependencies]`); `workspace` is the root's `[workspace.dependencies]`.
 */
export function cargoDependencies(
  text: string,
  manifest: string,
  workspace?: Table
): ProjectDependency[] {
  let toml: Table;
  try {
    toml = parse(text);
  } catch {
    return [];
  }

  const found = new Map<string, ProjectDependency>();
  const read = (owner: Table | undefined): void => {
    for (const [section, kind] of SECTIONS) {
      for (const [key, value] of Object.entries(
        table(owner?.[section]) ?? {}
      )) {
        const dependency = cargoDependency(
          key,
          value,
          kind,
          manifest,
          workspace ?? table(table(toml.workspace)?.dependencies)
        );
        if (dependency && !found.has(key)) {
          found.set(key, dependency);
        }
      }
    }
  };

  read(toml);
  for (const target of Object.values(table(toml.target) ?? {})) {
    read(table(target));
  }

  return [...found.values()];
}

/** Versions of a `Cargo.lock` by crate name (the first one listed). */
export function cargoLockVersions(text: string): Map<string, string> {
  const versions = new Map<string, string>();
  let toml: Table;
  try {
    toml = parse(text);
  } catch {
    return versions;
  }

  for (const entry of Array.isArray(toml.package) ? toml.package : []) {
    const item = table(entry);
    if (
      typeof item?.name === 'string' &&
      typeof item.version === 'string' &&
      !versions.has(item.name)
    ) {
      versions.set(item.name, item.version);
    }
  }

  return versions;
}

/** The `[workspace.dependencies]` of the nearest workspace root above. */
async function workspaceDependencies(
  files: ReadonlySet<string>,
  read: (path: string) => Promise<string>,
  manifest: string
): Promise<Table | undefined> {
  let dirs = folderOf(manifest);
  for (;;) {
    const found = nearest(files, dirs, ['Cargo.toml']);
    if (!found) {
      return undefined;
    }

    try {
      const workspace = table(
        parse(await read(found).catch(() => '')).workspace
      );
      if (workspace) {
        return table(workspace.dependencies) ?? {};
      }
    } catch {
      // not TOML: look further up
    }

    const dir = folderOf(found);
    if (dir.length === 0) {
      return undefined;
    }

    dirs = dir.slice(0, -1);
  }
}

/** Parsed results, by manifest path; read again when a text changes. */
const projects = new Map<
  string,
  { key: string; dependencies: ProjectDependency[] }
>();

/**
 * The dependencies of the nearest `Cargo.toml` above `path`, with the
 * nearest `Cargo.lock`'s versions; `[]` without one.
 */
export async function rustDependencies(
  files: ReadonlySet<string> | undefined,
  read: ((path: string) => Promise<string>) | undefined,
  path: string
): Promise<ProjectDependency[]> {
  if (!files || !read) {
    return [];
  }

  const manifest = nearest(files, folderOf(path), ['Cargo.toml']);
  if (!manifest) {
    return [];
  }

  const text = await read(manifest).catch(() => '');
  const lockPath = nearest(files, folderOf(manifest), ['Cargo.lock']);
  const lockText = lockPath ? await read(lockPath).catch(() => '') : '';
  const workspace = await workspaceDependencies(files, read, manifest);
  const key = JSON.stringify([text, lockText, workspace]);
  const cached = projects.get(manifest);
  if (cached?.key === key) {
    return cached.dependencies;
  }

  const versions = cargoLockVersions(lockText);
  const dependencies = cargoDependencies(text, manifest, workspace).map(
    (dependency) => {
      const version = versions.get(dependency.name);
      return version && !dependency.local
        ? { ...dependency, version }
        : dependency;
    }
  );
  projects.set(manifest, { key, dependencies });
  return dependencies;
}
