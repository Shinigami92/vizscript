import type { ModuleReference } from '@vizscript/core';
import { parseRustTree } from './convert';
import { rustUses } from './imports';
import { itemPath } from './paths';

/** Marker file of a crate: `crate::` paths start in its `src` folder. */
const CRATE_ANCHOR = 'Cargo.toml';

/** Files of a module path below `prefix` (`./`, `../`, `/src/`). */
function moduleFiles(prefix: string, parts: ReadonlyArray<string>): string[] {
  if (parts.length === 0) {
    return prefix === '/src/'
      ? ['/src/lib.rs', '/src/main.rs']
      : [`${prefix}mod.rs`];
  }

  const path = prefix + parts.join('/');
  return [`${path}.rs`, `${path}/mod.rs`];
}

/** Whether a file is the root of its module folder. */
function isFolderModule(fileName: string): boolean {
  return /(?:^|\/)(?:mod|lib|main)\.rs$/.test(fileName);
}

/**
 * Where the children of the file's module live: next to `mod.rs` /
 * `lib.rs`, else in a folder named like the file (`tag.rs` → `tag/`).
 */
function selfPrefix(fileName: string): string {
  if (isFolderModule(fileName)) {
    return './';
  }

  const base = fileName.split('/').at(-1)?.replace(/\.rs$/, '') ?? '';
  return `./${base}/`;
}

/** Files a module path (`crate::a::b`, `super::c`) may be in. */
function pathCandidates(
  parts: ReadonlyArray<string>,
  fileName: string
): { candidates: string[]; anchor?: string } | undefined {
  const [head, ...rest] = parts;
  if (head === 'crate') {
    return { candidates: moduleFiles('/src/', rest), anchor: CRATE_ANCHOR };
  }

  if (head === 'self') {
    return { candidates: moduleFiles(selfPrefix(fileName), rest) };
  }

  if (head === 'super') {
    let prefix = isFolderModule(fileName) ? '../' : './';
    let remaining = rest;
    while (remaining[0] === 'super') {
      prefix += '../';
      remaining = remaining.slice(1);
    }

    if (remaining.length > 0) {
      return { candidates: moduleFiles(prefix, remaining) };
    }

    // The parent module itself: its folder's `mod.rs`, or the file named
    // like its folder next to it (`src/cli/run.rs`: `../cli.rs`).
    const folders = fileName.split('/').slice(0, -1);
    const name = folders.at(folders.length - prefix.split('../').length);
    return {
      candidates: [
        `${prefix}mod.rs`,
        ...(name
          ? [`${prefix}../${name}.rs`.replace(/^\.\/(?=\.\.\/)/, '')]
          : []),
      ],
    };
  }

  return undefined;
}

/**
 * The module of an item named by its path in the code, when it is a
 * module of the crate (`crate::parser` of `crate::parser::parse`, or
 * `parser` of `parser::parse` after `use crate::parser;`).
 */
function modulePath(
  path: string,
  modules: ReadonlyMap<string, ReadonlyArray<string>>,
  fileName: string
): Omit<ModuleReference, 'range'> | undefined {
  const item = itemPath(path);
  const at = item?.lastIndexOf('::') ?? -1;
  if (!item || at === -1 || !path.startsWith(item.slice(0, at))) {
    return undefined;
  }

  const specifier = item.slice(0, at);
  const [head, ...rest] = specifier.split('::');
  const used = head === undefined ? undefined : modules.get(head);
  const parts =
    head === 'crate' || head === 'self' || head === 'super'
      ? [head, ...rest]
      : used
        ? [...used, ...rest]
        : undefined;
  const module = parts ? pathCandidates(parts, fileName) : undefined;
  return module
    ? {
        specifier,
        candidates: module.candidates,
        ...(module.anchor ? { anchor: module.anchor } : {}),
      }
    : undefined;
}

/**
 * Files referenced by a Rust file: `mod x;` declarations, the modules of
 * `use crate::…` / `self::` / `super::` paths and of items named by such
 * a path in the code, and the uses of the names they import (Ctrl/Cmd+click
 * opens the definition).
 */
export function rustReferences(
  text: string,
  fileName = 'src/main.rs'
): ModuleReference[] {
  const references: ModuleReference[] = [];
  const bindings = new Map<
    string,
    { candidates: string[]; anchor?: string; symbol?: string }
  >();

  for (const use of rustUses(text)) {
    const moduleParts = use.path.slice(0, -1);
    const module = pathCandidates(
      moduleParts.map((p) => p.text),
      fileName
    );
    const first = moduleParts[0];
    const last = moduleParts.at(-1);
    if (!module || !first || !last) {
      continue;
    }

    const item = use.path.at(-1);
    references.push({
      range: { start: first.start, end: last.end },
      specifier: moduleParts.map((p) => p.text).join('::'),
      candidates: module.candidates,
      ...(module.anchor ? { anchor: module.anchor } : {}),
    });
    if (!item) {
      continue;
    }

    // The imported name may be a module itself (`use crate::parser;`).
    const asModule = pathCandidates(
      use.path.map((p) => p.text),
      fileName
    );
    const binding = {
      candidates:
        use.imported === '*'
          ? module.candidates
          : [...module.candidates, ...(asModule?.candidates ?? [])],
      ...(module.anchor ? { anchor: module.anchor } : {}),
      ...(use.imported === '*' ? {} : { symbol: use.imported }),
    };
    references.push({
      range: { start: item.start, end: item.end },
      specifier: item.text,
      ...binding,
    });
    bindings.set(use.name, binding);
  }

  const { tree } = parseRustTree(text);
  const modPrefix = selfPrefix(fileName);
  const modules = new Map(
    rustUses(text).map((use) => [
      use.name,
      use.path.map((p) => p.text).filter((p) => p !== 'self'),
    ])
  );
  tree.iterate({
    enter: (ref) => {
      if (ref.name === 'UseDeclaration') {
        return false;
      }

      if (
        ref.name === 'ScopedIdentifier' ||
        ref.name === 'ScopedTypeIdentifier'
      ) {
        const found = modulePath(
          text.slice(ref.from, ref.to),
          modules,
          fileName
        );
        if (found) {
          references.push({
            range: { start: ref.from, end: ref.from + found.specifier.length },
            ...found,
          });
        }
      }

      if (ref.name === 'ModItem' && !ref.node.getChild('DeclarationList')) {
        const name = ref.node.getChild('BoundIdentifier');
        if (name) {
          const module = text.slice(name.from, name.to);
          references.push({
            range: { start: name.from, end: name.to },
            specifier: module,
            candidates: moduleFiles(modPrefix, [module]),
          });
        }

        return false;
      }

      if (
        (ref.name === 'Identifier' ||
          ref.name === 'TypeIdentifier' ||
          ref.name === 'ScopeIdentifier') &&
        bindings.has(text.slice(ref.from, ref.to))
      ) {
        const binding = bindings.get(text.slice(ref.from, ref.to));
        if (binding) {
          references.push({
            range: { start: ref.from, end: ref.to },
            specifier: text.slice(ref.from, ref.to),
            ...binding,
          });
        }
      }

      return true;
    },
  });
  return references;
}
