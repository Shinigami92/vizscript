import type { DependencyKind } from '@vizscript/core';

/**
 * Adding a dependency to a manifest with a minimal edit: the file keeps its
 * formatting, order and comments (never written anew), the entry goes in
 * alphabetical order, and the version follows the file's style (`^`, `~`
 * or exact pins).
 */

// ------------------------------------------------------------------ npm

const NPM_SECTIONS: Readonly<Partial<Record<DependencyKind, string>>> = {
  runtime: 'dependencies',
  dev: 'devDependencies',
  peer: 'peerDependencies',
  optional: 'optionalDependencies',
};

interface Member {
  key: string;
  /** Where the key's string starts. */
  keyStart: number;
  valueStart: number;
  /** Just after the value. */
  valueEnd: number;
}

function skipSpace(text: string, i: number): number {
  let at = i;
  while (at < text.length && /\s/.test(text[at] ?? '')) {
    at++;
  }

  return at;
}

/** The end of the JSON string starting at `i` (its opening quote). */
function stringEnd(text: string, i: number): number {
  let at = i + 1;
  while (at < text.length && text[at] !== '"') {
    at += text[at] === '\\' ? 2 : 1;
  }

  return at + 1;
}

/** The end of the JSON value starting at `i`. */
function valueEnd(text: string, i: number): number {
  const first = text[i];
  if (first === '"') {
    return stringEnd(text, i);
  }

  if (first !== '{' && first !== '[') {
    let at = i;
    while (at < text.length && !/[,}\]\s]/.test(text[at] ?? '')) {
      at++;
    }

    return at;
  }

  let depth = 0;
  let at = i;
  while (at < text.length) {
    const char = text[at];
    if (char === '"') {
      at = stringEnd(text, at);
      continue;
    }

    if (char === '{' || char === '[') {
      depth++;
    } else if (char === '}' || char === ']') {
      depth--;
      if (depth === 0) {
        return at + 1;
      }
    }

    at++;
  }

  return at;
}

/** The members of the object whose `{` is at `open`. */
function members(text: string, open: number): Member[] {
  const found: Member[] = [];
  let at = skipSpace(text, open + 1);
  while (at < text.length && text[at] === '"') {
    const keyEnd = stringEnd(text, at);
    const key = JSON.parse(text.slice(at, keyEnd)) as string;
    const colon = skipSpace(text, keyEnd);
    const start = skipSpace(text, colon + 1);
    const end = valueEnd(text, start);
    found.push({ key, keyStart: at, valueStart: start, valueEnd: end });
    at = skipSpace(text, end);
    if (text[at] === ',') {
      at = skipSpace(text, at + 1);
    }
  }

  return found;
}

/** The indentation of the line `offset` is on. */
function lineIndent(text: string, offset: number): string {
  const start = text.lastIndexOf('\n', offset - 1) + 1;
  return text.slice(start).match(/^[ \t]*/)?.[0] ?? '';
}

/** The file's indentation unit (two spaces when it has none). */
function indentUnit(text: string): string {
  return text.match(/\n([ \t]+)\S/)?.[1] ?? '  ';
}

/** `^`, `~` or `''` (exact): what most of the file's versions use. */
export function npmRangeStyle(text: string): '^' | '~' | '' {
  const counts = { '^': 0, '~': 0, '': 0 };
  for (const match of text.matchAll(/"\s*:\s*"([\^~]?)\d/g)) {
    counts[(match[1] ?? '') as '^' | '~' | '']++;
  }

  const best = (
    Object.entries(counts) as Array<['^' | '~' | '', number]>
  ).toSorted((a, b) => b[1] - a[1])[0];
  return best && best[1] > 0 ? best[0] : '^';
}

/**
 * `package.json` with `name` added to the section of `kind` (made when
 * missing) in `version`, written like the section's other versions (`^`,
 * `~` or exact; the file's when the section is empty); unchanged when that
 * section lists it already.
 */
export function addNpmDependency(
  text: string,
  name: string,
  version: string,
  kind: DependencyKind
): string {
  const section = NPM_SECTIONS[kind] ?? 'dependencies';
  const rootOpen = text.indexOf('{');
  if (rootOpen === -1) {
    return text;
  }

  const unit = indentUnit(text);
  const root = members(text, rootOpen);
  const target = root.find((m) => m.key === section);
  const sectionText = target
    ? text.slice(target.valueStart, target.valueEnd)
    : '';
  const style = npmRangeStyle(
    /"\s*:\s*"[\^~]?\d/.test(sectionText) ? sectionText : text
  );
  const entry = `${JSON.stringify(name)}: ${JSON.stringify(`${style}${version}`)}`;
  if (!target) {
    // A new section at the end of the file's object.
    const last = root.at(-1);
    const block = `${JSON.stringify(section)}: {\n${unit}${unit}${entry}\n${unit}}`;
    return last
      ? `${text.slice(0, last.valueEnd)},\n${unit}${block}${text.slice(last.valueEnd)}`
      : `${text.slice(0, rootOpen + 1)}\n${unit}${block}\n${text.slice(rootOpen + 1)}`;
  }

  const inner = members(text, target.valueStart);
  if (inner.some((m) => m.key === name)) {
    return text;
  }

  const sectionIndent = lineIndent(text, target.keyStart);
  const first = inner[0];
  if (!first) {
    return `${text.slice(0, target.valueStart)}{\n${sectionIndent}${unit}${entry}\n${sectionIndent}}${text.slice(target.valueEnd)}`;
  }

  const indent = lineIndent(text, first.keyStart);
  const next = inner.find((m) => m.key > name);
  if (next) {
    return `${text.slice(0, next.keyStart)}${entry},\n${indent}${text.slice(next.keyStart)}`;
  }

  const last = inner.at(-1) ?? first;
  return `${text.slice(0, last.valueEnd)},\n${indent}${entry}${text.slice(last.valueEnd)}`;
}

