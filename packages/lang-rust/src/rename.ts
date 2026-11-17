import type { SyntaxNode } from '@lezer/common';
import { parser } from '@lezer/rust';
import type {
  CallSite,
  OpResult,
  ScriptSymbol,
  SourceRange,
  TextEdit,
} from '@vizscript/core';
import { qualifiedName, rangeKey } from '@vizscript/core';
import { parseRust, parseRustTree } from './convert';
import { rustTypes } from './type-lookup';

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

function inside(
  node: { from: number; to: number },
  range: SourceRange
): boolean {
  return range.start <= node.from && node.to <= range.end;
}

function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/** Visits a node and its descendants (`false` skips the children). */
function visit(
  node: SyntaxNode,
  fn: (node: SyntaxNode) => boolean | void
): void {
  if (fn(node) === false) {
    return;
  }

  for (let child = node.firstChild; child; child = child.nextSibling) {
    visit(child, fn);
  }
}

/** Source a visited node belongs to: the file or a macro's arguments. */
interface Piece {
  text: string;
  /** Add to a node's offsets to get offsets in the file. */
  shift: number;
}

const MACRO_PREFIX = 'fn f(){f(';

/**
 * Visits a tree and the arguments of its macros (`write!(f, "{}", x.a)`),
 * which Lezer keeps as plain tokens: they are parsed as call arguments of
 * a tiny file, and the visitor gets the piece to slice and shift with.
 */
function visitWithMacros(
  root: SyntaxNode,
  text: string,
  fn: (node: SyntaxNode, piece: Piece) => boolean | void
): void {
  const walk = (node: SyntaxNode, piece: Piece): void => {
    visit(node, (current) => {
      const result = fn(current, piece);
      if (result !== false && current.name === 'MacroInvocation') {
        const tokens = children(current).find((k) => k.name.endsWith('Tokens'));
        if (tokens && tokens.to - tokens.from > 2) {
          const inner = piece.text.slice(tokens.from + 1, tokens.to - 1);
          const sub = `${MACRO_PREFIX}${inner})}`;
          let args: SyntaxNode | undefined;
          visit(parser.parse(sub).topNode, (n) => {
            if (!args && n.name === 'ArgList') {
              args = n;
            }

            return !args;
          });
          if (args) {
            walk(args, {
              text: sub,
              shift: piece.shift + tokens.from + 1 - MACRO_PREFIX.length,
            });
          }
        }
      }

      return result;
    });
  };

  walk(root, { text, shift: 0 });
}

