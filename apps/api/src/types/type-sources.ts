/**
 * What the type registry may fetch: library type files and file listings,
 * named by the path jsDelivr uses (`npm/vue@3.5.45/dist/vue.d.ts`,
 * `gh/python/typeshed@<commit>/stdlib/json/__init__.pyi`). The upstream
 * URL is built from the validated parts only, never taken from a client,
 * and only declaration files are allowed (no scripts).
 */
export interface TypeSource {
  /** Cache key: the kind and the path. */
  key: string;
  /** Where it is fetched from. */
  url: string;
  /** An exact version or commit: its content never changes. */
  immutable: boolean;
  kind: 'file' | 'listing' | 'crate' | 'pypi';
  /**
   * Asked when `url` answers 404 (docs.rs has no rustdoc JSON of older
   * versions: the newest compatible one instead); not immutable then.
   */
  fallback?: string;
  /** A crate or Python package: name and version as asked. */
  crate?: { name: string; version: string };
}

export interface TypeUpstream {
  /** jsDelivr's CDN, ending with `/` (`https://cdn.jsdelivr.net/`). */
  cdn: string;
  /** jsDelivr's data API for listings (`https://data.jsdelivr.com/v1/packages/`). */
  listing: string;
  /** docs.rs, ending with `/` (`https://docs.rs/`): crates' rustdoc JSON. */
  docs: string;
  /** PyPI's JSON API, ending with `/` (`https://pypi.org/`). */
  pypi: string;
  /** Where PyPI's files are (`https://files.pythonhosted.org/`): only wheels from there are read. */
  pypiFiles: string;
}

/** npm package names: `vue`, `@vue/runtime-dom`. */
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
/** An exact semver version (`3.5.45`, `1.0.0-beta.1`). */
export const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
/** A version, tag or range as `package.json` writes it (`^3.5.0`, `latest`). */
const RANGE = /^[\w.^~<>=|* -]{1,64}$/;
/** typeshed, pinned to a commit. */
const TYPESHED = /^gh\/python\/typeshed@([0-9a-f]{40})(?:\/(.+))?$/;
/** `npm/<name>@<version>[/<file>]`. */
const NPM = /^npm\/((?:@[^/@]+\/)?[^/@]+)@([^/]+)(?:\/(.+))?$/;
/** Files inside a package: plain segments, no `..`. */
const FILE = /^(?:[\w@+~-][\w.@+~-]*\/)*[\w@+~-][\w.@+~-]*$/;
const NPM_FILES = /(?:\.d\.[cm]?ts|(?:^|\/)package\.json)$/;
const TYPESHED_FILES = /(?:\.pyi|^stdlib\/VERSIONS)$/;
const MAX_PATH = 512;

interface NpmPath {
  name: string;
  version: string;
  file?: string;
}

/** `npm/<name>@<version>[/<file>]`; the version may be URL-encoded. */
function npmPath(path: string): NpmPath | undefined {
  const match = path.match(NPM);
  const name = match?.[1];
  const raw = match?.[2];
  if (!name || !raw || !PACKAGE.test(name)) {
    return undefined;
  }

  let version: string;
  try {
    version = decodeURIComponent(raw);
  } catch {
    return undefined;
  }

  if (!RANGE.test(version)) {
    return undefined;
  }

  return { name, version, ...(match[3] ? { file: match[3] } : {}) };
}

/** A type file to read (`npm/…` or typeshed's), or `undefined`. */
export function typeFileSource(
  path: string,
  upstream: TypeUpstream
): TypeSource | undefined {
  if (path.length > MAX_PATH) {
    return undefined;
  }

  const typeshed = path.match(TYPESHED);
  if (typeshed) {
    const file = typeshed[2];
    return file && FILE.test(file) && TYPESHED_FILES.test(file)
      ? {
          key: `file:${path}`,
          url: `${upstream.cdn}${path}`,
          immutable: true,
          kind: 'file',
        }
      : undefined;
  }

  const npm = npmPath(path);
  if (!npm?.file || !FILE.test(npm.file) || !NPM_FILES.test(npm.file)) {
    return undefined;
  }

  return {
    key: `file:npm/${npm.name}@${npm.version}/${npm.file}`,
    url: `${upstream.cdn}npm/${npm.name}@${encodeURIComponent(npm.version)}/${npm.file}`,
    immutable: EXACT.test(npm.version),
    kind: 'file',
  };
}

/** The file listing of an exact package version or typeshed's commit. */
export function typeListingSource(
  path: string,
  upstream: TypeUpstream
): TypeSource | undefined {
  if (path.length > MAX_PATH) {
    return undefined;
  }

  const typeshed = path.match(TYPESHED);
  if (typeshed && !typeshed[2]) {
    return {
      key: `listing:${path}`,
      url: `${upstream.listing}${path}?structure=flat`,
      immutable: true,
      kind: 'listing',
    };
  }

  const npm = npmPath(path);
  return npm && !npm.file && EXACT.test(npm.version)
    ? {
        key: `listing:npm/${npm.name}@${npm.version}`,
        url: `${upstream.listing}npm/${npm.name}@${npm.version}?structure=flat`,
        immutable: true,
        kind: 'listing',
      }
    : undefined;
}

/** Crate names on crates.io: `serde_json`, `serde-wasm-bindgen`. */
const CRATE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * The public API of a crate (rustdoc JSON from docs.rs, turned into Rust
 * declarations by `rustdocStubs`), in a version or range (`1.0`, `latest`).
 */
export function typeCrateSource(
  name: string,
  version: string,
  upstream: TypeUpstream
): TypeSource | undefined {
  if (!CRATE.test(name) || !RANGE.test(version)) {
    return undefined;
  }

  const url = (v: string): string =>
    `${upstream.docs}crate/${name}/${encodeURIComponent(v)}/json`;
  const exact = EXACT.test(version);
  return {
    key: `crate:${name}@${version}`,
    url: url(version),
    immutable: exact,
    kind: 'crate',
    ...(exact ? { fallback: url(`^${version}`) } : {}),
    crate: { name, version },
  };
}

/** PyPI project names (`httpx`, `typing_extensions`, `Flask-SQLAlchemy`). */
const PYPI = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;
/** An exact PEP 440 version (`2.32.3`, `1.0.0rc1`, `2.0.post1`). */
const PYPI_EXACT =
  /^\d+(?:\.\d+)*(?:(?:a|b|rc)\d+)?(?:\.post\d+)?(?:\.dev\d+)?$/;

/**
 * The typed files (`.pyi`, `.py` of `py.typed` packages) of a Python
 * package's wheel on PyPI, in an exact version or the latest (ranges
 * like `>=2.31` aren't resolved: the latest release then).
 */
export function typePypiSource(
  name: string,
  version: string,
  upstream: TypeUpstream
): TypeSource | undefined {
  if (!PYPI.test(name)) {
    return undefined;
  }

  const normalized = name.toLowerCase().replaceAll(/[-_.]+/g, '-');
  const exact = PYPI_EXACT.test(version);
  return {
    key: `pypi:${normalized}@${exact ? version : 'latest'}`,
    url: exact
      ? `${upstream.pypi}pypi/${normalized}/${version}/json`
      : `${upstream.pypi}pypi/${normalized}/json`,
    immutable: exact,
    kind: 'pypi',
    crate: { name: normalized, version: exact ? version : 'latest' },
  };
}
