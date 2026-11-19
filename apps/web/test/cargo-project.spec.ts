import { describe, expect, it } from 'vitest';
import {
  cargoDependencies,
  cargoLockVersions,
  localLibraries,
  rustDependencies,
} from '../src/graph/cargo-project';

const ROOT = `
[workspace]
members = ["crates/app"]

[workspace.dependencies]
tokio = { version = "1.40", features = ["full"] }
serde = "1.0"
`;

const APP = `
[package]
name = "app"

[dependencies]
serde = { workspace = true, features = ["derive"] }
tokio.workspace = true
json = { package = "serde_json", version = "1" }
shared = { path = "../shared" }
fancy = { git = "https://example.test/fancy.git" }
rand = { version = "0.8", optional = true }

[dev-dependencies]
insta = "1.39"

[build-dependencies]
cc = "1"

[target.'cfg(windows)'.dependencies]
winapi = "0.3"
`;

const LOCK = `
version = 4

[[package]]
name = "serde"
version = "1.0.210"

[[package]]
name = "serde_json"
version = "1.0.128"

[[package]]
name = "tokio"
version = "1.40.0"
`;

describe('Cargo manifests', () => {
  it('reads every section, renames, paths, git and per target', () => {
    const deps = cargoDependencies(APP, 'crates/app/Cargo.toml', {
      tokio: { version: '1.40' },
      serde: '1.0',
    });
    expect(
      deps.map((d) => [d.name, d.range, d.kind, d.local, d.alias])
    ).toEqual([
      ['serde', '1.0', 'runtime', undefined, undefined],
      ['tokio', '1.40', 'runtime', undefined, undefined],
      ['serde_json', '1', 'runtime', undefined, 'json'],
      ['shared', '*', 'runtime', true, undefined],
      [
        'fancy',
        'git+https://example.test/fancy.git',
        'runtime',
        undefined,
        undefined,
      ],
      ['rand', '0.8', 'optional', undefined, undefined],
      ['insta', '1.39', 'dev', undefined, undefined],
      ['cc', '1', 'build', undefined, undefined],
      ['winapi', '0.3', 'runtime', undefined, undefined],
    ]);
  });

  it('reads Cargo.lock', () => {
    expect(cargoLockVersions(LOCK).get('serde_json')).toBe('1.0.128');
  });

  it('inherits from the workspace root and takes the lock versions', async () => {
    const files = new Map([
      ['Cargo.toml', ROOT],
      ['Cargo.lock', LOCK],
      ['crates/app/Cargo.toml', APP],
    ]);
    const deps = await rustDependencies(
      new Set(files.keys()),
      async (path) => files.get(path) ?? '',
      'crates/app/src/main.rs'
    );
    expect(deps.slice(0, 4).map((d) => [d.name, d.range, d.version])).toEqual([
      ['serde', '1.0', '1.0.210'],
      ['tokio', '1.40', '1.40.0'],
      ['serde_json', '1', '1.0.128'],
      ['shared', '*', undefined],
    ]);
  });
});

function libraries(
  files: Record<string, string>,
  path: string
): ReturnType<typeof localLibraries> {
  return localLibraries(
    new Set(Object.keys(files)),
    async (p) => files[p] ?? '',
    path
  );
}

describe('localLibraries', () => {
  it('names the own library by the package, with _ for -', async () => {
    expect(
      await libraries(
        {
          'Cargo.toml': '[package]\nname = "my-tool"\n',
          'src/lib.rs': '',
          'src/main.rs': '',
        },
        'src/cli/run.rs'
      )
    ).toEqual([{ name: 'my_tool', root: 'src/lib.rs' }]);
  });

  it('follows [lib] name and path', async () => {
    expect(
      await libraries(
        {
          'crates/x/Cargo.toml':
            '[package]\nname = "x"\n\n[lib]\nname = "xlib"\npath = "src/x.rs"\n',
          'crates/x/src/x.rs': '',
        },
        'crates/x/src/main.rs'
      )
    ).toEqual([{ name: 'xlib', root: 'crates/x/src/x.rs' }]);
  });

  it('adds path dependencies, also from the workspace', async () => {
    expect(
      await libraries(
        {
          'Cargo.toml':
            '[workspace]\nmembers = ["crates/*"]\n\n[workspace.dependencies]\nshared-core = { path = "crates/core" }\n',
          'crates/app/Cargo.toml':
            '[package]\nname = "app"\n\n[dependencies]\nshared-core = { workspace = true }\nutil = { path = "../util-lib", package = "util-lib" }\nserde = "1"\n',
          'crates/app/src/main.rs': '',
          'crates/core/Cargo.toml': '[package]\nname = "shared-core"\n',
          'crates/core/src/lib.rs': '',
          'crates/util-lib/Cargo.toml': '[package]\nname = "util-lib"\n',
          'crates/util-lib/src/lib.rs': '',
        },
        'crates/app/src/main.rs'
      )
    ).toEqual([
      { name: 'shared_core', root: 'crates/core/src/lib.rs' },
      // Renamed: code names it by its key.
      { name: 'util', root: 'crates/util-lib/src/lib.rs' },
    ]);
  });

  it('is empty for a crate without a library', async () => {
    expect(
      await libraries(
        { 'Cargo.toml': '[package]\nname = "app"\n', 'src/main.rs': '' },
        'src/main.rs'
      )
    ).toEqual([]);
  });
});
