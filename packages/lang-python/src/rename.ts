import type {
  OpResult,
  ScriptSymbol,
  SourceRange,
  TextEdit,
} from '@vizscript/core';
import { qualifiedName } from '@vizscript/core';
import type { ClassDef, Expr, FunctionDef, Param, Stmt } from './ast';

interface Scope {
  kind: 'module' | 'function' | 'class' | 'lambda';
  /** Qualified name of a function or class (`Cart.add`). */
  name: string;
  parent?: Scope;
  locals: Set<string>;
  /** `global` / `nonlocal` names of a function. */
  outer: Set<string>;
}

interface Occurrence {
  range: SourceRange;
  name: string;
  scope: Scope | undefined;
}

type AnyNode = Record<string, unknown>;

function isObject(value: unknown): value is AnyNode {
  return value !== null && typeof value === 'object';
}

/** Names bound by an assignment target (`a`, `a, b`, `(a, [b])`). */
function targetNames(target: Expr | undefined, into: Set<string>): void {
  if (target?.type === 'Name') {
    into.add(target.name);
  } else if (target?.type === 'Collection') {
    for (const item of target.items) {
      targetNames(item, into);
    }
  } else if (target?.type === 'Paren') {
    targetNames(target.expr, into);
  } else if (target?.type === 'Starred') {
    targetNames(target.value, into);
  }
}

class Resolver {
  readonly occurrences: Occurrence[] = [];

  constructor(private readonly text: string) {}

  /** Names a block binds (not inside nested functions or classes). */
  bindings(stmts: ReadonlyArray<Stmt>, scope: Scope): void {
    for (const stmt of stmts) {
      switch (stmt.type) {
        case 'Assign': {
          for (const target of stmt.targets) {
            targetNames(target, scope.locals);
          }

          break;
        }

        case 'AugAssign': {
          targetNames(stmt.target, scope.locals);
          break;
        }

        case 'For': {
          targetNames(stmt.target, scope.locals);
          this.bindings(stmt.body.body, scope);
          this.bindings(stmt.orelse?.body ?? [], scope);
          break;
        }

        case 'While': {
          this.bindings(stmt.body.body, scope);
          this.bindings(stmt.orelse?.body ?? [], scope);
          break;
        }

        case 'If': {
          this.bindings(stmt.body.body, scope);
          for (const elif of stmt.elifs) {
            this.bindings(elif.body.body, scope);
          }

          this.bindings(stmt.orelse?.body ?? [], scope);
          break;
        }

        case 'With': {
          for (const item of stmt.items) {
            targetNames(item.target, scope.locals);
          }

          this.bindings(stmt.body.body, scope);
          break;
        }

        case 'Try': {
          this.bindings(stmt.body.body, scope);
          for (const handler of stmt.handlers) {
            if (handler.name) {
              scope.locals.add(handler.name);
            }

            this.bindings(handler.body.body, scope);
          }

          this.bindings(stmt.orelse?.body ?? [], scope);
          this.bindings(stmt.finalbody?.body ?? [], scope);
          break;
        }

        case 'Match': {
          for (const branch of stmt.cases) {
            this.bindings(branch.body.body, scope);
          }

          break;
        }

        case 'FunctionDef':
        case 'ClassDef': {
          scope.locals.add(stmt.name);
          break;
        }

        case 'Import': {
          // `import a.b as c`, `from x import a, b as c`
          const source = this.text.slice(stmt.start, stmt.end);
          const names = source
            .replace(/^\s*from\s+\S+\s+import\s+/, '')
            .replace(/^\s*import\s+/, '')
            .replaceAll(/[()\\\n]/g, ' ')
            .split(',');
          for (const part of names) {
            const alias = part.trim().split(/\s+as\s+/);
            const name = (alias[1] ?? alias[0] ?? '').split('.')[0]?.trim();
            if (name && name !== '*') {
              scope.locals.add(name);
            }
          }

          break;
        }

        case 'Scope': {
          // `global a, b` / `nonlocal a`
          const source = this.text.slice(stmt.start, stmt.end);
          for (const name of source
            .replace(/^\s*(?:global|nonlocal)\s+/, '')
            .split(',')) {
            scope.outer.add(name.trim());
          }

          break;
        }

        default: {
          break;
        }
      }
    }
  }

  /** The scope that binds `name` for a use in `scope` (Python rules). */
  private resolve(name: string, scope: Scope): Scope | undefined {
    let current: Scope | undefined = scope;
    let first = true;
    while (current) {
      // Class bodies are only visible to code directly inside them.
      const visible = current.kind !== 'class' || first;
      if (visible && current.locals.has(name) && !current.outer.has(name)) {
        return current;
      }

      if (current.outer.has(name) && current.kind === 'function') {
        // `global` skips to the module.
        let module: Scope | undefined = current;
        while (module.parent) {
          module = module.parent;
        }

        return module.locals.has(name) ? module : undefined;
      }

      first = false;
      current = current.parent;
    }

    return undefined;
  }

  private newScope(kind: Scope['kind'], name: string, parent: Scope): Scope {
    return { kind, name, parent, locals: new Set(), outer: new Set() };
  }

  private params(
    params: ReadonlyArray<Param>,
    scope: Scope,
    outer: Scope
  ): void {
    for (const param of params) {
      scope.locals.add(param.name.replace(/^\*+/, ''));
      // Annotations and defaults are evaluated outside the function.
      if (param.annotation) {
        this.walk(param.annotation, outer);
      }

      if (param.defaultValue) {
        this.walk(param.defaultValue, outer);
      }
    }
  }

