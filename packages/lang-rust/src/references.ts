import type { ModuleReference } from '@vizscript/core';
import { parseRustTree } from './convert';
import { rustUses } from './imports';

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

    return {
      candidates:
        remaining.length === 0
          ? [`${prefix}mod.rs`, `${prefix.replace(/\/$/, '')}.rs`]
          : moduleFiles(prefix, remaining),
    };
  }

  return undefined;
}

/**
 * Files referenced by a Rust file: `mod x;` declarations, the modules of
 * `use crate::…` / `self::` / `super::` paths, and the uses of the names
 * they import (Ctrl/Cmd+click opens the definition).
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
  tree.iterate({
    enter: (ref) => {
      if (ref.name === 'UseDeclaration') {
        return false;
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
