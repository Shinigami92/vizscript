import type { SyntaxNode } from '@lezer/common';
import { parser } from '@lezer/python';
import type { ModuleReference } from '@vizscript/core';
import { maskForParser } from './convert-utils';

interface DottedName {
  start: number;
  end: number;
  parts: string[];
  /** Bound to another name with `as`. */
  aliased?: boolean;
}

function children(node: SyntaxNode): SyntaxNode[] {
  const result: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    result.push(child);
  }

  return result;
}

/** Module files of a dotted path below `prefix` (`./`, `../`, `/`). */
function moduleFiles(prefix: string, parts: ReadonlyArray<string>): string[] {
  const path = prefix + parts.join('/');
  return [`${path}.py`, `${path}/__init__.py`, `${path}.pyi`];
}

/**
 * Candidates of a module: relative imports (`level` dots) start at the
 * file's package, absolute ones next to the file (scripts) or at the root.
 */
function candidates(level: number, parts: ReadonlyArray<string>): string[] {
  if (level > 0) {
    return moduleFiles(`./${'../'.repeat(level - 1)}`, parts);
  }

  return [...moduleFiles('./', parts), ...moduleFiles('/', parts)];
}

/** A name bound by an import, with where it is defined. */
interface Binding {
  candidates: string[];
  /** Imported name (`from x import name`); unset for whole modules. */
  symbol?: string;
}

/**
 * Local modules imported by a Python file (`import x`, `from .y import z`)
 * and the uses of the imported names.
 */
export function pythonReferences(text: string): ModuleReference[] {
  const tree = parser.parse(maskForParser(text));
  const references: ModuleReference[] = [];
  const bindings = new Map<string, Binding>();
  const add = (
    range: { start: number; end: number },
    files: string[]
  ): void => {
    references.push({
      range,
      specifier: text.slice(range.start, range.end),
      candidates: files,
    });
  };

  tree.iterate({
    enter: (ref) => {
      if (ref.name !== 'ImportStatement') {
        // Imports may be nested (`try:` blocks, functions).
        return true;
      }

      const kids = children(ref.node);
      const importAt = kids.findIndex((k) => k.name === 'import');
      if (kids[0]?.name === 'from') {
        // from ..pkg.mod import a, b
        let level = 0;
        let moduleStart: number | undefined;
        const parts: string[] = [];
        let moduleEnd = 0;
        for (const kid of kids.slice(1, importAt)) {
          moduleStart ??= kid.from;
          moduleEnd = kid.to;
          if (kid.name === '.' && parts.length === 0) {
            level += 1;
          } else if (kid.name === 'Ellipsis') {
            level += 3;
          } else if (kid.name === 'VariableName') {
            parts.push(text.slice(kid.from, kid.to));
          }
        }

        if (moduleStart !== undefined && parts.length > 0) {
          add({ start: moduleStart, end: moduleEnd }, candidates(level, parts));
        }

        // Imported names may be submodules: `from . import utils`.
        kids.slice(importAt + 1).forEach((kid, i, rest) => {
          if (kid.name === 'VariableName' && rest[i - 1]?.name !== 'as') {
            const name = text.slice(kid.from, kid.to);
            const submodule = candidates(level, [...parts, name]);
            add({ start: kid.from, end: kid.to }, submodule);
            const alias = rest[i + 1]?.name === 'as' ? rest[i + 2] : undefined;
            const local = alias ? text.slice(alias.from, alias.to) : name;
            bindings.set(local, {
              candidates: [
                ...submodule,
                ...(parts.length > 0 || level > 0
                  ? candidates(level, parts.length > 0 ? parts : ['__init__'])
                  : []),
              ],
              symbol: name,
            });
          }
        });
      } else {
        // import a.b as c, d
        const names: DottedName[] = [];
        let current: DottedName | undefined;
        let afterAs = false;
        for (const kid of kids.slice(importAt + 1)) {
          if (kid.name === 'as') {
            afterAs = true;
            current = undefined;
          } else if (kid.name === ',') {
            afterAs = false;
            current = undefined;
          } else if (kid.name === 'VariableName' && afterAs) {
            // `import a.b as c` binds `c`.
            const last = names.at(-1);
            if (last) {
              bindings.set(text.slice(kid.from, kid.to), {
                candidates: candidates(0, last.parts),
              });
              last.aliased = true;
            }
          } else if (kid.name === 'VariableName' && !afterAs) {
            if (!current) {
              current = { start: kid.from, end: kid.to, parts: [] };
              names.push(current);
            }

            current.parts.push(text.slice(kid.from, kid.to));
            current.end = kid.to;
          }
        }

        for (const name of names) {
          add(name, candidates(0, name.parts));
        }

        // `import a.b` binds `a`.
        for (const name of names) {
          const first = name.parts[0];
          if (first && !name.aliased && !bindings.has(first)) {
            bindings.set(first, { candidates: candidates(0, [first]) });
          }
        }
      }

      return false;
    },
  });

  if (bindings.size === 0) {
    return references;
  }

  // Uses of imported names point at their definitions.
  const use = (node: SyntaxNode, binding: Binding, symbol?: string): void => {
    references.push({
      range: { start: node.from, end: node.to },
      specifier: text.slice(node.from, node.to),
      candidates: binding.candidates,
      ...(symbol ? { symbol } : {}),
    });
  };
  tree.iterate({
    enter: (ref) => {
      if (ref.name === 'ImportStatement') {
        return false;
      }

      if (ref.name === 'VariableName') {
        const binding = bindings.get(text.slice(ref.from, ref.to));
        if (binding) {
          use(ref.node, binding, binding.symbol);
        }
      } else if (ref.name === 'PropertyName') {
        // `module.function`
        const object = ref.node.prevSibling?.prevSibling;
        const binding =
          object?.name === 'VariableName'
            ? bindings.get(text.slice(object.from, object.to))
            : undefined;
        if (binding && !binding.symbol) {
          use(ref.node, binding, text.slice(ref.from, ref.to));
        }
      }

      return true;
    },
  });
  return references.toSorted((a, b) => a.range.start - b.range.start);
}
