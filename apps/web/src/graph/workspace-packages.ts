/**
 * Packages of the repository itself (a monorepo's `packages/*`): their
 * `package.json` names them, so an import of `@acme/api` in another
 * package of the repository is a file of the repository, like UE's
 * project modules.
 */
export interface WorkspacePackage {
  name: string;
  /** Its folder (`packages/api`). */
  dir: string;
  /** Its manifest as read (`exports`, `types`, `main`, …). */
  manifest: Record<string, unknown>;
}

/** Folders whose manifests are no packages of the repository. */
const SKIPPED = /(?:^|\/)(?:node_modules|dist|build|\.[^/]+)\//;

/** The repository's packages by name, read from their `package.json`. */
export async function workspacePackages(
  files: ReadonlySet<string>,
  read: (path: string) => Promise<string>
): Promise<Map<string, WorkspacePackage>> {
  const manifests = [...files].filter(
    (path) =>
      (path === 'package.json' || path.endsWith('/package.json')) &&
      !SKIPPED.test(path)
  );
  const found = await Promise.all(
    manifests.map(async (path): Promise<WorkspacePackage | undefined> => {
      try {
        const manifest = JSON.parse(await read(path)) as unknown;
        if (
          typeof manifest !== 'object' ||
          manifest === null ||
          typeof (manifest as { name?: unknown }).name !== 'string'
        ) {
          return undefined;
        }

        return {
          name: (manifest as { name: string }).name,
          dir: path.split('/').slice(0, -1).join('/'),
          manifest: manifest as Record<string, unknown>,
        };
      } catch {
        return undefined;
      }
    })
  );
  return new Map(found.flatMap((p) => (p ? [[p.name, p] as const] : [])));
}

/** `@acme/api/util` → `@acme/api` and `./util`. */
export function splitSpecifier(specifier: string): {
  name: string;
  subpath: string;
} {
  const parts = specifier.split('/');
  const size = specifier.startsWith('@') ? 2 : 1;
  const rest = parts.slice(size).join('/');
  return {
    name: parts.slice(0, size).join('/'),
    subpath: rest ? `./${rest}` : '.',
  };
}

/** Conditions of `exports` read for source files, most fitting first. */
const CONDITIONS = ['types', 'import', 'module', 'default', 'node', 'require'];

/** The file an `exports` entry names (a path or conditions). */
function conditional(target: unknown): string | undefined {
  if (typeof target === 'string') {
    return target;
  }

  if (Array.isArray(target)) {
    for (const option of target) {
      const found = conditional(option);
      if (found) {
        return found;
      }
    }

    return undefined;
  }

  if (typeof target === 'object' && target !== null) {
    const map = target as Record<string, unknown>;
    for (const condition of CONDITIONS) {
      const found = condition in map ? conditional(map[condition]) : undefined;
      if (found) {
        return found;
      }
    }
  }

  return undefined;
}

/** The target of `subpath` in `exports` (with `./*` patterns). */
function exported(exports: unknown, subpath: string): string | undefined {
  if (
    typeof exports !== 'object' ||
    exports === null ||
    Array.isArray(exports)
  ) {
    return subpath === '.' ? conditional(exports) : undefined;
  }

  const map = exports as Record<string, unknown>;
  // Conditions only (`{ "types": …, "import": … }`): the package's root.
  if (!Object.keys(map).some((key) => key.startsWith('.'))) {
    return subpath === '.' ? conditional(map) : undefined;
  }

  if (subpath in map) {
    return conditional(map[subpath]);
  }

  for (const [key, value] of Object.entries(map)) {
    const star = key.indexOf('*');
    if (star < 0) {
      continue;
    }

    const before = key.slice(0, star);
    const after = key.slice(star + 1);
    if (subpath.startsWith(before) && subpath.endsWith(after)) {
      const match = subpath.slice(before.length, subpath.length - after.length);
      return conditional(value)?.replaceAll('*', match);
    }
  }

  return undefined;
}

const SOURCE = ['.ts', '.tsx', '.mts', '.d.ts', '.js', '.jsx', '.mjs'];

/** Source files a package path may stand for (`./dist/x.js` → `src/x.ts`). */
function sources(dir: string, target: string): string[] {
  const path = target.replace(/^\.\//, '');
  const base = path.replace(/\.(?:d\.)?[cm]?[jt]sx?$/, '');
  const withoutBuild = base.replace(/^(?:dist|build|lib|out)\//, 'src/');
  const join = (p: string): string => (dir ? `${dir}/${p}` : p);
  return [
    join(path),
    ...[base, withoutBuild].flatMap((b) => [
      ...SOURCE.map((ext) => join(`${b}${ext}`)),
      ...SOURCE.map((ext) => join(`${b}/index${ext}`)),
    ]),
  ];
}

/**
 * The repository file an import of a workspace package means: the source
 * of its `exports` entry (or `types`, `module`, `main`), else its
 * `src/index.ts` or `index.ts`.
 */
export function resolveWorkspaceImport(
  specifier: string,
  packages: ReadonlyMap<string, WorkspacePackage>,
  exists: (path: string) => boolean
): string | undefined {
  const { name, subpath } = splitSpecifier(specifier);
  const pkg = packages.get(name);
  if (!pkg) {
    return undefined;
  }

  const { manifest } = pkg;
  const targets: string[] = [];
  const fromExports =
    manifest.exports === undefined
      ? undefined
      : exported(manifest.exports, subpath);
  if (fromExports) {
    targets.push(fromExports);
  } else if (subpath === '.') {
    for (const field of ['types', 'typings', 'module', 'main']) {
      const value = manifest[field];
      if (typeof value === 'string') {
        targets.push(value);
      }
    }

    targets.push('src/index', 'index');
  } else {
    targets.push(subpath, `src/${subpath.slice(2)}`);
  }

  for (const target of targets) {
    const found = sources(pkg.dir, target).find((path) => exists(path));
    if (found) {
      return found;
    }
  }

  return undefined;
}
