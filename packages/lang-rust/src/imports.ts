import type { SyntaxNode } from '@lezer/common';
import type {
  DeclarationSyntax,
  GraphDocument,
  ImportRequest,
  OpResult,
  ScriptSymbol,
} from '@vizscript/core';
import { insertImport, joinImport, symbolId } from '@vizscript/core';
import { parseRustTree } from './convert';

const COMMENTS = new Set(['LineComment', 'BlockComment']);

function children(node: SyntaxNode): SyntaxNode[] {
  const result: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (!COMMENTS.has(child.name)) {
      result.push(child);
    }
  }

  return result;
}

const PATH_SEGMENTS = new Set([
  'ScopeIdentifier',
  'Identifier',
  'BoundIdentifier',
  'self',
  'super',
  'crate',
  'Metavariable',
]);

/** One name a `use` binds. */
export interface UseBinding {
  /** Local name. */
  name: string;
  /** Module path (`crate::parser`, `std::collections`). */
  module: string;
  /** Name in the module, or `*` for the module itself (`use std::io;`). */
  imported: string;
  /** Range of the item in the `use` (path and alias). */
  range: { start: number; end: number };
  nameRange: { start: number; end: number };
  /** The whole `use …;`. */
  statement: { start: number; end: number };
  /** Ranges of the path's segments, for Ctrl/Cmd+click. */
  path: Array<{ text: string; start: number; end: number }>;
  isPub: boolean;
}

/**
 * Names bound by the `use` declarations of a file (also inside inline
 * modules, but not inside functions).
 */
export function rustUses(text: string): UseBinding[] {
  const { tree } = parseRustTree(text);
  const result: UseBinding[] = [];
  const slice = (node: SyntaxNode): string => text.slice(node.from, node.to);

  const walk = (
    node: SyntaxNode,
    prefix: Array<{ text: string; start: number; end: number }>,
    statement: SyntaxNode,
    isPub: boolean
  ): void => {
    const add = (
      segments: Array<{ text: string; start: number; end: number }>,
      alias: SyntaxNode | undefined,
      item: SyntaxNode
    ): void => {
      const last = segments.at(-1);
      if (!last) {
        return;
      }

      const path = [...prefix, ...segments];
      const isSelf = last.text === 'self';
      const moduleParts = path.slice(0, -1).map((p) => p.text);
      const name = alias
        ? slice(alias)
        : isSelf
          ? (moduleParts.at(-1) ?? 'self')
          : last.text;
      result.push({
        name,
        module: isSelf
          ? moduleParts.join('::')
          : moduleParts.join('::') || last.text,
        imported: isSelf || moduleParts.length === 0 ? '*' : last.text,
        range: { start: item.from, end: item.to },
        nameRange: alias
          ? { start: alias.from, end: alias.to }
          : { start: last.start, end: last.end },
        statement: { start: statement.from, end: statement.to },
        path,
        isPub,
      });
    };

    const segmentsOf = (
      path: SyntaxNode
    ): Array<{ text: string; start: number; end: number }> => {
      if (PATH_SEGMENTS.has(path.name)) {
        return [{ text: slice(path), start: path.from, end: path.to }];
      }

      return children(path).flatMap((k) =>
        k.name === '::' ? [] : segmentsOf(k)
      );
    };

    switch (node.name) {
      case 'ScopedIdentifier':
      case 'Identifier':
      case 'BoundIdentifier':
      case 'self': {
        add(segmentsOf(node), undefined, node);
        return;
      }

      case 'UseAsClause': {
        const kids = children(node);
        const asAt = kids.findIndex((k) => k.name === 'as');
        const path = kids[0];
        const alias = kids[asAt + 1];
        if (path) {
          add(segmentsOf(path), alias, node);
        }

        return;
      }

      case 'ScopedUseList': {
        const kids = children(node);
        const list = kids.find((k) => k.name === 'UseList');
        const head = kids.filter((k) => k !== list && k.name !== '::');
        const extended = [...prefix, ...head.flatMap((h) => segmentsOf(h))];
        if (list) {
          walk(list, extended, statement, isPub);
        }

        return;
      }

      case 'UseList': {
        for (const kid of children(node)) {
          walk(kid, prefix, statement, isPub);
        }

        return;
      }

      default: {
        return;
      }
    }
  };

  const visit = (parent: SyntaxNode): void => {
    for (const node of children(parent)) {
      if (node.name === 'UseDeclaration') {
        const kids = children(node);
        const isPub = kids[0]?.name === 'Vis';
        const body = kids.find(
          (k) => k.name !== 'use' && k.name !== 'Vis' && k.name !== ';'
        );
        if (body) {
          walk(body, [], node, isPub);
        }
      } else if (node.name === 'ModItem' || node.name === 'AttributeItem') {
        const list = node.getChild('DeclarationList');
        if (list) {
          visit(list);
        } else if (node.name === 'AttributeItem') {
          visit(node);
        }
      }
    }
  };

  visit(tree.topNode);
  return result;
}

/** `use` bindings as symbols of "My Script". */
export function rustImports(text: string): ScriptSymbol[] {
  const symbols: ScriptSymbol[] = [];
  for (const use of rustUses(text)) {
    const id = symbolId('import', '', use.name);
    if (symbols.some((s) => s.id === id) || use.name === '_') {
      continue;
    }

    symbols.push({
      id,
      kind: 'import',
      name: use.name,
      scope: '',
      range: use.range,
      declarationRange: use.statement,
      nameRange: use.nameRange,
      dataType: 'any',
      modifiers: use.isPub ? ['pub'] : [],
      module: use.module,
      imported: use.imported,
    });
  }

  return symbols;
}

/**
 * Module path of a file in its crate: `src/parser/tag/node.rs` →
 * `crate::parser::tag::node` (`mod.rs`, `lib.rs` and `main.rs` stand for
 * their folder).
 */
export function modulePathOf(path: string): string {
  const parts = path.replace(/\.rs$/, '').split('/');
  const src = parts.lastIndexOf('src');
  const inner = src === -1 ? parts.slice(-1) : parts.slice(src + 1);
  const last = inner.at(-1);
  if (
    last === 'mod' ||
    ((last === 'lib' || last === 'main') && inner.length === 1)
  ) {
    inner.pop();
  }

  return ['crate', ...inner].join('::');
}

/**
 * `use module::name;`, joined into an existing `use module::{…}` list, below
 * the file's other `use` lines.
 */
export function addRustImport(
  text: string,
  doc: GraphDocument,
  request: ImportRequest,
  syntax: DeclarationSyntax
): OpResult {
  const { name, imported } = request;
  const module = request.module ?? modulePathOf(request.path);
  if (imported === '*') {
    const parent = module.split('::').slice(0, -1).join('::');
    const last = module.split('::').at(-1) ?? module;
    const line = `use ${parent ? `${parent}::` : ''}${last}${name === last ? '' : ` as ${name}`};`;
    return { ok: true, edits: [insertImport(text, doc, syntax, line)] };
  }

  const listed = (doc.symbols ?? []).some(
    (s) =>
      s.kind === 'import' &&
      s.module === module &&
      s.declarationRange &&
      text.slice(s.declarationRange.start, s.declarationRange.end).includes('{')
  );
  const joined = listed ? joinImport(doc, module, name, imported) : undefined;
  if (joined) {
    return { ok: true, edits: [joined] };
  }

  const item = imported === name ? name : `${imported} as ${name}`;
  return {
    ok: true,
    edits: [insertImport(text, doc, syntax, `use ${module}::${item};`)],
  };
}
