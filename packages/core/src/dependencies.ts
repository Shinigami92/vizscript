/**
 * Libraries a project depends on, read from its manifest (`package.json`,
 * `pyproject.toml`, `Cargo.toml`) and lockfile, in the same shape for every
 * ecosystem: the versions library types are fetched in, and what My Script
 * shows next to imports.
 */

/** How a manifest lists a dependency. */
export type DependencyKind = 'runtime' | 'dev' | 'peer' | 'optional' | 'build';

export interface ProjectDependency {
  name: string;
  /** The range as written (`^3.5.0`, `workspace:*`, `catalog:`). */
  range: string;
  /** The exact version from the lockfile, when there is one. */
  version?: string;
  kind: DependencyKind;
  /** Path of the manifest that lists it. */
  manifest: string;
  /** A package of the repository itself (`workspace:`, `link:`, `file:`). */
  local?: boolean;
}
