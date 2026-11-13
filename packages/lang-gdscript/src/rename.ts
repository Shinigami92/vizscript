import type {
  CallSite,
  OpResult,
  ScriptSymbol,
  SourceRange,
  TextEdit,
} from '@vizscript/core';
import { qualifiedName } from '@vizscript/core';
import type { Expr, FuncDecl, Param, Stmt, TypeRef } from './ast';

interface Scope {
  kind: 'script' | 'class' | 'function';
  /** Qualified name of a class or function (`Bullet.hit`). */
  name: string;
  parent?: Scope;
  locals: Set<string>;
  /** Start and end of the code of an inner class. */
  range?: SourceRange;
}

interface Occurrence {
  range: SourceRange;
  name: string;
  scope: Scope | undefined;
  /** `self.name`: a member of the class around it. */
  member?: Scope;
}

/** Calls that name a signal in a string (`emit_signal("hit")`). */
const SIGNAL_CALLS = new Set([
  'emit_signal',
  'connect',
  'disconnect',
  'is_connected',
  'has_signal',
]);

type AnyNode = Record<string, unknown>;

function isObject(value: unknown): value is AnyNode {
  return value !== null && typeof value === 'object';
}

function resolve(name: string, scope: Scope): Scope | undefined {
  let current: Scope | undefined = scope;
  while (current) {
    if (current.locals.has(name)) {
      return current;
    }

    current = current.parent;
  }

  return undefined;
}

function classScope(scope: Scope): Scope {
  let current = scope;
  while (current.kind === 'function' && current.parent) {
    current = current.parent;
  }

  return current;
}

class Resolver {
  readonly occurrences: Occurrence[] = [];
  /** Type annotations, for renaming classes and enums. */
  readonly types: TypeRef[] = [];
  /** String literals naming signals. */
  readonly signalStrings: Array<{ range: SourceRange; value: string }> = [];

  /** Members of a class body. */
  members(body: ReadonlyArray<Stmt>, scope: Scope): void {
    for (const stmt of body) {
      if (
        stmt.type === 'Var' ||
        stmt.type === 'Signal' ||
        stmt.type === 'Class'
      ) {
        scope.locals.add(stmt.name);
      } else if (stmt.type === 'Func' && stmt.name) {
        scope.locals.add(stmt.name);
      } else if (stmt.type === 'Enum' && stmt.name) {
        scope.locals.add(stmt.name);
      }
    }
  }

  /** `var` and loop variables of a function body (function-wide). */
  private locals(stmts: ReadonlyArray<Stmt>, scope: Scope): void {
    for (const stmt of stmts) {
      if (stmt.type === 'Var') {
        scope.locals.add(stmt.name);
      } else if (stmt.type === 'For') {
        scope.locals.add(stmt.variable);
        this.locals(stmt.body.body, scope);
      } else if (stmt.type === 'If') {
        this.locals(stmt.body.body, scope);
        for (const elif of stmt.elifs) {
          this.locals(elif.body.body, scope);
        }

        this.locals(stmt.orelse?.body ?? [], scope);
      } else if (stmt.type === 'While') {
        this.locals(stmt.body.body, scope);
      } else if (stmt.type === 'Match') {
        for (const branch of stmt.branches) {
          this.locals(branch.body.body, scope);
        }
      }
    }
  }

  private type(ref: TypeRef | undefined): void {
    if (ref) {
      this.types.push(ref);
    }
  }

  private params(
    params: ReadonlyArray<Param>,
    scope: Scope,
    outer: Scope
  ): void {
    for (const param of params) {
      scope.locals.add(param.name);
      this.type(param.type);
      if (param.defaultValue) {
        this.walk(param.defaultValue, outer);
      }
    }
  }

  fn(decl: FuncDecl, scope: Scope): void {
    const name =
      decl.name && scope.kind !== 'function'
        ? scope.name
          ? `${scope.name}.${decl.name}`
          : decl.name
        : scope.name;
    const inner: Scope = {
      kind: 'function',
      name,
      parent: scope,
      locals: new Set(),
    };
    this.params(decl.params, inner, scope);
    this.type(decl.returnType);
    this.locals(decl.body.body, inner);
    this.statements(decl.body.body, inner);
  }

  statements(stmts: ReadonlyArray<Stmt>, scope: Scope): void {
    for (const stmt of stmts) {
      switch (stmt.type) {
        case 'Func': {
          this.fn(stmt, scope);
          break;
        }

        case 'Class': {
          const inner: Scope = {
            kind: 'class',
            name: scope.name ? `${scope.name}.${stmt.name}` : stmt.name,
            parent: scope,
            locals: new Set(),
            range: { start: stmt.start, end: stmt.end },
          };
          this.members(stmt.body.body, inner);
          this.statements(stmt.body.body, inner);
          break;
        }

        case 'Var': {
          this.type(stmt.typeRef);
          this.walk(stmt.value, scope);
          for (const accessor of [stmt.setter, stmt.getter]) {
            if (accessor) {
              this.fn(accessor, scope);
            }
          }

          break;
        }

        case 'For': {
          this.type(stmt.variableType);
          this.walk(stmt.iterable, scope);
          this.statements(stmt.body.body, scope);
          break;
        }

        case 'Signal': {
          for (const param of stmt.params) {
            this.type(param.type);
          }

          break;
        }

        default: {
          this.walk(stmt, scope);
        }
      }
    }
  }

