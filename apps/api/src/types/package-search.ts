import type { PackageSearchResult } from '@vizscript/api-contract';

/**
 * Searching libraries to add ("+" in My Script's Imports): npm's and
 * crates.io's search, PyPI by exact name (it has no search API). The
 * server asks, so the web app talks to no further third parties.
 */
export type Ecosystem = 'npm' | 'crates' | 'pypi';

export const ECOSYSTEMS: ReadonlyArray<Ecosystem> = ['npm', 'crates', 'pypi'];

export interface SearchUpstream {
  /** `https://registry.npmjs.org/` */
  npmRegistry: string;
  /** `https://crates.io/` */
  crates: string;
  /** `https://pypi.org/` */
  pypi: string;
}

/** Results per search, at most. */
const LIMIT = 20;

/** The URL to ask, or `undefined` for a query that can't be one. */
export function searchUrl(
  ecosystem: Ecosystem,
  query: string,
  upstream: SearchUpstream
): string | undefined {
  const q = query.trim();
  if (q === '' || q.length > 100) {
    return undefined;
  }

  switch (ecosystem) {
    case 'npm': {
      return `${upstream.npmRegistry}-/v1/search?text=${encodeURIComponent(q)}&size=${LIMIT}`;
    }

    case 'crates': {
      return `${upstream.crates}api/v1/crates?q=${encodeURIComponent(q)}&per_page=${LIMIT}`;
    }

    case 'pypi': {
      return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(q)
        ? `${upstream.pypi}pypi/${q.toLowerCase().replaceAll(/[-_.]+/g, '-')}/json`
        : undefined;
    }
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** One result, if the registry named the package and a version. */
function result(
  name: unknown,
  version: unknown,
  description: unknown
): PackageSearchResult[] {
  const n = text(name);
  const v = text(version);
  if (!n || !v) {
    return [];
  }

  const d = text(description);
  return [
    { name: n, version: v, ...(d ? { description: d.slice(0, 200) } : {}) },
  ];
}

/** The registry's answer as results (latest stable versions). */
export function searchResults(
  ecosystem: Ecosystem,
  json: unknown
): PackageSearchResult[] {
  const record = (json ?? {}) as Record<string, unknown>;

  switch (ecosystem) {
    case 'npm': {
      const objects = Array.isArray(record.objects) ? record.objects : [];
      return objects.flatMap((object) => {
        const pkg = ((object ?? {}) as { package?: Record<string, unknown> })
          .package;
        return result(pkg?.name, pkg?.version, pkg?.description);
      });
    }

    case 'crates': {
      const crates = Array.isArray(record.crates) ? record.crates : [];
      return crates.flatMap((crate) => {
        const c = (crate ?? {}) as Record<string, unknown>;
        return result(
          c.name,
          c.max_stable_version ?? c.newest_version ?? c.max_version,
          c.description
        );
      });
    }

    case 'pypi': {
      const info = (record.info ?? {}) as Record<string, unknown>;
      return result(info.name, info.version, info.summary);
    }
  }
}
