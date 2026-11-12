import type * as t from '@babel/types';
import type {
  CallSite,
  OpResult,
  ScriptSymbol,
  TextEdit,
} from '@vizscript/core';

/** A name in the code and the declaration it resolves to. */
interface Occurrence {
  start: number;
  name: string;
  /** Start of the declaring identifier; `undefined` for globals. */
  binding: number | undefined;
  /** `{ name }` shorthand: the key must stay. */
  shorthand?: boolean;
  /** `export { name }`: the exported name must stay. */
  exported?: boolean;
}

class Scope {
  readonly names = new Map<string, number>();

  constructor(
    readonly parent: Scope | undefined,
    readonly isFunction: boolean
  ) {}

  lookup(name: string): number | undefined {
    return this.names.get(name) ?? this.parent?.lookup(name);
  }

  functionScope(): Scope {
    return this.isFunction || !this.parent ? this : this.parent.functionScope();
  }
}

type Node = t.Node;

function isNode(value: unknown): value is Node {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'ObjectMethod',
  'ClassMethod',
  'ClassPrivateMethod',
  'TSDeclareFunction',
  'TSDeclareMethod',
]);

/** Keys whose identifiers are names, not references to bindings. */
function isNameOnly(parent: Node, key: string): boolean {
  switch (parent.type) {
    case 'MemberExpression':
    case 'OptionalMemberExpression': {
      return key === 'property' && !parent.computed;
    }

    case 'ObjectProperty':
    case 'ObjectMethod':
    case 'ClassProperty':
    case 'ClassMethod':
    case 'ClassAccessorProperty':
    case 'TSPropertySignature':
    case 'TSMethodSignature': {
      return key === 'key' && !parent.computed;
    }

    case 'LabeledStatement':
    case 'BreakStatement':
    case 'ContinueStatement': {
      return key === 'label';
    }

    case 'TSQualifiedName': {
      return key === 'right';
    }

    case 'TSEnumMember': {
      return key === 'id';
    }

    case 'ExportSpecifier': {
      return key === 'exported';
    }

    case 'MetaProperty': {
      return true;
    }

    default: {
      return false;
    }
  }
}

class Resolver {
  readonly occurrences: Occurrence[] = [];

  /** Declares the names of a binding pattern. */
  private declare(pattern: Node | null | undefined, scope: Scope): void {
    switch (pattern?.type) {
      case 'Identifier': {
        scope.names.set(pattern.name, pattern.start ?? 0);
        break;
      }

      case 'ObjectPattern': {
        for (const prop of pattern.properties) {
          this.declare(
            prop.type === 'RestElement' ? prop.argument : prop.value,
            scope
          );
        }

        break;
      }

      case 'ArrayPattern': {
        for (const element of pattern.elements) {
          this.declare(element, scope);
        }

        break;
      }

      case 'AssignmentPattern': {
        this.declare(pattern.left, scope);
        break;
      }

      case 'RestElement': {
        this.declare(pattern.argument, scope);
        break;
      }

      case 'TSParameterProperty': {
        this.declare(pattern.parameter, scope);
        break;
      }

      default: {
        break;
      }
    }
  }

  /** `var` declarations anywhere in a function body (not nested ones). */
  private hoistVars(node: Node, scope: Scope): void {
    if (node.type === 'VariableDeclaration' && node.kind === 'var') {
      for (const d of node.declarations) {
        this.declare(d.id, scope);
      }
    }

    for (const [key, value] of Object.entries(node)) {
      if (key === 'loc' || key.endsWith('Comments')) {
        continue;
      }

      for (const child of Array.isArray(value) ? value : [value]) {
        if (isNode(child) && !FUNCTION_TYPES.has(child.type)) {
          this.hoistVars(child, scope);
        }
      }
    }
  }

  /** Block-level declarations (`let`, `const`, functions, classes, …). */
  private hoist(statements: ReadonlyArray<Node>, scope: Scope): void {
    for (const raw of statements) {
      let stmt: Node = raw;
      if (
        (stmt.type === 'ExportNamedDeclaration' ||
          stmt.type === 'ExportDefaultDeclaration') &&
        stmt.declaration
      ) {
        stmt = stmt.declaration;
      }

      switch (stmt.type) {
        case 'VariableDeclaration': {
          if (stmt.kind !== 'var') {
            for (const d of stmt.declarations) {
              this.declare(d.id, scope);
            }
          }

          break;
        }

        case 'FunctionDeclaration':
        case 'TSDeclareFunction':
        case 'ClassDeclaration':
        case 'TSInterfaceDeclaration':
        case 'TSTypeAliasDeclaration':
        case 'TSEnumDeclaration': {
          if (stmt.id) {
            scope.names.set(stmt.id.name, stmt.id.start ?? 0);
          }

          break;
        }

        case 'ImportDeclaration': {
          for (const specifier of stmt.specifiers) {
            scope.names.set(specifier.local.name, specifier.local.start ?? 0);
          }

          break;
        }

        default: {
          break;
        }
      }
    }
  }

