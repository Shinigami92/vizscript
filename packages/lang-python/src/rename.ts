import type { SyntaxNode, Tree } from '@lezer/common';
import { parser } from '@lezer/python';
import type {
  CallSite,
  OpResult,
  ScriptSymbol,
  SourceRange,
  TextEdit,
} from '@vizscript/core';
import { qualifiedName } from '@vizscript/core';
import type { ClassDef, Expr, FunctionDef, Param, Span, Stmt } from './ast';
import { maskForParser } from './convert-utils';

interface Scope {
  kind: 'module' | 'function' | 'class' | 'lambda' | 'comprehension';
  /** Qualified name of a function or class (`Cart.add`). */
  name: string;
  parent?: Scope;
  locals: Set<string>;
  /** `global` names of a function: bound by the module. */
  globals: Set<string>;
  /** `nonlocal` names: bound by the nearest enclosing function. */
  nonlocals: Set<string>;
}

const COMPREHENSIONS = new Set([
  'ArrayComprehensionExpression',
  'DictionaryComprehensionExpression',
  'SetComprehensionExpression',
  'ComprehensionExpression',
]);

function kids(node: SyntaxNode): SyntaxNode[] {
  const result: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    result.push(child);
  }

  return result;
}

/**
 * A `VariableName` that names a variable: not the member after a `.`
 * (`deco.x` in a decorator), a keyword (`f(key=1)`, `P(x=0)`), or the
 * name after `as`.
 */
function isVariable(node: SyntaxNode): boolean {
  const before = node.prevSibling?.name;
  const after = node.nextSibling?.name;
  return (
    node.name === 'VariableName' &&
    before !== '.' &&
    !(after === 'AssignOp' && node.parent?.name === 'ArgList') &&
    !(node.parent?.name === 'KeywordPattern' && !before)
  );
}

/** Names a match pattern captures (`case [a, *rest] as c`). */
function patternBindings(
  node: SyntaxNode,
  into: Set<string>,
  text: string
): void {
  for (const kid of kids(node)) {
    const captured =
      kid.name === 'VariableName' &&
      (node.name === 'CapturePattern' ||
        (node.name === 'AsPattern' && kid.prevSibling?.name === 'as'));
    if (captured) {
      into.add(text.slice(kid.from, kid.to));
    } else {
      patternBindings(kid, into, text);
    }
  }
}

interface Occurrence {
  range: SourceRange;
  name: string;
  scope: Scope | undefined;
}

type AnyNode = Record<string, unknown>;

