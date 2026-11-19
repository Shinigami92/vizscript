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
