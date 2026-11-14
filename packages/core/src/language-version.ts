/** A project file that may state the language version, with its text. */
export interface ProjectFile {
  path: string;
  text: string;
}

/** The language version a project states, shown in the status bar. */
export interface LanguageVersion {
  /** Short text after the language name: `6.0.3`, `≥3.11`, `Godot 4.3`. */
  text: string;
  /** Where it comes from: `typescript 6.0.3 in devDependencies`. */
  detail: string;
  /** The file it was read from. */
  path: string;
}

/**
 * Paths of `names` in the folder of `path` and every folder above it that
 * exist, nearest folder first, in the order of `names` within a folder.
 */
export function projectFilesAbove(
  path: string,
  names: ReadonlyArray<string>,
  exists: (path: string) => boolean
): string[] {
  const found: string[] = [];
  const dirs = path.split('/').slice(0, -1);
  for (;;) {
    for (const name of names) {
      const candidate = [...dirs, name].join('/');
      if (exists(candidate) && !found.includes(candidate)) {
        found.push(candidate);
      }
    }

    if (dirs.length === 0) {
      return found;
    }

    dirs.pop();
  }
}

function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/**
 * A value of a TOML or INI file (`pyproject.toml`, `Cargo.toml`,
 * `project.godot`): `key` in `[section]`, or before the first section when
 * `section` is `''`. Quoted strings lose their quotes; other values are
 * returned as written, without a trailing comment.
 */
export function configValue(
  text: string,
  section: string,
  key: string
): string | undefined {
  const keyLine = new RegExp(String.raw`^\s*${escapeRegExp(key)}\s*=\s*(.*)$`);
  let current = '';
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[\s*([^\]]*?)\s*\]\s*(?:[#;].*)?$/.exec(line);
    if (header) {
      current = header[1] ?? '';
      continue;
    }

    if (current !== section) {
      continue;
    }

    const value = keyLine.exec(line)?.[1]?.trim();
    if (value === undefined) {
      continue;
    }

    const quoted = /^(["'])(.*?)\1/.exec(value);
    return quoted ? (quoted[2] ?? '') : value.replace(/\s+#.*$/, '').trim();
  }

  return undefined;
}

/**
 * A version range as a short text: `^5.9.2` → `5.9.2`, `>=3.9,<4` →
 * `≥3.9`, `==3.11.*` → `3.11.*`.
 */
export function shortVersion(range: string): string {
  const first = (range.split(/,|\|\|/)[0] ?? range).replaceAll(/\s+/g, '');
  return first
    .replace(/^>=/, '≥')
    .replace(/^<=/, '≤')
    .replace(/^(?:\^|~(?!=)|==|=|v)/, '');
}
