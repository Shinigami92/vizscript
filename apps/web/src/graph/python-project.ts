import type { DependencyKind, ProjectDependency } from '@vizscript/core';
import { parse } from 'smol-toml';
import { folderOf, nearest } from './project-files';

/**
 * The Python dependencies of a file: the nearest `pyproject.toml` (PEP 621,
 * PEP 735 dependency groups, uv and Poetry) or `requirements*.txt` above
 * it, with the versions of the nearest lockfile (`uv.lock`, `poetry.lock`,
 * `pdm.lock`).
 */

const LOCKFILES = ['uv.lock', 'poetry.lock', 'pdm.lock'];

type Table = Record<string, unknown>;

function table(value: unknown): Table | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Table)
    : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** PEP 503: `Typing_Extensions` and `typing.extensions` are one package. */
export function normalizeName(name: string): string {
  return name.toLowerCase().replaceAll(/[-_.]+/g, '-');
}

/**
 * A PEP 508 requirement: `requests[socks]>=2.31,<3 ; python_version<"3.13"`
 * → `requests`, `>=2.31,<3`. URLs (`pkg @ https://…`) have no range.
 */
export function requirement(
  text: string
): { name: string; range: string } | undefined {
  const match = text
    .trim()
    .match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*([^;@]*)/);
  const name = match?.[1];
  if (!name) {
    return undefined;
  }

  const range = (match[2] ?? '').replaceAll(/\s+/g, '');
  return { name, range: range || '*' };
}

/** `requirements-dev.txt`, `requirements/test.txt`: dev; else runtime. */
function requirementsKind(path: string): DependencyKind {
  return /(?:dev|test|lint|docs)/i.test(path.split('/').at(-1) ?? '')
    ? 'dev'
    : 'runtime';
}

/** The requirements of a `requirements.txt` (options and includes skipped). */
export function requirementsDependencies(
  text: string,
  manifest: string
): ProjectDependency[] {
  const kind = requirementsKind(manifest);
  return text.split('\n').flatMap((line): ProjectDependency[] => {
    const content = line.replace(/(?:^|\s)#.*$/, '').trim();
    if (content === '' || content.startsWith('-')) {
      return [];
    }

    const found = requirement(content);
    return found ? [{ ...found, kind, manifest }] : [];
  });
}

/** A Poetry dependency: `"^2.0"` or `{ version = "^2.0", optional = true }`. */
function poetryDependency(
  name: string,
  value: unknown,
  kind: DependencyKind,
  manifest: string
): ProjectDependency | undefined {
  if (normalizeName(name) === 'python') {
    return undefined;
  }

  if (typeof value === 'string') {
    return { name, range: value, kind, manifest };
  }

  const spec = table(value);
  if (!spec) {
    return undefined;
  }

  const local = typeof spec.path === 'string';
  return {
    name,
    range: typeof spec.version === 'string' ? spec.version : '*',
    kind: spec.optional === true ? 'optional' : kind,
    manifest,
    ...(local ? { local } : {}),
  };
}

/** The dependencies a `pyproject.toml` lists (the first mention wins). */
export function pyprojectDependencies(
  text: string,
  manifest: string
): ProjectDependency[] {
  let toml: Table;
  try {
    toml = parse(text);
  } catch {
    return [];
  }

  const found = new Map<string, ProjectDependency>();
  const add = (dependency: ProjectDependency | undefined): void => {
    const key = dependency && normalizeName(dependency.name);
    if (dependency && key && !found.has(key)) {
      found.set(key, dependency);
    }
  };
  const addRequirements = (list: unknown, kind: DependencyKind): void => {
    for (const entry of strings(list)) {
      const parsed = requirement(entry);
      add(parsed && { ...parsed, kind, manifest });
    }
  };

  const project = table(toml.project);
  addRequirements(project?.dependencies, 'runtime');
  for (const list of Object.values(
    table(project?.['optional-dependencies']) ?? {}
  )) {
    addRequirements(list, 'optional');
  }

  // PEP 735 groups (`dev`, `test` …) and uv's older `dev-dependencies`.
  for (const list of Object.values(table(toml['dependency-groups']) ?? {})) {
    addRequirements(list, 'dev');
  }

  const tool = table(toml.tool);
  addRequirements(table(tool?.uv)?.['dev-dependencies'], 'dev');

  // Repository packages of a uv workspace (`[tool.uv.sources]`).
  for (const [name, source] of Object.entries(
    table(table(tool?.uv)?.sources) ?? {}
  )) {
    const existing = found.get(normalizeName(name));
    const spec = table(source);
    if (
      existing &&
      (spec?.workspace === true || typeof spec?.path === 'string')
    ) {
      found.set(normalizeName(name), { ...existing, local: true });
    }
  }

  const poetry = table(tool?.poetry);
  for (const [name, value] of Object.entries(
    table(poetry?.dependencies) ?? {}
  )) {
    add(poetryDependency(name, value, 'runtime', manifest));
  }

  for (const [name, value] of Object.entries(
    table(poetry?.['dev-dependencies']) ?? {}
  )) {
    add(poetryDependency(name, value, 'dev', manifest));
  }

  for (const group of Object.values(table(poetry?.group) ?? {})) {
    for (const [name, value] of Object.entries(
      table(table(group)?.dependencies) ?? {}
    )) {
      add(poetryDependency(name, value, 'dev', manifest));
    }
  }

  return [...found.values()];
}

/**
 * Versions of a `uv.lock`, `poetry.lock` or `pdm.lock` (all TOML with
 * `[[package]]` entries), by normalized name.
 */
export function pythonLockVersions(text: string): Map<string, string> {
  const versions = new Map<string, string>();
  let toml: Table;
  try {
    toml = parse(text);
  } catch {
    return versions;
  }

  const packages = Array.isArray(toml.package) ? toml.package : [];
  for (const entry of packages) {
    const item = table(entry);
    const key =
      typeof item?.name === 'string' ? normalizeName(item.name) : undefined;
    if (key && typeof item?.version === 'string' && !versions.has(key)) {
      versions.set(key, item.version);
    }
  }

  return versions;
}

/** Parsed results, by manifest path; read again when a text changes. */
const projects = new Map<
  string,
  { manifest: string; lock: string; dependencies: ProjectDependency[] }
>();

/**
 * The dependencies of the nearest `pyproject.toml` or `requirements.txt`
 * above `path`, with the nearest lockfile's versions; `[]` without one.
 */
export async function pythonDependencies(
  files: ReadonlySet<string> | undefined,
  read: ((path: string) => Promise<string>) | undefined,
  path: string
): Promise<ProjectDependency[]> {
  if (!files || !read) {
    return [];
  }

  const dirs = folderOf(path);
  const manifest = nearest(files, dirs, ['pyproject.toml', 'requirements.txt']);
  if (!manifest) {
    return [];
  }

  const text = await read(manifest).catch(() => '');
  const lockPath = nearest(files, folderOf(manifest), LOCKFILES);
  const lockText = lockPath ? await read(lockPath).catch(() => '') : '';
  const cached = projects.get(manifest);
  if (cached?.manifest === text && cached.lock === lockText) {
    return cached.dependencies;
  }

  const declared = manifest.endsWith('.toml')
    ? pyprojectDependencies(text, manifest)
    : requirementsDependencies(text, manifest);
  const versions = pythonLockVersions(lockText);
  const dependencies = declared.map((dependency) => {
    const version = versions.get(normalizeName(dependency.name));
    return version && !dependency.local
      ? { ...dependency, version }
      : dependency;
  });
  projects.set(manifest, { manifest: text, lock: lockText, dependencies });
  return dependencies;
}