// ------------------------------------------------------------------ TOML

interface TomlTable {
  /** Line index of the `[header]`. */
  header: number;
  /** Line index after the table's last line. */
  end: number;
}

function tomlTable(
  lines: ReadonlyArray<string>,
  name: string
): TomlTable | undefined {
  const header = lines.findIndex((line) => line.trim() === `[${name}]`);
  if (header === -1) {
    return undefined;
  }

  let end = header + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end] ?? '')) {
    end++;
  }

  // Blank lines before the next table stay its separator.
  while (end > header + 1 && (lines[end - 1] ?? '').trim() === '') {
    end--;
  }

  return { header, end };
}

const TOML_KEY = /^\s*([A-Za-z0-9_.-]+|"[^"]+")\s*=/;

/** `key = …` added to a table in alphabetical order (made when missing). */
function addTomlKey(
  text: string,
  table: string,
  key: string,
  value: string
): string {
  const lines = text.split('\n');
  const line = `${key} = ${value}`;
  const found = tomlTable(lines, table);
  if (!found) {
    const body = text.replace(/\n*$/, '');
    return `${body}\n\n[${table}]\n${line}\n`;
  }

  const keys: Array<{ index: number; key: string }> = [];
  for (let i = found.header + 1; i < found.end; i++) {
    const match = (lines[i] ?? '').match(TOML_KEY);
    if (match?.[1]) {
      keys.push({ index: i, key: match[1].replaceAll('"', '') });
    }
  }

  if (keys.some((k) => k.key === key)) {
    return text;
  }

  const next = keys.find((k) => k.key > key);
  lines.splice(next ? next.index : found.end, 0, line);
  return lines.join('\n');
}

/** `Cargo.toml` with `name = "version"` in the table of `kind`. */
export function addCargoDependency(
  text: string,
  name: string,
  version: string,
  kind: DependencyKind
): string {
  const table =
    kind === 'dev'
      ? 'dev-dependencies'
      : kind === 'build'
        ? 'build-dependencies'
        : 'dependencies';
  return addTomlKey(
    text,
    table,
    name,
    kind === 'optional'
      ? `{ version = ${JSON.stringify(version)}, optional = true }`
      : JSON.stringify(version)
  );
}

/**
 * A string added to the array `key = [ … ]` of a TOML table, keeping a
 * multi-line array's layout (one item per line) or a one-line one.
 */
function addTomlArrayItem(
  text: string,
  table: string,
  key: string,
  item: string
): string {
  const lines = text.split('\n');
  const found = tomlTable(lines, table);
  const quoted = JSON.stringify(item);
  if (!found) {
    const body = text.replace(/\n*$/, '');
    return `${body}\n\n[${table}]\n${key} = [\n    ${quoted},\n]\n`;
  }

  const opening = new RegExp(`^\\s*${key.replaceAll('-', '\\-')}\\s*=\\s*\\[`);
  const start = lines.findIndex(
    (line, i) => i > found.header && i < found.end && opening.test(line)
  );
  if (start === -1) {
    lines.splice(found.end, 0, `${key} = [`, `    ${quoted},`, ']');
    return lines.join('\n');
  }

  const first = lines[start] ?? '';
  const closeAt = first.lastIndexOf(']');
  if (closeAt > first.indexOf('[')) {
    // One line: `dependencies = ["a", "b"]`, or `[]`.
    const inside = first.slice(first.indexOf('[') + 1, closeAt).trim();
    lines[start] = `${first.slice(0, closeAt).replace(/\s*$/, '')}${
      inside === '' ? '' : ', '
    }${quoted}${first.slice(closeAt)}`;
    return lines.join('\n');
  }

  let close = start + 1;
  while (close < lines.length && !/^\s*\]/.test(lines[close] ?? '')) {
    close++;
  }

  const itemIndent =
    close > start + 1
      ? ((lines[start + 1] ?? '').match(/^\s*/)?.[0] ?? '    ')
      : '    ';
  const previous = lines[close - 1] ?? '';
  if (close > start + 1 && !/,\s*(?:#.*)?$/.test(previous)) {
    lines[close - 1] = previous.replace(/(\S)(\s*(?:#.*)?)$/, '$1,$2');
  }

  lines.splice(close, 0, `${itemIndent}${quoted},`);
  return lines.join('\n');
}

/**
 * `pyproject.toml` (PEP 621, PEP 735 groups for dev, Poetry) or a
 * `requirements*.txt` with `name` added.
 */
export function addPythonDependency(
  path: string,
  text: string,
  name: string,
  version: string,
  kind: DependencyKind
): string {
  const spec = `${name}>=${version}`;
  if (!path.endsWith('.toml')) {
    const wanted = name.toLowerCase();
    const listed = text
      .split('\n')
      .some((line) => line.trim().toLowerCase().startsWith(wanted));
    return listed ? text : `${text.replace(/\n*$/, '')}\n${spec}\n`;
  }

  if (
    /^\s*\[tool\.poetry\.dependencies\]/m.test(text) &&
    !/^\s*\[project\]/m.test(text)
  ) {
    return addTomlKey(
      text,
      kind === 'dev'
        ? 'tool.poetry.group.dev.dependencies'
        : 'tool.poetry.dependencies',
      name,
      JSON.stringify(`^${version}`)
    );
  }

  return kind === 'dev'
    ? addTomlArrayItem(text, 'dependency-groups', 'dev', spec)
    : addTomlArrayItem(text, 'project', 'dependencies', spec);
}
