import type { LanguageVersion, ProjectFile } from '@vizscript/core';
import { configValue } from '@vizscript/core';

export const RUST_VERSION_FILES: ReadonlyArray<string> = [
  'Cargo.toml',
  'rust-toolchain.toml',
  'rust-toolchain',
];

/** `edition` or `rust-version` of `[package]`, following `.workspace`. */
function packageValue(
  manifest: ProjectFile,
  manifests: ReadonlyArray<ProjectFile>,
  key: string
): string | undefined {
  const own = configValue(manifest.text, 'package', key);
  const inherits =
    configValue(manifest.text, 'package', `${key}.workspace`) === 'true' ||
    (own !== undefined && /^\{.*\bworkspace\s*=\s*true\b/.test(own));
  if (!inherits) {
    return own;
  }

  const start = manifests.indexOf(manifest);
  for (const root of manifests.slice(start + 1)) {
    const value = configValue(root.text, 'workspace.package', key);
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

/** The toolchain's channel when it names a version (`1.80.0`). */
function toolchainVersion(file: ProjectFile): string | undefined {
  const channel = file.path.endsWith('.toml')
    ? configValue(file.text, 'toolchain', 'channel')
    : file.text.trim().split(/\r?\n/)[0];
  return channel && /^\d+\.\d+/.test(channel) ? channel : undefined;
}

/**
 * The Rust edition of the nearest crate (`[package] edition`, inherited
 * from the workspace, or Cargo's default 2015), with its `rust-version` or
 * a pinned toolchain.
 */
export function rustVersion(
  files: ReadonlyArray<ProjectFile>
): LanguageVersion | undefined {
  const manifests = files.filter((f) => f.path.endsWith('Cargo.toml'));
  const toolchain = files
    .filter((f) => !f.path.endsWith('Cargo.toml'))
    .map((f) => ({ file: f, version: toolchainVersion(f) }))
    .find((t) => t.version !== undefined);
  const crate =
    manifests.find(
      (m) => configValue(m.text, 'package', 'name') !== undefined
    ) ?? manifests[0];

  if (!crate) {
    return toolchain?.version === undefined
      ? undefined
      : {
          text: toolchain.version,
          detail: `channel ${toolchain.version}`,
          path: toolchain.file.path,
        };
  }

  const edition =
    packageValue(crate, manifests, 'edition') ??
    configValue(crate.text, 'workspace.package', 'edition');
  const rust =
    packageValue(crate, manifests, 'rust-version') ?? toolchain?.version;
  const editionText = `${edition ?? '2015'} edition`;
  return {
    text: rust ? `${rust} · ${editionText}` : editionText,
    detail: [
      edition ? `edition ${edition}` : 'no edition (Cargo uses 2015)',
      rust ? `Rust ${rust}` : undefined,
    ]
      .filter(Boolean)
      .join(', '),
    path: crate.path,
  };
}