function nodeSpan(node: AnyNode): Span {
  return { start: node.start as number, end: node.end as number };
}

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

  constructor(
    private readonly text: string,
    private readonly tree: Tree
  ) {}

  /** The syntax nodes that make up `span` (outermost first). */
  private nodesIn(span: Span): SyntaxNode[] {
    const found: SyntaxNode[] = [];
    this.tree.iterate({
      from: span.start,
      to: span.end,
      enter: (ref) => {
        if (ref.from >= span.start && ref.to <= span.end) {
          found.push(ref.node);
          return false;
        }

        return ref.to > span.start && ref.from < span.end;
      },
    });
    return found;
  }

  /** The syntax node of a statement or expression the AST keeps whole. */
  private nodeAt(
    span: Span,
    names: ReadonlySet<string>
  ): SyntaxNode | undefined {
    let node: SyntaxNode | null = this.tree.resolveInner(span.start, 1);
    while (node && !(names.has(node.name) && node.from === span.start)) {
      node = node.parent;
    }

    return node ?? undefined;
  }

  private record(node: SyntaxNode, scope: Scope): void {
    const name = this.text.slice(node.from, node.to);
    this.occurrences.push({
      range: { start: node.from, end: node.to },
      name,
      scope: this.resolve(name, scope),
    });
  }

  /**
   * Names in code the AST keeps as a span (annotations, decorators,
   * patterns) or only partly (comprehensions), from the syntax tree.
   */
  private spanNames(span: Span, scope: Scope): void {
    for (const node of this.nodesIn(span)) {
      this.treeNames(node, scope);
    }
  }

  private treeNames(node: SyntaxNode, scope: Scope): void {
    if (COMPREHENSIONS.has(node.name)) {
      this.comprehension(node, scope);
      return;
    }

    if (node.name === 'VariableName') {
      if (isVariable(node)) {
        this.record(node, scope);
      }

      return;
    }

    for (const kid of kids(node)) {
      this.treeNames(kid, scope);
    }
  }

  /**
   * A comprehension is a scope of its own: its `for` targets are local,
   * and only the first iterable is evaluated in the code around it.
   */
  private comprehension(node: SyntaxNode, scope: Scope): void {
    const inner = this.newScope('comprehension', scope.name, scope);
    // Without the brackets.
    const parts = kids(node).slice(1, -1);
    const clauses = (
      visit: (
        part: SyntaxNode,
        clause: 'element' | 'target' | 'iter' | 'if',
        first: boolean
      ) => void
    ): void => {
      let clause: 'element' | 'target' | 'iter' | 'if' = 'element';
      let fors = 0;
      for (const part of parts) {
        if (part.name === 'for') {
          clause = 'target';
          fors++;
        } else if (part.name === 'in' && clause === 'target') {
          clause = 'iter';
        } else if (part.name === 'if') {
          clause = 'if';
        } else if (part.name !== 'async') {
          visit(part, clause, fors === 1);
        }
      }
    };

    clauses((part, clause) => {
      if (clause === 'target') {
        this.boundNames(part, inner.locals);
      }
    });
    clauses((part, clause, first) => {
      this.treeNames(part, clause === 'iter' && first ? scope : inner);
    });
  }

  /** Every name in an assignment target (`k`, `k, v`, `(a, [b])`). */
  private boundNames(node: SyntaxNode, into: Set<string>): void {
    if (node.name === 'VariableName') {
      into.add(this.text.slice(node.from, node.to));
      return;
    }

    for (const kid of kids(node)) {
      this.boundNames(kid, into);
    }
  }

  /** Names an import statement binds (`import a.b as c`, `from x import y`). */
  private importBindings(span: Span, scope: Scope): void {
    const node = this.nodeAt(span, new Set(['ImportStatement']));
    if (!node) {
      return;
    }

    const parts = kids(node);
    const importAt = parts.findIndex((k) => k.name === 'import');
    let item: SyntaxNode[] = [];
    const bind = (): void => {
      const asAt = item.findIndex((k) => k.name === 'as');
      const named = asAt === -1 ? item[0] : item[asAt + 1];
      // `import a.b` binds `a`; `from x import a` binds `a`.
      if (named?.name === 'VariableName') {
        scope.locals.add(this.text.slice(named.from, named.to));
      }

      item = [];
    };

    for (const part of parts.slice(importAt + 1)) {
      if (part.name === ',') {
        bind();
      } else if (!['(', ')', 'Comment', '*'].includes(part.name)) {
        item.push(part);
      }
    }

    bind();
  }

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
            for (const node of this.nodesIn(branch.pattern)) {
              patternBindings(node, scope.locals, this.text);
            }

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
          this.importBindings(stmt, scope);
          break;
        }

        case 'Scope': {
          // `global a, b` / `nonlocal a`
          const node = this.nodeAt(stmt, new Set(['ScopeStatement']));
          const outer =
            node?.firstChild?.name === 'nonlocal'
              ? scope.nonlocals
              : scope.globals;
          for (const kid of node ? kids(node) : []) {
            if (kid.name === 'VariableName') {
              outer.add(this.text.slice(kid.from, kid.to));
            }
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
      if (current.globals.has(name)) {
        // `global` skips to the module.
        let module: Scope = current;
        while (module.parent) {
          module = module.parent;
        }

        return module.locals.has(name) ? module : undefined;
      }

      if (current.nonlocals.has(name)) {
        // `nonlocal`: the nearest enclosing function that binds it.
        let outer = current.parent;
        while (
          outer &&
          !(outer.kind === 'function' && outer.locals.has(name))
        ) {
          outer = outer.parent;
        }

        return outer;
      }

      // Class bodies are only visible to code directly inside them.
      const visible = current.kind !== 'class' || first;
      if (visible && current.locals.has(name)) {
        return current;
      }

      first = false;
      current = current.parent;
    }

    return undefined;
  }

  private newScope(kind: Scope['kind'], name: string, parent: Scope): Scope {
    return {
      kind,
      name,
      parent,
      locals: new Set(),
      globals: new Set(),
      nonlocals: new Set(),
    };
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
        this.spanNames(param.annotation, outer);
      }

      if (param.defaultValue) {
        this.walk(param.defaultValue, outer);
      }
    }
  }

  private fn(def: FunctionDef, scope: Scope): void {
    for (const decorator of def.decorators) {
      this.spanNames(decorator, scope);
    }

    const qualified =
      scope.kind === 'module' ? def.name : `${scope.name}.${def.name}`;
    const inner = this.newScope('function', qualified, scope);
    this.params(def.params, inner, scope);
    if (def.returns) {
      this.spanNames(def.returns, scope);
    }

    this.bindings(def.body.body, inner);
    this.statements(def.body.body, inner);
  }

  private cls(def: ClassDef, scope: Scope): void {
    for (const decorator of def.decorators) {
      this.spanNames(decorator, scope);
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

      case 'Comprehension': {
        const syntax = this.nodeAt(nodeSpan(node), COMPREHENSIONS);
        if (syntax) {
          this.comprehension(syntax, scope);
        }

        return;
      }

      case 'Assign': {
        if (node.annotation) {
          this.spanNames(node.annotation as Span, scope);
        }

        break;
      }

      case 'Match': {
        for (const branch of node.cases as Array<{ pattern: Span }>) {
          this.spanNames(branch.pattern, scope);
        }

        break;
      }

      case 'Scope': {
        // The names of `global x` / `nonlocal x` themselves.
        this.spanNames(nodeSpan(node), scope);
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
  const resolver = new Resolver(text, parser.parse(maskForParser(text)));
  const module: Scope = {
    kind: 'module',
    name: '',
    locals: new Set(),
    globals: new Set(),
    nonlocals: new Set(),
  };
  // Bindings first: names may be used before they are assigned.
  resolver.bindings(body, module);
  resolver.statements(body, module);
  return { occurrences: resolver.occurrences, module };
}

/**
 * Walks the module knowing which names are `self` (or `cls`) of `owner`'s
 * instances: the first parameter of its methods (not of static ones), also
 * in functions nested in a method unless they take a parameter of that name.
 */
function walkWithSelves(
  body: ReadonlyArray<Stmt>,
  text: string,
  owner: ScriptSymbol,
  visit: (node: AnyNode, selves: ReadonlySet<string>) => void
): void {
  const walk = (
    node: unknown,
    selves: ReadonlySet<string>,
    methods: boolean
  ): void => {
    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item, selves, methods);
      }

      return;
    }

    if (!isObject(node)) {
      return;
    }

    visit(node, selves);
    let inner = selves;
    let innerMethods = methods;
    if (node.type === 'ClassDef') {
      const def = node as unknown as ClassDef;
      // Functions directly in the owner's body are its methods.
      innerMethods =
        def.name === owner.name &&
        def.start >= owner.range.start &&
        def.end <= owner.range.end;
    } else if (node.type === 'FunctionDef') {
      const def = node as unknown as FunctionDef;
      const params = def.params.map((p) => p.name.replace(/^\*+/, ''));
      const isStatic = def.decorators.some((d) =>
        /^@\s*staticmethod\b/.test(text.slice(d.start, d.end))
      );
      inner = methods
        ? new Set(!isStatic && params[0] ? [params[0]] : [])
        : new Set([...selves].filter((n) => !params.includes(n)));
      innerMethods = false;
    }

    for (const [key, value] of Object.entries(node)) {
      if (key !== 'type' && key !== 'start' && key !== 'end') {
        walk(value, inner, innerMethods);
      }
    }
  };

  walk(body, new Set(), false);
}

