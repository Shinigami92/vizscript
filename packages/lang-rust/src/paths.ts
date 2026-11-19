import { parseRustTree } from './convert';

/** Paths of Rust itself (the hand-written stubs know them). */
const STD_HEADS = new Set(['std', 'core', 'alloc', 'Self']);

const SEGMENT = /^[A-Za-z_]\w*$/;

/**
 * The item a path names, by Rust's naming rules: the first CamelCase
 * segment is a type (`serde_json::Value::Null` → `serde_json::Value`,
 * `ignore::WalkBuilder::new` → `ignore::WalkBuilder`); without one the
 * whole path is a function or constant (`serde_json::to_string`).
 */
export function itemPath(path: string): string | undefined {
  const parts = path.split('::').map((p) => p.trim());
  if (parts.length < 2 || !parts.every((p) => SEGMENT.test(p))) {
    return undefined;
  }

  const [head] = parts;
  if (!head || STD_HEADS.has(head) || /^[A-Z]/.test(head)) {
    return undefined;
  }

  const type = parts.findIndex((p) => /^[A-Z]/.test(p));
  return type === -1 ? parts.join('::') : parts.slice(0, type + 1).join('::');
}

/**
 * Items of other crates and modules the file names by their path, without
 * a `use` (`serde_json::to_string(&x)`, `x: serde_json::Value`,
 * `crate::parser::parse(text)`): the web app supplies their declarations
 * as imports named by the path.
 */
export function rustPaths(text: string): string[] {
  const { tree, text: masked } = parseRustTree(text);
  const paths = new Set<string>();
  tree.iterate({
    enter: (node) => {
      if (node.name === 'UseDeclaration') {
        return false;
      }

      if (
        node.name === 'ScopedIdentifier' ||
        node.name === 'ScopedTypeIdentifier'
      ) {
        const path = itemPath(masked.slice(node.from, node.to));
        if (path) {
          paths.add(path);
        }

        return false;
      }

      return undefined;
    },
  });
  return [...paths];
}