  private fn(def: FunctionDef, scope: Scope): void {
    for (const decorator of def.decorators) {
      this.walk(decorator, scope);
    }

    const qualified =
      scope.kind === 'module' ? def.name : `${scope.name}.${def.name}`;
    const inner = this.newScope('function', qualified, scope);
    this.params(def.params, inner, scope);
    if (def.returns) {
      this.walk(def.returns, scope);
    }

    this.bindings(def.body.body, inner);
    this.statements(def.body.body, inner);
  }

  private cls(def: ClassDef, scope: Scope): void {
    for (const decorator of def.decorators) {
      this.walk(decorator, scope);
    }

    for (const base of def.bases) {
      this.walk(base, scope);
    }

    const qualified =
      scope.kind === 'module' ? def.name : `${scope.name}.${def.name}`;
    const inner = this.newScope('class', qualified, scope);
    this.bindings(def.body.body, inner);
    this.statements(def.body.body, inner);
  }

  statements(stmts: ReadonlyArray<Stmt>, scope: Scope): void {
    for (const stmt of stmts) {
      if (stmt.type === 'FunctionDef') {
        this.fn(stmt, scope);
      } else if (stmt.type === 'ClassDef') {
        this.cls(stmt, scope);
      } else {
        this.walk(stmt, scope);
      }
    }
  }

  /** Visits every expression below `node`, recording names. */
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

    switch (node.type) {
      case 'Name': {
        const name = node.name as string;
        this.occurrences.push({
          range: { start: node.start as number, end: node.end as number },
          name,
          scope: this.resolve(name, scope),
        });
        return;
      }

      case 'Lambda': {
        const inner = this.newScope('lambda', scope.name, scope);
        this.params(node.params as Param[], inner, scope);
        this.walk(node.body, inner);
        return;
      }

      case 'FunctionDef': {
        this.fn(node as unknown as FunctionDef, scope);
        return;
      }

      case 'ClassDef': {
        this.cls(node as unknown as ClassDef, scope);
        return;
      }

      default: {
        break;
      }
    }

    // Blocks have no `type`; their statements may define functions.
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

/** All names of a module with the scope that binds each of them. */
function resolveModule(
  body: ReadonlyArray<Stmt>,
  text: string
): { occurrences: Occurrence[]; module: Scope } {
  const resolver = new Resolver(text);
  const module: Scope = {
    kind: 'module',
    name: '',
    locals: new Set(),
    outer: new Set(),
  };
  // Bindings first: names may be used before they are assigned.
  resolver.bindings(body, module);
  resolver.statements(body, module);
  return { occurrences: resolver.occurrences, module };
}

/** `self.name` / `cls.name` / `Class.name` uses of a class member. */
function memberEdits(
  body: ReadonlyArray<Stmt>,
  cls: ScriptSymbol,
  oldName: string,
  newName: string
): TextEdit[] {
  const edits: TextEdit[] = [];
  const className = cls.name;
  const walk = (node: unknown, selves: ReadonlySet<string>): void => {
    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item, selves);
      }

      return;
    }

    if (!isObject(node)) {
      return;
    }

    if (node.type === 'Attribute' && node.name === oldName) {
      const object = node.object as AnyNode;
      if (
        object.type === 'Name' &&
        (selves.has(object.name as string) || object.name === className)
      ) {
        const end = node.end as number;
        edits.push({ start: end - oldName.length, end, text: newName });
      }
    }

    let inner = selves;
    if (node.type === 'FunctionDef') {
      const def = node as unknown as FunctionDef;
      const inClass = def.start >= cls.range.start && def.end <= cls.range.end;
      const first = def.params[0]?.name;
      inner = inClass && first ? new Set([first]) : selves;
    }

    for (const [key, value] of Object.entries(node)) {
      if (key !== 'type' && key !== 'start' && key !== 'end') {
        walk(value, inner);
      }
    }
  };

  walk(body, new Set());
  return edits;
}

export function renamePythonSymbol(
  body: ReadonlyArray<Stmt>,
  text: string,
  symbols: ReadonlyArray<ScriptSymbol>,
  symbol: ScriptSymbol,
  name: string
): OpResult {
  const replace = (range: SourceRange): TextEdit => ({
    start: range.start,
    end: range.start + symbol.name.length,
    text: name,
  });

  const owner = symbols.find(
    (s) =>
      (s.kind === 'class' || s.kind === 'enum') &&
      qualifiedName(s) === symbol.scope
  );
  if (owner) {
    // A method or class attribute: its declaration, `self.x`, `Class.x`.
    const edits = memberEdits(body, owner, symbol.name, name);
    const { occurrences } = resolveModule(body, text);
    for (const o of occurrences) {
      if (
        o.name === symbol.name &&
        o.scope?.kind === 'class' &&
        o.scope.name === symbol.scope
      ) {
        edits.push(replace(o.range));
      }
    }

    if (!edits.some((e) => e.start === symbol.nameRange.start)) {
      edits.push(replace(symbol.nameRange));
    }

    return { ok: true, edits };
  }

  const { occurrences } = resolveModule(body, text);
  const matches = (o: Occurrence): boolean =>
    o.name === symbol.name &&
    (symbol.kind === 'local'
      ? o.scope?.kind === 'function' && o.scope.name === symbol.scope
      : o.scope?.kind === 'module');
  const edits = occurrences.filter(matches).map((o) => replace(o.range));
  if (!edits.some((e) => e.start === symbol.nameRange.start)) {
    edits.push(replace(symbol.nameRange));
  }

  return { ok: true, edits };
}