/** `self.name` / `cls.name` / `Class.name` uses of a class member. */
function memberEdits(
  body: ReadonlyArray<Stmt>,
  text: string,
  cls: ScriptSymbol,
  oldName: string,
  newName: string
): TextEdit[] {
  const edits: TextEdit[] = [];
  walkWithSelves(body, text, cls, (node, selves) => {
    if (node.type === 'Attribute' && node.name === oldName) {
      const object = node.object as AnyNode;
      if (
        object.type === 'Name' &&
        (selves.has(object.name as string) || object.name === cls.name)
      ) {
        const end = node.end as number;
        edits.push({ start: end - oldName.length, end, text: newName });
      }
    }
  });
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
    const edits = memberEdits(body, text, owner, symbol.name, name);
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

/**
 * Calls of a function (by name) or a method (`self.name(…)`,
 * `Class.name(…)`) in the same file. Calls with `*args` are left alone.
 */
export function pythonCallSites(
  body: ReadonlyArray<Stmt>,
  text: string,
  symbols: ReadonlyArray<ScriptSymbol>,
  symbol: ScriptSymbol
): CallSite[] {
  const owner =
    symbol.kind === 'method'
      ? symbols.find(
          (s) =>
            (s.kind === 'class' || s.kind === 'enum') &&
            qualifiedName(s) === symbol.scope
        )
      : undefined;
  const { occurrences } = resolveModule(body, text);
  const uses = new Set(
    owner
      ? []
      : occurrences
          .filter((o) => o.name === symbol.name && o.scope?.kind === 'module')
          .map((o) => o.range.start)
  );

  const sites: CallSite[] = [];
  const visit = (node: AnyNode, selves: ReadonlySet<string>): void => {
    if (node.type !== 'Call') {
      return;
    }

    const callee = node.callee as AnyNode;
    const object = callee.object as AnyNode | undefined;
    const matches = owner
      ? callee.type === 'Attribute' &&
        callee.name === symbol.name &&
        object?.type === 'Name' &&
        (selves.has(object.name as string) || object.name === owner.name)
      : callee.type === 'Name' && uses.has(callee.start as number);
    const args = node.args as AnyNode[];
    if (matches && !args.some((a) => a.star)) {
      sites.push({
        open: text.indexOf('(', callee.end as number) + 1,
        close: (node.end as number) - 1,
        args: args
          .filter((a) => !a.keyword)
          .map((a) => ({ start: a.start as number, end: a.end as number })),
        keywords: args
          .filter((a) => a.keyword)
          .map((a) => ({
            name: a.keyword as string,
            range: { start: a.start as number, end: a.end as number },
          })),
      });
    }
  };

  if (owner) {
    walkWithSelves(body, text, owner, visit);
  } else {
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(walk);
      } else if (isObject(node)) {
        visit(node, new Set());
        for (const [key, value] of Object.entries(node)) {
          if (key !== 'type' && key !== 'start' && key !== 'end') {
            walk(value);
          }
        }
      }
    };
    walk(body);
  }

  return sites;
}
