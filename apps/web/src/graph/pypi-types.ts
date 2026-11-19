import { typeRegistryAvailable } from './type-registry';

/**
 * A Python package's own typed files (PEP 561: `.pyi` stubs and the `.py`
 * files of `py.typed` packages), from a wheel of its release on PyPI,
 * read by the server's type registry (`/api/types/pypi`). Without a
 * server, or for a package without types, typeshed's stubs are used.
 */
export interface PackageTypes {
  name: string;
  version: string;
  /** Files by their path in the wheel (`httpx/_client.py`). */
  files: Record<string, string>;
}

const packages = new Map<string, Promise<PackageTypes | undefined>>();

/** The typed files of `name` in `version` (exact, else the latest). */
export function packageTypes(
  name: string,
  version: string
): Promise<PackageTypes | undefined> {
  const key = `${name}@${version}`;
  let types = packages.get(key);
  if (!types) {
    types = (async (): Promise<PackageTypes | undefined> => {
      if (!(await typeRegistryAvailable())) {
        return undefined;
      }

      const response = await fetch(
        `/api/types/pypi?name=${encodeURIComponent(name)}&version=${encodeURIComponent(version)}`
      );
      if (!response.ok) {
        if (response.status !== 404) {
          packages.delete(key);
        }

        return undefined;
      }

      const found = (await response.json()) as PackageTypes;
      return Object.keys(found.files).length > 0 ? found : undefined;
    })().catch(() => {
      packages.delete(key);
      return undefined;
    });
    packages.set(key, types);
  }

  return types;
}

/** The version to ask for: a pin (`==2.32.3`) or the lockfile's; else latest. */
export function pythonPackageVersion(dependency: {
  range: string;
  version?: string;
}): string {
  return (
    dependency.version ??
    dependency.range.match(/^===?\s*([\w.]+)$/)?.[1] ??
    'latest'
  );
}
