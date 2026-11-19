import { describe, expect, it } from 'vitest';
import {
  manifestDependencies,
  npmDependencies,
  npmLockVersions,
  packageVersion,
  pnpmVersions,
  yarnVersions,
} from '../src/graph/npm-project';

const PNPM = `---
lockfileVersion: '9.0'

importers:

  .:
    packageManagerDependencies:
      pnpm:
        specifier: 12.16.1
        version: 12.16.1

---
lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      vitest:
        specifier: ^4.0.0
        version: 4.1.2(@types/node@24.0.1)

  apps/web:
    dependencies:
      '@vizscript/core':
        specifier: workspace:*
        version: link:../../packages/core
      vue:
        specifier: ~3.5.45
        version: 3.5.45(typescript@6.0.3)

packages:

  vue@3.5.45:
    resolution: {integrity: sha512-x}
`;

describe('manifestDependencies', () => {
  it('reads every section with its kind; repository packages are local', () => {
    const deps = manifestDependencies(
      JSON.stringify({
        dependencies: { vue: '^3.5.0', '@app/core': 'workspace:*' },
        devDependencies: { vitest: '^4.0.0', vue: '^3.4.0', pg: '^8.0.0' },
        peerDependencies: { react: '>=18', pg: '>=8' },
        optionalDependencies: { fsevents: '^2.3.0' },
      }),
      'package.json'
    );
    // A peer that is a devDependency too (for the library's tests) is a peer.
    expect(deps.map((d) => [d.name, d.range, d.kind, d.local])).toEqual([
      ['vue', '^3.5.0', 'runtime', undefined],
      ['@app/core', 'workspace:*', 'runtime', true],
      ['react', '>=18', 'peer', undefined],
      ['pg', '>=8', 'peer', undefined],
      ['fsevents', '^2.3.0', 'optional', undefined],
      ['vitest', '^4.0.0', 'dev', undefined],
    ]);
    expect(manifestDependencies('not json', 'package.json')).toEqual([]);
  });
});

describe('lockfiles', () => {
  it('reads pnpm importers without peer suffixes, in any document', () => {
    expect([...pnpmVersions(PNPM, 'apps/web')]).toEqual([
      ['@vizscript/core', 'link:../../packages/core'],
      ['vue', '3.5.45'],
    ]);
    expect([...pnpmVersions(PNPM, '.')]).toEqual([
      ['pnpm', '12.16.1'],
      ['vitest', '4.1.2'],
    ]);
    // lockfile v5: the version right after the name.
    const v5 =
      'importers:\n  .:\n    dependencies:\n      vue: 3.2.0_typescript@4.9.0\n';
    expect([...pnpmVersions(v5, '.')]).toEqual([['vue', '3.2.0']]);
  });

  it('reads package-lock.json, nested copies before hoisted ones', () => {
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': {},
        'node_modules/vue': { version: '3.4.0' },
        'node_modules/vue/node_modules/x': { version: '1.0.0' },
        'apps/web/node_modules/vue': { version: '3.5.1' },
      },
    });
    expect(npmLockVersions(lock, '.').get('vue')).toBe('3.4.0');
    expect(npmLockVersions(lock, 'apps/web').get('vue')).toBe('3.5.1');
    expect(npmLockVersions(lock, '.').has('vue/node_modules/x')).toBe(false);
  });

  it('reads yarn classic and berry by name and range', () => {
    const classic =
      '"vue@^3.5.0", vue@^3.5.1:\n  version "3.5.13"\n  resolved "x"\n';
    expect(yarnVersions(classic).get('vue@^3.5.0')).toBe('3.5.13');
    expect(yarnVersions(classic).get('vue@^3.5.1')).toBe('3.5.13');
    const berry = '"vue@npm:^3.5.0":\n  version: 3.5.13\n';
    expect(yarnVersions(berry).get('vue@^3.5.0')).toBe('3.5.13');
  });
});

describe('packageVersion', () => {
  const files = new Map<string, string>([
    ['pnpm-lock.yaml', PNPM],
    ['package.json', JSON.stringify({ devDependencies: { vitest: '^4.0.0' } })],
    [
      'apps/web/package.json',
      JSON.stringify({
        dependencies: {
          vue: '~3.5.45',
          '@vizscript/core': 'workspace:*',
          pinia: 'catalog:',
        },
      }),
    ],
  ]);
  const read = async (path: string): Promise<string> => files.get(path) ?? '';
  const version = (name: string): Promise<string> =>
    packageVersion(new Set(files.keys()), read, 'apps/web/src/main.ts', name);

  it('takes the exact version of the lockfile', async () => {
    expect(await version('vue')).toBe('3.5.45');
  });

  it('looks in the manifests further up (a monorepo root)', async () => {
    expect(await version('vitest')).toBe('4.1.2');
  });

  it('fetches nothing for repository packages, latest for the unknown', async () => {
    expect(await version('@vizscript/core')).toBe('');
    expect(await version('left-pad')).toBe('latest');
    // `catalog:` means nothing to the registry, and the lock has no entry.
    expect(await version('pinia')).toBe('latest');
  });

  it('lists the nearest manifest with versions and kinds', async () => {
    const deps = await npmDependencies(
      new Set(files.keys()),
      read,
      'apps/web/src/main.ts'
    );
    expect(deps.map((d) => [d.name, d.version, d.manifest])).toEqual([
      ['vue', '3.5.45', 'apps/web/package.json'],
      ['@vizscript/core', undefined, 'apps/web/package.json'],
      ['pinia', undefined, 'apps/web/package.json'],
    ]);
  });
});