  walk(node: unknown, scope: Scope): void {
    if (Array.isArray(node)) {
      for (const item of node) {
        this.walk(item, scope);
      }

      return;
    }

    if (!isObject(node)) {
      return;
    }

    const expr = node as unknown as Expr;
    switch (expr.type) {
      case 'Identifier': {
        this.occurrences.push({
          range: { start: expr.start, end: expr.end },
          name: expr.name,
          scope: resolve(expr.name, scope),
        });
        return;
      }

      case 'Attribute': {
        if (expr.object.type === 'Self') {
          this.occurrences.push({
            range: expr.nameSpan,
            name: expr.name,
            scope: undefined,
            member: classScope(scope),
          });
        } else {
          this.walk(expr.object, scope);
        }

        return;
      }

      case 'Lambda': {
        this.fn(expr.fn, scope);
        return;
      }

      case 'Cast':
      case 'Is': {
        this.walk(expr.expr, scope);
        this.type(expr.target);
        return;
      }

      case 'Call': {
        const callee = expr.callee;
        const calleeName =
          callee.type === 'Identifier'
            ? callee.name
            : callee.type === 'Attribute'
              ? callee.name
              : '';
        if (SIGNAL_CALLS.has(calleeName)) {
          const first = expr.args[0];
          if (
            first?.type === 'Literal' &&
            (first.kind === 'string' || first.kind === 'stringName')
          ) {
            this.signalStrings.push({
              range: {
                start: first.end - 1 - first.value.length,
                end: first.end - 1,
              },
              value: first.value,
            });
          }
        }

        break;
      }

      default: {
        break;
      }
    }

    // Blocks have no `type`: their statements may declare functions.
    if (Array.isArray(node.body) && node.type === undefined) {
      this.statements(node.body as Stmt[], scope);
      return;
    }

    for (const [key, value] of Object.entries(node)) {
      if (key !== 'type' && key !== 'start' && key !== 'end') {
        this.walk(value, scope);
      }
    }
  }
}

export function renameGDScriptSymbol(
  body: ReadonlyArray<Stmt>,
  symbols: ReadonlyArray<ScriptSymbol>,
  symbol: ScriptSymbol,
  name: string
): OpResult {
  const resolver = new Resolver();
  const script: Scope = { kind: 'script', name: '', locals: new Set() };
  resolver.members(body, script);
  resolver.statements(body, script);

  const edits: TextEdit[] = [];
  const replace = (range: SourceRange): void => {
    if (!edits.some((e) => e.start === range.start)) {
      edits.push({
        start: range.start,
        end: range.start + symbol.name.length,
        text: name,
      });
    }
  };

  const isFunctionScope = symbols.some(
    (s) =>
      (s.kind === 'function' || s.kind === 'method') &&
      qualifiedName(s) === symbol.scope
  );
  for (const o of resolver.occurrences) {
    if (o.name !== symbol.name) {
      continue;
    }

    const target = o.scope ?? o.member;
    const matches =
      symbol.kind === 'local' && isFunctionScope
        ? o.scope?.kind === 'function' && o.scope.name === symbol.scope
        : target !== undefined &&
          target.kind !== 'function' &&
          target.name === symbol.scope;
    if (matches) {
      replace(o.range);
    }
  }

  if (symbol.kind === 'signal') {
    for (const literal of resolver.signalStrings) {
      if (literal.value === symbol.name) {
        replace(literal.range);
      }
    }
  }

  if (symbol.kind === 'class' || symbol.kind === 'enum') {
    const word = new RegExp(String.raw`\b${symbol.name}\b`, 'g');
    for (const ref of resolver.types) {
      for (const match of ref.name.matchAll(word)) {
        replace({
          start: ref.start + match.index,
          end: ref.start + match.index + symbol.name.length,
        });
      }
    }
  }

  replace(symbol.nameRange);
  return { ok: true, edits };
}

/**
 * Calls of a function in the same file: by name inside its class, or as
 * `self.name(…)`.
 */
export function gdscriptCallSites(
  body: ReadonlyArray<Stmt>,
  text: string,
  symbol: ScriptSymbol
): CallSite[] {
  const resolver = new Resolver();
  const script: Scope = { kind: 'script', name: '', locals: new Set() };
  resolver.members(body, script);
  resolver.statements(body, script);
  const uses = new Set(
    resolver.occurrences
      .filter(
        (o) =>
          o.name === symbol.name &&
          (o.scope ?? o.member)?.kind !== 'function' &&
          (o.scope ?? o.member)?.name === symbol.scope
      )
      .map((o) => o.range.start)
  );

  const sites: CallSite[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item);
      }

      return;
    }

    if (!isObject(node)) {
      return;
    }

    const expr = node as unknown as Expr;
    if (expr.type === 'Call') {
      // A signal is called with `emit` (`changed.emit(…)`).
      const callee =
        symbol.kind === 'signal' &&
        expr.callee.type === 'Attribute' &&
        expr.callee.name === 'emit'
          ? expr.callee.object
          : expr.callee;
      const start =
        callee.type === 'Identifier'
          ? callee.start
          : callee.type === 'Attribute' && callee.object.type === 'Self'
            ? callee.nameSpan.start
            : -1;
      if (uses.has(start)) {
        sites.push({
          open: text.indexOf('(', expr.callee.end) + 1,
          close: expr.end - 1,
          args: expr.args.map((a) => ({ start: a.start, end: a.end })),
        });
      }
    }

    for (const [key, value] of Object.entries(node)) {
      if (key !== 'type' && key !== 'start' && key !== 'end') {
        walk(value);
      }
    }
  };

  walk(body);
  return sites;
}