/** `&mut a::Item<T>` → `Item`. */
function typeName(type: string): string {
  const bare = type
    .replace(/^&(?:'\w+\s+)?(?:mut\s+)?/, '')
    .replace(/<[\s\S]*$/, '')
    .trim();
  return bare.split('::').at(-1) ?? bare;
}

/** Whether a function (its range) binds `name` itself (shadowing). */
function shadows(fn: SyntaxNode, name: string, text: string): boolean {
  let found = false;
  visit(fn, (node) => {
    if (found) {
      return false;
    }

    if (
      node.name === 'BoundIdentifier' &&
      text.slice(node.from, node.to) === name
    ) {
      const parent = node.parent?.name;
      // The function's own name is not a binding inside it.
      found = parent !== 'FunctionItem';
    }

    return true;
  });
  return found;
}

/** Edits for one occurrence; shorthands keep their field name. */
function occurrence(node: SyntaxNode, old: string, name: string): TextEdit {
  const parent = node.parent;
  if (parent?.name === 'ShorthandFieldInitializer') {
    return { start: node.from, end: node.to, text: `${old}: ${name}` };
  }

  if (
    node.name === 'BoundIdentifier' &&
    parent?.name === 'FieldPattern' &&
    children(parent).length === 1
  ) {
    return { start: node.from, end: node.to, text: `${old}: ${name}` };
  }

  return { start: node.from, end: node.to, text: name };
}

/** `{name}` and `{name:?}` in the format strings of macros. */
function formatEdits(
  node: SyntaxNode,
  text: string,
  old: string,
  name: string
): TextEdit[] {
  const raw = text.slice(node.from, node.to);
  const edits: TextEdit[] = [];
  const pattern = new RegExp(
    String.raw`(?<!\{)\{(${escapeRegExp(old)})(?=[:}])`,
    'g'
  );
  for (const match of raw.matchAll(pattern)) {
    const start = node.from + (match.index ?? 0) + 1;
    edits.push({ start, end: start + old.length, text: name });
  }

  return edits;
}

function inMacroTokens(node: SyntaxNode): boolean {
  for (let p = node.parent; p; p = p.parent) {
    if (p.name.endsWith('Tokens')) {
      return true;
    }

    if (p.name === 'MacroInvocation' || p.name === 'Block') {
      return false;
    }
  }

  return false;
}

/** The pattern of a `let`: what is between `let` (or `mut`) and `=`/`:`. */
function letParts(node: SyntaxNode): {
  pattern: SyntaxNode[];
  rest: SyntaxNode[];
} {
  const parts = children(node);
  const at = parts.findIndex((k) => k.name === 'let');
  const end = parts.findIndex(
    (k, i) => i > at && (k.name === '=' || k.name === ':' || k.name === ';')
  );
  const stop = end === -1 ? parts.length : end;
  return {
    pattern: parts.slice(at + 1, stop),
    rest: parts.slice(stop),
  };
}

/** A name in a function and the binding it resolves to (its start). */
interface LocalUse {
  node: SyntaxNode;
  name: string;
  /** Offset of the name (inside a format string for `{name}`). */
  start: number;
  binding: number | undefined;
}

/**
 * Every local name of a function resolved like Rust does: a block is a
 * scope, `let` binds after its own value (`let x = x + 1` reads the old
 * `x`) and shadows earlier ones, closure parameters, `if let` / `while let`,
 * `for` and match arm patterns bind for their part only. Names inside macro
 * arguments and `{name}` in their format strings count too.
 */
function localUses(fn: SyntaxNode, text: string): LocalUse[] {
  const uses: LocalUse[] = [];
  type Env = Map<string, number>;
  const nameOf = (node: SyntaxNode): string => text.slice(node.from, node.to);

  const bind = (pattern: SyntaxNode, env: Env): void => {
    visit(pattern, (node) => {
      if (node.name === 'BoundIdentifier') {
        const name = nameOf(node);
        env.set(name, node.from);
        uses.push({ node, name, start: node.from, binding: node.from });
      }

      // Types and values in patterns (`Some(x)`, `1..=5`) bind nothing.
      return !node.name.endsWith('Expression');
    });
  };

  const walk = (node: SyntaxNode, env: Env): void => {
    switch (node.name) {
      case 'FunctionItem': {
        // A nested function sees none of the outer locals.
        const inner: Env = new Map();
        for (const kid of children(node)) {
          if (kid.name === 'ParamList') {
            bind(kid, inner);
          } else if (kid.name === 'Block') {
            walk(kid, inner);
          }
        }

        return;
      }

      case 'Block': {
        const inner = new Map(env);
        for (const kid of children(node)) {
          walk(kid, inner);
        }

        return;
      }

      case 'LetDeclaration': {
        // A statement: binds in the block it is in, after its value.
        const { pattern, rest } = letParts(node);
        for (const kid of rest) {
          walk(kid, env);
        }

        for (const kid of pattern) {
          bind(kid, env);
        }

        return;
      }

      case 'IfExpression':
      case 'WhileExpression': {
        // `if let p = v { … }`: `p` binds in the first block only.
        let then: Env = env;
        let bodyDone = false;
        for (const kid of children(node)) {
          if (kid.name === 'LetDeclaration') {
            const { pattern, rest } = letParts(kid);
            for (const part of rest) {
              walk(part, env);
            }

            then = new Map(then);
            for (const part of pattern) {
              bind(part, then);
            }
          } else if (kid.name === 'Block' && !bodyDone) {
            walk(kid, then);
            bodyDone = true;
          } else {
            walk(kid, env);
          }
        }

        return;
      }

      case 'ClosureExpression': {
        const inner = new Map(env);
        for (const kid of children(node)) {
          if (kid.name === 'ParamList') {
            bind(kid, inner);
          } else {
            walk(kid, inner);
          }
        }

        return;
      }

      case 'ForExpression': {
        const inner = new Map(env);
        let state: 'pattern' | 'iter' | 'body' = 'pattern';
        for (const kid of children(node)) {
          if (kid.name === 'for') {
            state = 'pattern';
          } else if (kid.name === 'in') {
            state = 'iter';
          } else if (state === 'pattern') {
            bind(kid, inner);
          } else if (kid.name === 'Block') {
            walk(kid, inner);
            state = 'body';
          } else {
            walk(kid, env);
          }
        }

        return;
      }

      case 'MatchArm': {
        const inner = new Map(env);
        let pattern = true;
        for (const kid of children(node)) {
          if (kid.name === 'Guard' || kid.name === '=>') {
            pattern = false;
          }

          if (pattern) {
            bind(kid, inner);
          } else {
            walk(kid, inner);
          }
        }

        return;
      }

      case 'Identifier': {
        if (node.parent?.name !== 'ScopedIdentifier') {
          const name = nameOf(node);
          uses.push({ node, name, start: node.from, binding: env.get(name) });
        }

        return;
      }

      case 'String': {
        if (inMacroTokens(node)) {
          // `{name}` / `{name:?}` in a format string.
          const raw = nameOf(node);
          for (const match of raw.matchAll(
            /(?<!\{)\{([A-Za-z_]\w*)(?=[:}])/g
          )) {
            const name = match[1] ?? '';
            uses.push({
              node,
              name,
              start: node.from + (match.index ?? 0) + 1,
              binding: env.get(name),
            });
          }
        }

        return;
      }

      default: {
        for (const kid of children(node)) {
          walk(kid, env);
        }
      }
    }
  };

  walk(fn, new Map());
  return uses;
}

function unique(edits: TextEdit[]): TextEdit[] {
  const seen = new Set<string>();
  return edits.filter((e) => {
    const key = `${e.start}:${e.end}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

/** The function (or method) node whose range is `range`. */
function functionAt(
  top: SyntaxNode,
  range: SourceRange
): SyntaxNode | undefined {
  let result: SyntaxNode | undefined;
  visit(top, (node) => {
    if (result) {
      return false;
    }

    if (
      node.name === 'FunctionItem' &&
      node.from >= range.start &&
      node.to <= range.end
    ) {
      result = node;
      return false;
    }

    return node.from <= range.end && node.to >= range.start;
  });
  return result;
}

/**
 * Edits that rename a symbol of a Rust file and its uses: locals inside
 * their function, items in the file (not where a function binds the same
 * name), methods at their calls, fields at their uses, types everywhere.
 */
export function renameRustSymbol(
  source: string,
  symbols: ReadonlyArray<ScriptSymbol>,
  symbol: ScriptSymbol,
  name: string
): OpResult {
  const { tree, text } = parseRustTree(source);
  const top = tree.topNode;
  const old = symbol.name;
  const edits: TextEdit[] = [];
  const isName = (node: SyntaxNode): boolean =>
    text.slice(node.from, node.to) === old;

  switch (symbol.kind) {
    case 'local': {
      const owner = symbols.find(
        (s) =>
          (s.kind === 'function' || s.kind === 'method') &&
          qualifiedName(s) === symbol.scope
      );
      const fn = owner ? functionAt(top, owner.range) : undefined;
      if (!fn) {
        edits.push({ ...symbol.nameRange, text: name });
        break;
      }

      // Only the names that resolve to this binding (Rust's block scopes,
      // shadowing, closure and pattern bindings).
      const binding = symbol.nameRange.start;
      for (const use of localUses(fn, text)) {
        if (use.name !== old || use.binding !== binding) {
          continue;
        }

        edits.push(
          use.node.name === 'String'
            ? { start: use.start, end: use.start + old.length, text: name }
            : occurrence(use.node, old, name)
        );
      }

      break;
    }

    case 'function':
    case 'constant':
    case 'variable': {
      if (symbol.kind === 'variable' && symbol.scope !== '') {
        // A struct field, also inside macro arguments.
        visitWithMacros(top, text, (node, piece) => {
          if (piece.text.slice(node.from, node.to) !== old) {
            return true;
          }

          const start = node.from + piece.shift;
          const end = node.to + piece.shift;
          if (node.name === 'FieldIdentifier') {
            edits.push({ start, end, text: name });
          } else if (
            (node.name === 'Identifier' &&
              node.parent?.name === 'ShorthandFieldInitializer') ||
            (node.name === 'BoundIdentifier' &&
              node.parent?.name === 'FieldPattern' &&
              children(node.parent).length === 1)
          ) {
            edits.push({ start, end, text: `${name}: ${old}` });
          }

          return true;
        });
        break;
      }

      visit(top, (node) => {
        if (
          node.name === 'FunctionItem' &&
          !inside(node, symbol.range) &&
          shadows(node, old, text)
        ) {
          // Only the declaration's own name inside it would be renamed.
          return false;
        }

        if (
          (node.name === 'Identifier' || node.name === 'BoundIdentifier') &&
          isName(node)
        ) {
          const parent = node.parent;
          const isPathTail =
            parent?.name === 'ScopedIdentifier' &&
            /^(?:crate|self|super)$/.test(
              text.slice(parent.from, parent.to).split('::')[0] ?? ''
            );
          if (parent?.name !== 'ScopedIdentifier' || isPathTail) {
            edits.push(occurrence(node, old, name));
          }
        } else if (node.name === 'String' && inMacroTokens(node)) {
          edits.push(...formatEdits(node, text, old, name));
        }

        return true;
      });
      break;
    }

    case 'method': {
      const owner = symbol.scope.split('.').at(-1) ?? symbol.scope;
      const types = rustTypes(source, parseRust(source).items);
      // `x.len()` calls another type's `len` when `x` is known to be of
      // another type. Unknown receivers (and macro arguments, which have
      // no types) are renamed.
      const ofOtherType = (call: SyntaxNode, piece: Piece): boolean => {
        const receiver = children(call)[0];
        if (piece.shift !== 0 || piece.text !== text || !receiver) {
          return false;
        }

        const type = types.get(
          rangeKey({ start: receiver.from, end: receiver.to })
        )?.text;
        return type !== undefined && typeName(type) !== owner;
      };
      visitWithMacros(top, text, (node, piece) => {
        if (piece.text.slice(node.from, node.to) !== old) {
          return true;
        }

        const edit = {
          start: node.from + piece.shift,
          end: node.to + piece.shift,
          text: name,
        };
        if (
          node.name === 'BoundIdentifier' &&
          node.parent?.name === 'FunctionItem' &&
          inside({ from: edit.start, to: edit.end }, symbol.range)
        ) {
          edits.push(edit);
        } else if (
          node.name === 'FieldIdentifier' &&
          node.parent?.name === 'FieldExpression' &&
          (node.parent.parent?.name === 'CallExpression' ||
            node.parent.parent?.name === 'GenericFunction') &&
          !ofOtherType(node.parent, piece)
        ) {
          edits.push(edit);
        } else if (
          node.name === 'Identifier' &&
          node.parent?.name === 'ScopedIdentifier'
        ) {
          const head = piece.text
            .slice(node.parent.from, node.from)
            .replace(/::$/, '');
          const last = head.split('::').at(-1) ?? '';
          if (last === owner || last === 'Self') {
            edits.push(edit);
          }
        }

        return true;
      });
      break;
    }

    case 'class':
    case 'enum':
    case 'type': {
      visitWithMacros(top, text, (node, piece) => {
        if (
          (node.name === 'TypeIdentifier' ||
            node.name === 'ScopeIdentifier' ||
            (node.name === 'Identifier' &&
              node.parent?.name === 'ScopedIdentifier')) &&
          piece.text.slice(node.from, node.to) === old
        ) {
          edits.push({
            start: node.from + piece.shift,
            end: node.to + piece.shift,
            text: name,
          });
        }

        return true;
      });
      break;
    }

    case 'import': {
      const declaration = symbol.declarationRange ?? symbol.range;
      const aliased =
        symbol.nameRange.start !== symbol.range.start ||
        text.slice(symbol.range.start, symbol.range.end).includes(' as ');
      edits.push(
        aliased
          ? {
              start: symbol.nameRange.start,
              end: symbol.nameRange.end,
              text: name,
            }
          : {
              start: symbol.range.end,
              end: symbol.range.end,
              text: ` as ${name}`,
            }
      );
      visit(top, (node) => {
        if (inside(node, declaration)) {
          return node.from <= declaration.start;
        }

        if (
          (node.name === 'Identifier' ||
            node.name === 'TypeIdentifier' ||
            node.name === 'ScopeIdentifier') &&
          isName(node) &&
          !(
            node.parent?.name === 'ScopedIdentifier' &&
            children(node.parent)[0] !== node
          )
        ) {
          edits.push({ start: node.from, end: node.to, text: name });
        }

        return true;
      });
      break;
    }

    default: {
      return { ok: false, error: `Renaming ${symbol.kind}s is not supported.` };
    }
  }

  return { ok: true, edits: unique(edits) };
}

/** Whether the method's declaration takes `self`. */
function takesSelf(source: string, symbol: ScriptSymbol): boolean {
  const head = source.slice(symbol.nameRange.end, symbol.range.end);
  return /^\s*(?:<[^>]*>)?\s*\(\s*(?:&\s*(?:'\w+\s+)?)?(?:mut\s+)?self\b/.test(
    head
  );
}

/** Calls of a function or method in the same file, with their arguments. */
export function rustCallSites(
  source: string,
  _symbols: ReadonlyArray<ScriptSymbol>,
  symbol: ScriptSymbol
): CallSite[] {
  const { tree, text: masked } = parseRustTree(source);
  const sites: CallSite[] = [];
  const method = symbol.kind === 'method';
  const owner = symbol.scope.split('.').at(-1) ?? '';
  const hasSelf = method && takesSelf(source, symbol);
  visitWithMacros(tree.topNode, masked, (node, { text, shift }) => {
    if (node.name !== 'CallExpression') {
      return true;
    }

    const kids = children(node);
    let callee = kids[0];
    if (callee?.name === 'GenericFunction') {
      callee = children(callee)[0];
    }

    const args = kids.find((k) => k.name === 'ArgList');
    if (!callee || !args) {
      return true;
    }

    const calleeText = text
      .slice(callee.from, callee.to)
      .replaceAll(/\s+/g, '');
    const segments = calleeText.split('::');
    const last = segments.at(-1);
    let skipFirst = false;
    if (method) {
      if (callee.name === 'FieldExpression') {
        const field = children(callee).at(-1);
        if (!field || text.slice(field.from, field.to) !== symbol.name) {
          return true;
        }
      } else if (
        callee.name === 'ScopedIdentifier' &&
        last === symbol.name &&
        (segments.at(-2) === owner || segments.at(-2) === 'Self')
      ) {
        skipFirst = hasSelf;
      } else {
        return true;
      }
    } else if (
      !(
        (callee.name === 'Identifier' && calleeText === symbol.name) ||
        (callee.name === 'ScopedIdentifier' &&
          last === symbol.name &&
          /^(?:crate|self|super)$/.test(segments[0] ?? ''))
      )
    ) {
      return true;
    }

    const argKids = children(args);
    const open = argKids.find((a) => a.name === '(');
    const close = argKids.findLast((a) => a.name === ')');
    if (!open || !close) {
      return true;
    }

    const ranges = argKids
      .filter((a) => a.name !== '(' && a.name !== ')' && a.name !== ',')
      .map((a) => ({ start: a.from + shift, end: a.to + shift }));
    sites.push({
      open: open.to + shift,
      close: close.from + shift,
      args: skipFirst ? ranges.slice(1) : ranges,
    });
    return true;
  });
  return sites;
}
