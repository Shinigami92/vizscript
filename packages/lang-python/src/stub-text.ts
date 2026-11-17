/**
 * typeshed's stubs (`.pyi`) prepared for the parser and the type lookup:
 * the branches of `sys.version_info` / `sys.platform` checks that apply,
 * private type variables and aliases as `Any`, and module functions that
 * are a private instance's methods (`seed = _inst.seed`) as functions.
 */

/** The platform stubs are read for (`sys.platform`). */
const PLATFORM = 'linux';

/** Python version `3.12` → `[3, 12]`. */
function versionParts(version: string): [number, number] {
  const [major, minor] = version.split('.').map((part) => Number(part));
  return [
    major !== undefined && Number.isFinite(major) ? major : 3,
    minor !== undefined && Number.isFinite(minor) ? minor : 0,
  ];
}

function compare(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }

  return 0;
}

function versionHolds(op: string, diff: number): boolean {
  switch (op) {
    case '>=': {
      return diff >= 0;
    }

    case '<=': {
      return diff <= 0;
    }

    case '>': {
      return diff > 0;
    }

    case '<': {
      return diff < 0;
    }

    case '==': {
      return diff === 0;
    }

    default: {
      return diff !== 0;
    }
  }
}

/** One condition of a check; `undefined` when it isn't one we know. */
function atom(text: string, version: [number, number]): boolean | undefined {
  const negated = text.match(/^not\s+(.+)$/);
  if (negated) {
    const inner = atom(negated[1]?.trim() ?? '', version);
    return inner === undefined ? undefined : !inner;
  }

  const versionCheck = text.match(
    /^sys\.version_info\s*(>=|<=|==|!=|>|<)\s*\(([\d,\s]+)\)$/
  );
  if (versionCheck) {
    const wanted = (versionCheck[2] ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p !== '')
      .map(Number);
    const diff = compare(version.slice(0, wanted.length), wanted);
    return versionHolds(versionCheck[1] ?? '', diff);
  }

  const platform = text.match(/^sys\.platform\s*(==|!=)\s*["'](\w+)["']$/);
  if (platform) {
    return (platform[2] === PLATFORM) === (platform[1] === '==');
  }

  const startsWith = text.match(
    /^sys\.platform\.startswith\(\s*["'](\w+)["']\s*\)$/
  );
  return startsWith ? PLATFORM.startsWith(startsWith[1] ?? '') : undefined;
}

/** A check made of conditions with `and` / `or` (unknown parts: true). */
function holds(condition: string, version: [number, number]): boolean {
  return condition
    .split(/\s+or\s+/)
    .some((part) =>
      part
        .split(/\s+and\s+/)
        .every(
          (piece) =>
            atom(piece.trim().replace(/^\((.*)\)$/, '$1'), version) !== false
        )
    );
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * Lines that continue the one before (inside a `"""` string or after a
 * `\`): their indentation means nothing.
 */
function continuations(lines: ReadonlyArray<string>): Set<number> {
  const found = new Set<number>();
  let quote: string | undefined;
  for (const [i, line] of lines.entries()) {
    if (quote !== undefined || lines[i - 1]?.trimEnd().endsWith('\\')) {
      found.add(i);
    }

    for (const match of line.matchAll(/"""|'''/g)) {
      if (quote === undefined) {
        quote = match[0];
      } else if (quote === match[0]) {
        quote = undefined;
      }
    }
  }

  return found;
}

/** The end (exclusive) of the block whose header is at `start`. */
function blockEnd(
  lines: ReadonlyArray<string>,
  start: number,
  continued: ReadonlySet<number>
): number {
  const indent = indentOf(lines[start] ?? '');
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end] ?? '';
    if (line.trim() !== '' && !continued.has(end) && indentOf(line) <= indent) {
      break;
    }

    end++;
  }

  return end;
}

/** The lines of a block's body, at the header's indentation. */
function dedented(
  lines: ReadonlyArray<string>,
  from: number,
  to: number,
  indent: number,
  continued: ReadonlySet<number>
): string[] {
  const body = lines.slice(from, to);
  const first = body.find((line) => line.trim() !== '');
  const shift = first ? indentOf(first) - indent : 0;
  return body.map((line, i) =>
    line.trim() === '' || continued.has(from + i)
      ? line
      : line.slice(Math.min(shift, indentOf(line)))
  );
}

const CHECK = /^(\s*)(if|elif)\s+(.*sys\.(?:version_info|platform).*):\s*$/;

/** One pass over the checks; nested ones are left for the next pass. */
function resolveChecks(
  lines: ReadonlyArray<string>,
  version: [number, number]
): { lines: string[]; changed: boolean } {
  const out: string[] = [];
  const continued = continuations(lines);
  let changed = false;
  let i = 0;
  while (i < lines.length) {
    const header = continued.has(i) ? null : (lines[i] ?? '').match(CHECK);
    if (!header || header[2] !== 'if') {
      out.push(lines[i] ?? '');
      i++;
      continue;
    }

    changed = true;
    const indent = header[1]?.length ?? 0;
    let chosen: string[] | undefined;
    let at = i;
    let condition: string | undefined = header[3] ?? '';
    for (;;) {
      const end = blockEnd(lines, at, continued);
      if (!chosen && (condition === undefined || holds(condition, version))) {
        chosen = dedented(lines, at + 1, end, indent, continued);
      }

      at = end;
      const next = lines[at] ?? '';
      if (indentOf(next) !== indent || next.trim() === '') {
        break;
      }

      const elif = next.match(CHECK);
      if (elif?.[2] === 'elif') {
        condition = elif[3] ?? '';
      } else if (/^\s*(?:elif\s.*|else\s*):\s*$/.test(next)) {
        // `else`, or an `elif` about something else: taken when nothing
        // was.
        condition = undefined;
      } else {
        break;
      }
    }

    // A body must not end up empty (`class X:` with only checks).
    out.push(...(chosen ?? [`${' '.repeat(indent)}...`]));
    i = at;
  }

  return { lines: out, changed };
}

/** How many brackets a line opens (negative: closes). */
function depthChange(line: string): number {
  let depth = 0;
  for (const char of line.replace(/#.*$/, '')) {
    if (char === '(' || char === '[' || char === '{') {
      depth++;
    } else if (char === ')' || char === ']' || char === '}') {
      depth--;
    }
  }

  return depth;
}

/**
 * Private type variables (`_T = TypeVar("_T")`), aliases
 * (`_DataType: TypeAlias = …`) and private names of other stubs say nothing
 * the lookup can use: `Any`.
 */
function withoutPrivateTypes(text: string): string {
  const names = new Set<string>();
  // Open brackets of a dropped declaration that spans lines.
  let open = 0;
  const kept = text
    .split('\n')
    .filter((line) => {
      if (open > 0) {
        open += depthChange(line);
        return false;
      }

      const declared =
        line.match(/^(_\w+)\s*=\s*(?:TypeVar|ParamSpec|TypeVarTuple)\(/) ??
        line.match(/^(_\w+)\s*:\s*TypeAlias\s*=/);
      if (declared?.[1]) {
        names.add(declared[1]);
        open = Math.max(0, depthChange(line));
        return false;
      }

      // Private names of other stubs (`from .reader import _ReadStream`).
      const imported = line.match(/^from\s+\S+\s+import\s+([^()]+)$/);
      if (imported?.[1]) {
        const privateNames = imported[1]
          .split(',')
          .map(
            (part) =>
              part
                .trim()
                .split(/\s+as\s+/)
                .at(-1) ?? ''
          )
          .filter((name) => /^_[A-Za-z]\w*$/.test(name));
        for (const name of privateNames) {
          names.add(name);
        }
      }

      return true;
    })
    .join('\n');
  if (names.size === 0) {
    return kept;
  }

  const pattern = new RegExp(String.raw`\b(?:${[...names].join('|')})\b`, 'g');
  return kept.replaceAll(pattern, 'Any');
}

/** The text of method `name` of class `cls` (its first definition). */
function methodText(
  lines: ReadonlyArray<string>,
  cls: string,
  name: string
): string[] | undefined {
  const start = lines.findIndex((line) =>
    new RegExp(String.raw`^class ${cls}\b`).test(line)
  );
  if (start === -1) {
    return undefined;
  }

  const end = blockEnd(lines, start, continuations(lines));
  const first = lines.findIndex(
    (line, i) =>
      i > start &&
      i < end &&
      new RegExp(String.raw`^\s+def ${name}\(`).test(line)
  );
  if (first === -1) {
    return undefined;
  }

  const last = lines.findIndex(
    (line, i) => i >= first && i < end && /\.\.\.\s*(?:#.*)?$/.test(line)
  );
  return last === -1 ? undefined : lines.slice(first, last + 1);
}

/**
 * `seed = _inst.seed` with `_inst: Random`: the method as a function of
 * the module (`def seed(a = None, …)`), so it gets its pins.
 */
function instanceMethods(text: string): string {
  const lines = text.split('\n');
  const instances = new Map<string, string>();
  for (const line of lines) {
    const declared = line.match(/^(_\w+)\s*:\s*(\w+)\s*$/);
    if (declared?.[1] && declared[2]) {
      instances.set(declared[1], declared[2]);
    }
  }

  if (instances.size === 0) {
    return text;
  }

  return lines
    .flatMap((line) => {
      const alias = line.match(/^(\w+)\s*=\s*(_\w+)\.(\w+)\s*$/);
      const cls = alias?.[2] ? instances.get(alias[2]) : undefined;
      const method =
        alias?.[1] && alias[3] && cls
          ? methodText(lines, cls, alias[3])
          : undefined;
      if (!alias?.[1] || !method) {
        return [line];
      }

      const shift = indentOf(method[0] ?? '');
      return method
        .map((part) => part.slice(Math.min(shift, indentOf(part))))
        .join('\n')
        .replace(/^def \w+\(\s*self\s*(?:,\s*|(?=\)))/, `def ${alias[1]}(`)
        .split('\n');
    })
    .join('\n');
}

/**
 * A typeshed stub ready for the parser, for Python `version` (`3.12`):
 * see the module comment.
 */
export function preparePythonStub(text: string, version = '3.14'): string {
  const parts = versionParts(version);
  let lines = text.split('\n');
  for (let pass = 0; pass < 16; pass++) {
    const result = resolveChecks(lines, parts);
    lines = result.lines;
    if (!result.changed) {
      break;
    }
  }

  return instanceMethods(withoutPrivateTypes(lines.join('\n')));
}
