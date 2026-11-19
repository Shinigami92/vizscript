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
  const workspace = await workspaceManifest(files, read, manifest);
  return workspace
    ? (table(table(workspace.toml.workspace)?.dependencies) ?? {})
    : undefined;
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

/** The library target of a crate of the repository, as code names it. */
export interface CrateLibrary {
  /** `[lib] name`, else the package's name with `_` for `-`. */
  name: string;
  /** Its root file (`[lib] path`, else `src/lib.rs`). */
  root: string;
}

/** `dirs` joined with a relative path (`..` goes up). */
function joinPath(dirs: ReadonlyArray<string>, relative: string): string[] {
  const result = [...dirs];
  for (const part of relative.split('/')) {
    if (part === '..') {
      result.pop();
    } else if (part !== '.' && part !== '') {
      result.push(part);
    }
  }

  return result;
}

async function readToml(
  read: (path: string) => Promise<string>,
  path: string
): Promise<Table | undefined> {
  try {
    return parse(await read(path));
  } catch {
    return undefined;
  }
}

/** The library a `Cargo.toml` declares, when its root file exists. */
async function libraryOf(
  files: ReadonlySet<string>,
  read: (path: string) => Promise<string>,
  manifest: string
): Promise<CrateLibrary | undefined> {
  const toml = files.has(manifest) ? await readToml(read, manifest) : undefined;
  const lib = table(toml?.lib);
  const pkg = table(toml?.package);
  const name =
    typeof lib?.name === 'string'
      ? lib.name
      : typeof pkg?.name === 'string'
        ? pkg.name.replaceAll('-', '_')
        : undefined;
  const root = joinPath(
    folderOf(manifest),
    typeof lib?.path === 'string' ? lib.path : 'src/lib.rs'
  ).join('/');
  return name && files.has(root) ? { name, root } : undefined;
}

/** The nearest workspace root's manifest above a manifest. */
async function workspaceManifest(
  files: ReadonlySet<string>,
  read: (path: string) => Promise<string>,
  manifest: string
): Promise<{ path: string; toml: Table } | undefined> {
  let dirs = folderOf(manifest);
  for (;;) {
    const found = nearest(files, dirs, ['Cargo.toml']);
    if (!found) {
      return undefined;
    }

    const toml = await readToml(read, found);
    if (table(toml?.workspace) && toml) {
      return { path: found, toml };
    }

    const dir = folderOf(found);
    if (dir.length === 0) {
      return undefined;
    }

    dirs = dir.slice(0, -1);
  }
}

/**
 * The crates of the repository a file can name: its own library and its
 * path dependencies (`x = { path = "../x" }`, also through the
 * workspace's `[workspace.dependencies]`), by the name code uses (a
 * renamed dependency's key).
 */
export async function localLibraries(
  files: ReadonlySet<string> | undefined,
  read: ((path: string) => Promise<string>) | undefined,
  path: string
): Promise<CrateLibrary[]> {
  const manifest = files
    ? nearest(files, folderOf(path), ['Cargo.toml'])
    : undefined;
  const toml = manifest && read ? await readToml(read, manifest) : undefined;
  if (!files || !read || !manifest || !toml) {
    return [];
  }

  const own = await libraryOf(files, read, manifest);
  const workspace = await workspaceManifest(files, read, manifest);
  const shared = table(table(workspace?.toml.workspace)?.dependencies);
  const found: Array<Promise<CrateLibrary | undefined>> = [];
  const owners = [
    toml,
    ...Object.values(table(toml.target) ?? {}).map((t) => table(t)),
  ];
  for (const owner of owners) {
    for (const [section] of SECTIONS) {
      for (const [key, value] of Object.entries(
        table(owner?.[section]) ?? {}
      )) {
        let spec = table(value);
        let base = folderOf(manifest);
        if (spec?.workspace === true && workspace) {
          spec = table(shared?.[key]);
          base = folderOf(workspace.path);
        }

        if (typeof spec?.path !== 'string') {
          continue;
        }

        const renamed = typeof spec.package === 'string';
        const dependency = [...joinPath(base, spec.path), 'Cargo.toml'].join(
          '/'
        );
        found.push(
          libraryOf(files, read, dependency).then((library) =>
            library && renamed
              ? { ...library, name: key.replaceAll('-', '_') }
              : library
          )
        );
      }
    }
  }

  return [own, ...(await Promise.all(found))].filter(
    (library): library is CrateLibrary => library !== undefined
  );
}
