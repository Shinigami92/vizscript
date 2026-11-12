import type { Tree } from '@lezer/common';
import { parser } from '@lezer/rust';
import type { Item, Span } from './ast';
import { COMMENTS } from './convert-utils';
import { Converter } from './expression-converter';
import type { RustDiagnostic } from './item-converter';

/**
 * Converts Lezer's concrete Rust syntax tree into the small typed AST the
 * lowering works with. Lezer is error tolerant, so this never throws: parts
 * it cannot make sense of become `Opaque` expressions or `Error` statements.
 */

export interface ConvertResult {
  items: Item[];
  diagnostics: RustDiagnostic[];
  comments: Span[];
}

/**
 * Lezer's Rust grammar fails on a reference right before a let chain
 * (`if let Some(a) = &b && let …`). The `&` is replaced by a space (same
 * length, so offsets stay valid); the graph shows the value without it.
 */
export function maskForParser(text: string, tree?: Tree): string {
  let masked = text;
  let current = tree ?? parser.parse(text);
  for (let round = 0; round < 8; round++) {
    const errors: number[] = [];
    current.iterate({
      enter: (node) => {
        if (node.type.isError) {
          errors.push(node.from);
        }
      },
    });
    let changed = false;
    for (const at of errors) {
      // The `&& let` next to the error, and the `= &` before it.
      const from = Math.max(0, at - 400);
      const window = masked.slice(from, at + 200);
      const chains = [...window.matchAll(/&&\s*let\b/g)];
      const chain =
        chains.findLast((c) => from + (c.index ?? 0) <= at + 1) ?? chains[0];
      if (chain?.index === undefined) {
        continue;
      }

      const before = window.slice(0, chain.index);
      const last = [...before.matchAll(/=\s*(&)(?![&=])/g)].at(-1);
      if (last?.index === undefined) {
        continue;
      }

      const offset = from + last.index + last[0].length - 1;
      masked = `${masked.slice(0, offset)} ${masked.slice(offset + 1)}`;
      changed = true;
    }

    if (!changed) {
      break;
    }

    current = parser.parse(masked);
  }

  return masked;
}

/** Parses Rust source into the AST used by the lowering. */
export function parseRust(text: string): ConvertResult {
  const first = parser.parse(text);
  const masked = maskForParser(text, first);
  const tree = masked === text ? first : parser.parse(masked);
  const converter = new Converter(masked);
  const items = converter.file(tree);
  const comments: Span[] = [];
  tree.iterate({
    enter: (node) => {
      if (COMMENTS.has(node.name)) {
        comments.push({ start: node.from, end: node.to });
      }
    },
  });
  return { items, diagnostics: converter.diagnostics, comments };
}

/** The Lezer tree of a file (with the parser workarounds applied). */
export function parseRustTree(text: string): { tree: Tree; text: string } {
  const first = parser.parse(text);
  const masked = maskForParser(text, first);
  return { tree: masked === text ? first : parser.parse(masked), text: masked };
}