  private record(
    id: t.Identifier,
    scope: Scope,
    parent: Node | undefined
  ): void {
    const start = id.start ?? 0;
    this.occurrences.push({
      start,
      name: id.name,
      binding: scope.lookup(id.name),
      ...(parent?.type === 'ObjectProperty' &&
      parent.shorthand &&
      parent.key.start === start
        ? { shorthand: true }
        : {}),
      ...(parent?.type === 'ExportSpecifier' && parent.exported.start === start
        ? { exported: true }
        : {}),
    });
  }

  private fn(node: Node, scope: Scope): void {
    const inner = new Scope(scope, true);
    if (
      (node.type === 'FunctionExpression' ||
        node.type === 'ClassMethod' ||
        node.type === 'ObjectMethod') &&
      'id' in node &&
      node.id
    ) {
      inner.names.set(node.id.name, node.id.start ?? 0);
    }

    const params = 'params' in node ? (node.params as Node[]) : [];
    for (const param of params) {
      this.declare(param, inner);
    }

    const body = 'body' in node ? (node.body as Node | undefined) : undefined;
    if (body) {
      this.hoistVars(body, inner);
      if (body.type === 'BlockStatement') {
        this.hoist(body.body, inner);
      }
    }

    for (const [key, value] of Object.entries(node)) {
      if (key === 'id' || key === 'body' || key === 'key') {
        if (key === 'key' && 'computed' in node && node.computed) {
          this.children(value, scope, node, key);
        }

        continue;
      }

      this.children(value, inner, node, key);
    }

    if (body?.type === 'BlockStatement') {
      for (const stmt of body.body) {
        this.visit(stmt, inner);
      }
    } else if (body) {
      this.visit(body, inner);
    }
  }

  private children(
    value: unknown,
    scope: Scope,
    parent: Node,
    key: string
  ): void {
    if (key === 'loc' || key.endsWith('Comments')) {
      return;
    }

    for (const child of Array.isArray(value) ? value : [value]) {
      if (!isNode(child)) {
        continue;
      }

      if (child.type === 'Identifier') {
        if (!isNameOnly(parent, key)) {
          this.record(child, scope, parent);
        }

        // The type annotation of an identifier is code of its own.
        if (child.typeAnnotation) {
          this.visit(child.typeAnnotation, scope);
        }
      } else {
        this.visit(child, scope);
      }
    }
  }

  visit(node: Node, scope: Scope): void {
    if (FUNCTION_TYPES.has(node.type)) {
      if (node.type === 'FunctionDeclaration' && node.id) {
        this.record(node.id, scope, undefined);
      }

      this.fn(node, scope);
      return;
    }

    let inner = scope;
    switch (node.type) {
      case 'Program': {
        inner = new Scope(undefined, true);
        this.hoistVars(node, inner);
        this.hoist(node.body, inner);
        for (const stmt of node.body) {
          this.visit(stmt, inner);
        }

        return;
      }

      case 'BlockStatement':
      case 'StaticBlock': {
        inner = new Scope(scope, false);
        this.hoist(node.body, inner);
        break;
      }

      case 'ForStatement':
      case 'ForInStatement':
      case 'ForOfStatement':
      case 'SwitchStatement': {
        inner = new Scope(scope, false);
        const decl =
          node.type === 'ForStatement'
            ? node.init
            : 'left' in node
              ? node.left
              : undefined;
        if (decl?.type === 'VariableDeclaration' && decl.kind !== 'var') {
          for (const d of decl.declarations) {
            this.declare(d.id, inner);
          }
        }

        if (node.type === 'SwitchStatement') {
          this.hoist(
            node.cases.flatMap((c) => c.consequent),
            inner
          );
        }

        break;
      }

      case 'CatchClause': {
        inner = new Scope(scope, false);
        this.declare(node.param, inner);
        break;
      }

      case 'ClassExpression': {
        if (node.id) {
          inner = new Scope(scope, false);
          inner.names.set(node.id.name, node.id.start ?? 0);
        }

        break;
      }

      case 'ImportDeclaration': {
        // Imported names are declarations of the module, not renamed here.
        return;
      }

      default: {
        break;
      }
    }

    for (const [key, value] of Object.entries(node)) {
      this.children(value, inner, node, key);
    }
  }
}

/** Every identifier of the program, resolved to its declaration. */
export function resolveNames(program: t.Program): Occurrence[] {
  const resolver = new Resolver();
  resolver.visit(program, new Scope(undefined, true));
  return resolver.occurrences;
}

