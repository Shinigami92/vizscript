import type { ProjectDependency } from '@vizscript/core';
import { NODE_BUILTINS } from './npm-declarations';
import { packageName } from './npm-types';
import { normalizeName } from './python-project';

/**
 * What My Script's Imports show next to a module: the version of the
 * library it comes from, how the manifest lists it, a built-in module of
 * the language, or a warning when no manifest lists the library.
 */
export interface ModuleInfo {
  /** Short text: `3.5.45`, `^3.5.0`, `built-in`. */
  label?: string;
  /** How it's listed, unless a plain runtime dependency: `dev`, `peer` … */
  badge?: string;
  /** The details, as a tooltip. */
  title: string;
  /** Something to fix (shown with a warning icon). */
  warning?: string;
  /** With a warning: the library to add to the manifest (`lodash`, `pyyaml`). */
  library?: string;
}

/** Import names of well-known Python distributions with another name. */
const PYTHON_DISTRIBUTIONS: Readonly<Record<string, string>> = {
  PIL: 'pillow',
  bs4: 'beautifulsoup4',
  cv2: 'opencv-python',
  dateutil: 'python-dateutil',
  dotenv: 'python-dotenv',
  jwt: 'pyjwt',
  sklearn: 'scikit-learn',
  yaml: 'pyyaml',
  google: 'protobuf',
  attr: 'attrs',
  magic: 'python-magic',
  serial: 'pyserial',
  usb: 'pyusb',
  zmq: 'pyzmq',
  Crypto: 'pycryptodome',
  OpenSSL: 'pyopenssl',
  win32api: 'pywin32',
};

/** The distribution a top-level Python module comes from (`PIL` → `pillow`). */
export function pythonDistribution(top: string): string {
  return PYTHON_DISTRIBUTIONS[top] ?? top;
}

const RUST_BUILTIN = new Set(['std', 'core', 'alloc', 'proc_macro', 'test']);
const RUST_LOCAL = new Set(['crate', 'self', 'super']);

/** Crates named `serde-json` are written `serde_json` in code. */
function crateInCode(name: string): string {
  return name.replaceAll('-', '_');
}

export interface ModuleContext {
  dependencies: ReadonlyArray<ProjectDependency>;
  /** The runtime of built-in modules: `Node.js`, `Python 3.12`. */
  runtime: string;
  /**
   * Python's standard library (from typeshed); without it, a module no
   * manifest lists is not warned about (it may be a standard one).
   */
  pythonStdlib?: ReadonlySet<string>;
}

type Source =
  | { kind: 'local' }
  | { kind: 'builtin' }
  | { kind: 'package'; name: string; dependency?: ProjectDependency }
  | { kind: 'unknown' };

/** Which library a module of `language` comes from. */
export function moduleSource(
  module: string,
  language: string,
  context: ModuleContext
): Source | undefined {
  const { dependencies } = context;
  switch (language) {
    case 'typescript': {
      if (/^(?:\.|\/)/.test(module)) {
        return { kind: 'local' };
      }

      const bare = module.replace(/^node:/, '').split('/')[0] ?? '';
      if (module.startsWith('node:') || NODE_BUILTINS.has(bare)) {
        return { kind: 'builtin' };
      }

      const name = packageName(module);
      return name
        ? {
            kind: 'package',
            name,
            dependency: dependencies.find((d) => d.name === name),
          }
        : undefined;
    }

    case 'python': {
      if (module.startsWith('.')) {
        return { kind: 'local' };
      }

      const top = module.split('.')[0] ?? '';
      if (context.pythonStdlib?.has(top)) {
        return { kind: 'builtin' };
      }

      const distribution = PYTHON_DISTRIBUTIONS[top];
      const names = new Set([top, distribution ?? top].map(normalizeName));
      const dependency = dependencies.find((d) =>
        names.has(normalizeName(d.name))
      );
      return dependency || (context.pythonStdlib?.size ?? 0) > 0
        ? { kind: 'package', name: distribution ?? top, dependency }
        : { kind: 'unknown' };
    }

    case 'rust': {
      const top = module.split('::')[0] ?? '';
      if (RUST_LOCAL.has(top)) {
        return { kind: 'local' };
      }

      if (RUST_BUILTIN.has(top)) {
        return { kind: 'builtin' };
      }

      return {
        kind: 'package',
        name: top,
        dependency: dependencies.find(
          (d) => crateInCode(d.alias ?? d.name) === top
        ),
      };
    }

    default: {
      return undefined;
    }
  }
}

const MANIFESTS: Readonly<Record<string, string>> = {
  typescript: 'package.json',
  python: 'pyproject.toml',
  rust: 'Cargo.toml',
};

/**
 * The info of one module; `undefined` for files of the repository,
 * modules it can't tell and languages without a package manager.
 */
export function moduleInfo(
  module: string,
  language: string,
  context: ModuleContext
): ModuleInfo | undefined {
  const found = moduleSource(module, language, context);
  if (!found || found.kind === 'local' || found.kind === 'unknown') {
    return undefined;
  }

  if (found.kind === 'builtin') {
    return {
      label: 'built-in',
      title: `${module}: part of ${context.runtime}`,
    };
  }

  const dependency = found.dependency;
  if (!dependency) {
    return {
      title: `${found.name} is in no ${MANIFESTS[language] ?? 'manifest'} of the project`,
      warning: `${found.name} is not listed as a dependency in ${MANIFESTS[language] ?? 'the manifest'}: it may only work because another package brings it along.`,
      library: found.name,
    };
  }

  if (dependency.local) {
    return {
      badge: 'workspace',
      title: `${dependency.name}: a package of this repository (${dependency.range} in ${dependency.manifest})`,
    };
  }

  const label = dependency.version ?? dependency.range;
  const how =
    dependency.kind === 'runtime'
      ? 'a dependency'
      : `a ${dependency.kind} dependency`;
  return {
    label,
    ...(dependency.kind === 'runtime' ? {} : { badge: dependency.kind }),
    title: `${dependency.name} ${label}${
      dependency.version ? ` (${dependency.range})` : ', no lockfile version'
    }: ${how} in ${dependency.manifest}`,
  };
}
