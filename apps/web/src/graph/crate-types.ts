import { typeRegistryAvailable } from './type-registry';

/**
 * Rust crates' public APIs as Rust declarations per module, from the
 * server's type registry (`/api/types/crate`, made from docs.rs's rustdoc
 * JSON, which the browser can't read itself). Without a server, crates
 * have no declarations.
 */
export interface CrateStubs {
  crate: string;
  version: string;
  /** Declarations by module path inside the crate (`''`, `bytes::complete`). */
  modules: Record<string, string>;
}

const crates = new Map<string, Promise<CrateStubs | undefined>>();

/** The stubs of `name` in `version` (exact, a range or `latest`). */
export function crateStubs(
  name: string,
  version: string
): Promise<CrateStubs | undefined> {
  const key = `${name}@${version}`;
  let stubs = crates.get(key);
  if (!stubs) {
    stubs = (async (): Promise<CrateStubs | undefined> => {
      if (!(await typeRegistryAvailable())) {
        return undefined;
      }

      const response = await fetch(
        `/api/types/crate?name=${encodeURIComponent(name)}&version=${encodeURIComponent(version)}`
      );
      if (!response.ok) {
        // A failure other than "none" is tried again next time.
        if (response.status !== 404) {
          crates.delete(key);
        }

        return undefined;
      }

      return (await response.json()) as CrateStubs;
    })().catch(() => {
      crates.delete(key);
      return undefined;
    });
    crates.set(key, stubs);
  }

  return stubs;
}

/** Modules of Rust itself and of the crate being written. */
const NOT_CRATES = new Set(['std', 'core', 'alloc', 'crate', 'self', 'super']);

/**
 * The crate and module path of a `use` (`nom::bytes::complete` →
 * `nom`, `bytes::complete`); `undefined` for std and the crate itself.
 */
export function crateModule(
  module: string
): { crate: string; path: string } | undefined {
  const [crate, ...rest] = module.split('::');
  return crate && !NOT_CRATES.has(crate)
    ? { crate, path: rest.join('::') }
    : undefined;
}

/**
 * A path with its first segment resolved through the file's `use`s:
 * `overrides::OverrideBuilder` after `use ignore::overrides;` is
 * `ignore::overrides::OverrideBuilder`, `json::Value` after `use
 * serde_json as json;` is `serde_json::Value`.
 */
export function usePath(
  path: string,
  uses: ReadonlyArray<{ name: string; module?: string; imported?: string }>
): string {
  const [head, ...rest] = path.split('::');
  const use = uses.find((u) => u.name === head && u.module);
  if (!use?.module || rest.length === 0) {
    return path;
  }

  const module =
    use.imported && use.imported !== '*'
      ? `${use.module}::${use.imported}`
      : use.module;
  return [module, ...rest].join('::');
}

/**
 * Files of a module of a crate whose root file is `root` (`lib.rs`):
 * `parser::tag` is `parser/tag.rs` or `parser/tag/mod.rs` next to it, the
 * crate itself its root.
 */
export function moduleFiles(root: string, path: string): string[] {
  if (path === '') {
    return [root];
  }

  const dir = root.split('/').slice(0, -1);
  const module = [...dir, ...path.split('::')].join('/');
  return [`${module}.rs`, `${module}/mod.rs`];
}