/** `this.name` / `this.#name` uses and the member keys of a class. */
function memberEdits(
  program: t.Program,
  cls: ScriptSymbol,
  oldName: string,
  newName: string
): TextEdit[] {
  const edits: TextEdit[] = [];
  const inClass = (node: Node): boolean =>
    (node.start ?? 0) >= cls.range.start && (node.end ?? 0) <= cls.range.end;

  const visit = (node: Node): void => {
    if (!inClass(node) && node.type !== 'Program') {
      const containsClass =
        (node.start ?? 0) <= cls.range.start &&
        (node.end ?? 0) >= cls.range.end;
      if (!containsClass) {
        return;
      }
    }

    if (
      (node.type === 'MemberExpression' ||
        node.type === 'OptionalMemberExpression') &&
      node.object.type === 'ThisExpression' &&
      !node.computed &&
      node.property.type === 'Identifier' &&
      node.property.name === oldName
    ) {
      const start = node.property.start ?? 0;
      edits.push({ start, end: start + oldName.length, text: newName });
    }

    if (
      (node.type === 'ClassMethod' ||
        node.type === 'ClassProperty' ||
        node.type === 'ClassAccessorProperty') &&
      !node.computed &&
      node.key.type === 'Identifier' &&
      node.key.name === oldName &&
      inClass(node)
    ) {
      const start = node.key.start ?? 0;
      edits.push({ start, end: start + oldName.length, text: newName });
    }

    for (const [key, value] of Object.entries(node)) {
      if (key === 'loc' || key.endsWith('Comments')) {
        continue;
      }

      for (const child of Array.isArray(value) ? value : [value]) {
        if (isNode(child)) {
          visit(child);
        }
      }
    }
  };

  visit(program);
  return edits;
}

export function renameTypeScriptSymbol(
  program: t.Program,
  symbols: ReadonlyArray<ScriptSymbol>,
  symbol: ScriptSymbol,
  name: string
): OpResult {
  const isMember =
    symbol.scope !== '' &&
    (symbol.kind === 'method' || symbol.kind === 'variable');
  if (isMember) {
    if (symbol.name.startsWith('#')) {
      return { ok: false, error: 'Private # members cannot be renamed yet.' };
    }

    const cls = symbols.find(
      (s) => s.kind === 'class' && s.name === symbol.scope
    );
    if (!cls) {
      return { ok: false, error: `There is no class ${symbol.scope}.` };
    }

    const oldName = symbol.name.replace(/\.(?:get|set)$/, '');
    return { ok: true, edits: memberEdits(program, cls, oldName, name) };
  }

  const binding = symbol.nameRange.start;
  const occurrences = resolveNames(program).filter(
    (o) => o.binding === binding && o.name === symbol.name
  );
  if (!occurrences.some((o) => o.start === binding)) {
    occurrences.push({ start: binding, name: symbol.name, binding });
  }

  const edits = occurrences.map((o): TextEdit => {
    const end = o.start + o.name.length;
    if (o.shorthand) {
      return { start: o.start, end, text: `${o.name}: ${name}` };
    }

    if (o.exported) {
      return { start: o.start, end, text: `${name} as ${o.name}` };
    }

    return { start: o.start, end, text: name };
  });
  return { ok: true, edits };
}

/** Visits every node of a program. */
function walk(node: Node, visit: (node: Node) => void): void {
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key.endsWith('Comments')) {
      continue;
    }

    for (const child of Array.isArray(value) ? value : [value]) {
      if (isNode(child)) {
        walk(child, visit);
      }
    }
  }
}

/**
 * Calls of a function (through its name) or a method (through
 * `this.name(…)` inside its class) in the same file.
 */
export function typeScriptCallSites(
  program: t.Program,
  text: string,
  symbols: ReadonlyArray<ScriptSymbol>,
  symbol: ScriptSymbol
): CallSite[] {
  const cls =
    symbol.kind === 'method'
      ? symbols.find((s) => s.kind === 'class' && s.name === symbol.scope)
      : undefined;
  const uses = new Set(
    symbol.kind === 'method'
      ? []
      : resolveNames(program)
          .filter(
            (o) =>
              o.binding === symbol.nameRange.start && o.name === symbol.name
          )
          .map((o) => o.start)
  );
  const isCall = (callee: Node): boolean => {
    if (callee.type === 'Identifier') {
      return uses.has(callee.start ?? -1);
    }

    return (
      cls !== undefined &&
      (callee.type === 'MemberExpression' ||
        callee.type === 'OptionalMemberExpression') &&
      callee.object.type === 'ThisExpression' &&
      !callee.computed &&
      callee.property.type === 'Identifier' &&
      callee.property.name === symbol.name &&
      (callee.start ?? 0) >= cls.range.start &&
      (callee.end ?? 0) <= cls.range.end
    );
  };

  const sites: CallSite[] = [];
  walk(program, (node) => {
    if (
      (node.type === 'CallExpression' ||
        node.type === 'OptionalCallExpression') &&
      isCall(node.callee)
    ) {
      const from = node.typeArguments?.end ?? node.callee.end ?? 0;
      sites.push({
        open: text.indexOf('(', from) + 1,
        close: (node.end ?? 1) - 1,
        args: node.arguments.map((arg) => ({
          start: arg.start ?? 0,
          end: arg.end ?? 0,
        })),
      });
    }
  });
  return sites;
}
