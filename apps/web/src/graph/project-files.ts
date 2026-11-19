/** Helpers to find a project's manifest and lockfile among its files. */

/** The folders of a path: `a/b/c.ts` → `['a', 'b']`. */
export function folderOf(path: string): string[] {
  return path.split('/').slice(0, -1);
}

/** The nearest file named one of `names`, walking up from `dirs`. */
export function nearest(
  files: ReadonlySet<string>,
  dirs: ReadonlyArray<string>,
  names: ReadonlyArray<string>
): string | undefined {
  const up = [...dirs];
  for (;;) {
    for (const name of names) {
      const path = [...up, name].join('/');
      if (files.has(path)) {
        return path;
      }
    }

    if (up.length === 0) {
      return undefined;
    }

    up.pop();
  }
}

/**
 * Whether a path names a file by its look: a last part with an extension
 * (`main.ts`, not `src`, `.github` or `LICENSE`).
 */
export function looksLikeFile(path: string): boolean {
  return /(?:^|\/)[^./][^/]*\.[^./]+$/.test(path);
}
