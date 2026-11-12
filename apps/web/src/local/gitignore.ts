/** Whether a path (relative to the folder, `/`-separated) is ignored. */
export type IgnoreMatcher = (path: string, isDir: boolean) => boolean;

/** Folders that are never listed, whatever `.gitignore` says. */
const ALWAYS_IGNORED = new Set(['.git', 'node_modules', '.DS_Store']);

interface Rule {
  regex: RegExp;
  negate: boolean;
  dirOnly: boolean;
}

function escapeRegex(char: string): string {
  return /[.+^${}()|\\]/.test(char) ? `\\${char}` : char;
}

/** Converts one glob of a `.gitignore` line into a regex body. */
function globToRegex(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i] ?? '';
    if (char === '*') {
      if (glob[i + 1] === '*') {
        // `**/` matches zero or more folders, a trailing `**` everything.
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') {
      out += '[^/]';
    } else if (char === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end === -1) {
        out += '\\[';
      } else {
        out += glob.slice(i, end + 1).replace(/^\[!/, '[^');
        i = end;
      }
    } else if (char === '\\' && i + 1 < glob.length) {
      out += escapeRegex(glob[i + 1] ?? '');
      i += 1;
    } else {
      out += escapeRegex(char);
    }
  }

  return out;
}

function parseRule(line: string): Rule | undefined {
  let pattern = line.replace(/(?<!\\)\s+$/, '');
  if (pattern === '' || pattern.startsWith('#')) {
    return undefined;
  }

  const negate = pattern.startsWith('!');
  if (negate) {
    pattern = pattern.slice(1);
  }

  const dirOnly = pattern.endsWith('/');
  pattern = pattern.replace(/\/+$/, '');
  // A slash at the start or in the middle anchors the pattern to the root.
  const anchored = pattern.includes('/');
  pattern = pattern.replace(/^\//, '');
  if (pattern === '') {
    return undefined;
  }

  const body = globToRegex(pattern);
  return {
    regex: new RegExp(anchored ? `^${body}$` : `(?:^|/)${body}$`),
    negate,
    dirOnly,
  };
}

/**
 * Matcher for the rules of a root `.gitignore` (enough for listing a
 * project: comments, `!` negation, `/` anchoring, `dir/`, `*`, `**`, `?`
 * and `[…]`). Parents are not checked: the caller doesn't descend into
 * ignored folders.
 */
export function gitignoreMatcher(source: string): IgnoreMatcher {
  const rules = source
    .split(/\r?\n/)
    .map(parseRule)
    .filter((rule): rule is Rule => rule !== undefined);

  return (path, isDir) => {
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (ALWAYS_IGNORED.has(name)) {
      return true;
    }

    let ignored = false;
    for (const rule of rules) {
      if ((!rule.dirOnly || isDir) && rule.regex.test(path)) {
        ignored = !rule.negate;
      }
    }

    return ignored;
  };
}
