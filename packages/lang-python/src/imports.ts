import type { SyntaxNode } from '@lezer/common';
import { parser } from '@lezer/python';
import type { ScriptSymbol, SourceRange } from '@vizscript/core';
import { symbolId } from '@vizscript/core';
import { maskForParser } from './convert';

function children(node: SyntaxNode): SyntaxNode[] {
  const result: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    result.push(child);
  }

  return result;
}

/** Items of a comma-separated name list, split at commas. */
function items(nodes: ReadonlyArray<SyntaxNode>): SyntaxNode[][] {
  const result: SyntaxNode[][] = [[]];
  for (const node of nodes) {
    if (node.name === ',') {
      result.push([]);
    } else if (node.name !== '(' && node.name !== ')') {
      result.at(-1)?.push(node);
    }
  }

  return result.filter((item) => item.length > 0);
}

/**
 * Names bound by the module's imports (`import a.b as c`, `from .x import
 * y`), also inside `try:` / `if` blocks, but not in functions or classes.
 */
export function pythonImports(text: string): ScriptSymbol[] {
  const tree = parser.parse(maskForParser(text));
  const symbols: ScriptSymbol[] = [];
  const slice = (node: { from: number; to: number }): string =>
    text.slice(node.from, node.to);
  const add = (
    name: SyntaxNode,
    item: ReadonlyArray<SyntaxNode>,
    statement: SyntaxNode,
    module: string,
    imported: string
  ): void => {
    const id = symbolId('import', '', slice(name));
    if (symbols.some((s) => s.id === id)) {
      return;
    }

    const range: SourceRange = {
      start: item[0]?.from ?? name.from,
      end: item.at(-1)?.to ?? name.to,
    };
    symbols.push({
      id,
      kind: 'import',
      name: slice(name),
      scope: '',
      range,
      declarationRange: { start: statement.from, end: statement.to },
      nameRange: { start: name.from, end: name.to },
      dataType: 'any',
      modifiers: [],
      module,
      imported,
    });
  };

  tree.iterate({
    enter: (ref) => {
      if (ref.name === 'FunctionDefinition' || ref.name === 'ClassDefinition') {
        return false;
      }

      if (ref.name !== 'ImportStatement') {
        return true;
      }

      const statement = ref.node;
      const kids = children(statement);
      const importAt = kids.findIndex((k) => k.name === 'import');
      if (importAt === -1) {
        return false;
      }

      if (kids[0]?.name === 'from') {
        // from ..pkg.mod import a as b, c
        const moduleKids = kids.slice(1, importAt);
        const first = moduleKids[0];
        const last = moduleKids.at(-1);
        const module =
          first && last
            ? text.slice(first.from, last.to).replaceAll(/\s/g, '')
            : '';
        for (const item of items(kids.slice(importAt + 1))) {
          const [name, as, alias] = item;
          if (name?.name !== 'VariableName') {
            continue; // `import *`
          }

          add(
            as?.name === 'as' && alias ? alias : name,
            item,
            statement,
            module,
            slice(name)
          );
        }
      } else {
        // import a.b as c, d
        for (const item of items(kids.slice(importAt + 1))) {
          const asAt = item.findIndex((k) => k.name === 'as');
          const path = asAt === -1 ? item : item.slice(0, asAt);
          const alias = asAt === -1 ? undefined : item[asAt + 1];
          const head = path[0];
          const end = path.at(-1);
          if (!head || !end) {
            continue;
          }

          // `import a.b` binds `a`.
          add(
            alias ?? head,
            item,
            statement,
            text.slice(head.from, end.to),
            '*'
          );
        }
      }

      return false;
    },
  });
  return symbols;
}
