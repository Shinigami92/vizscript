import type {
  ImportedDeclaration,
  ScriptSymbol,
  TypeInfo,
  TypeMap,
} from '@vizscript/core';
import { rangeKey } from '@vizscript/core';
import type {
  Arg,
  Block,
  ClassDef,
  Expr,
  FunctionDef,
  Param,
  Span,
  Stmt,
} from './ast';
import type { Callable } from './builtin-types';
import {
  builtinMembers,
  callableOf,
  pythonBuiltins,
  sliceOf,
  substitute,
} from './builtin-types';
import { dataTypeOf, unwrap } from './lower-utils';
import {
  binaryType,
  common,
  generic,
  GENERIC_CALLS,
  itemOf,
  known,
  normalize,
  NUMBERS,
  subscriptOf,
} from './type-text';

/** A class used by name (`Item(...)`, `Item.create()`). */
const CLASS = 'class:';
/** An imported module (`json`), by its local name. */
const MODULE = 'module:';

// ---------------------------------------------------------------- scopes

/** A class of the file: its fields, methods and bases. */
interface ClassScope {
  name: string;
  bases: string[];
  fields: Map<string, string | undefined>;
  methods: Map<string, Callable>;
}

/** Names of a module or function (Python has no block scopes). */
class Scope {
  public readonly values = new Map<string, string | undefined>();

  public constructor(
    public readonly parent?: Scope,
    /** The class whose methods this scope's function belongs to. */
    public readonly owner?: ClassScope
  ) {}

  public find(name: string): { type: string | undefined } | undefined {
    if (this.values.has(name)) {
      return { type: this.values.get(name) };
    }

    return this.parent?.find(name);
  }

  /** Declares a name, or gives an untyped one the type of a value. */
  public assign(name: string, type: string | undefined): void {
    if (!this.values.has(name) || this.values.get(name) === undefined) {
      this.values.set(name, type);
    }
  }
}

interface Member {
  kind: 'value' | 'method';
  type: string | undefined;
  isAsync?: boolean;
}

/**
 * Follows the types of values through a Python file, like a type checker
 * would for code without surprises: annotations, assignments (the first
 * value an unannotated name gets), loops, `with` and `except` targets,
 * classes of the file with the fields their methods set, imported
 * declarations, and the built-in types and functions. Answers by source
 * range, as Python writes the type (`list[str]`); unknown values have none.
 */
class TypeLookup {
  public readonly types = new Map<string, string>();
  private readonly classes = new Map<string, ClassScope>();
  /** Module-level functions. */
  private readonly functions = new Map<string, Callable>();
  private readonly imports = new Map<string, ImportedDeclaration>();
  /** Calls of `async def` functions: what awaiting them gives. */
  private readonly awaited = new Map<string, string>();

  public constructor(
    private readonly text: string,
    body: ReadonlyArray<Stmt>,
    imports: ReadonlyArray<ImportedDeclaration>
  ) {
    for (const declaration of imports) {
      this.imports.set(declaration.name, declaration);
    }

    const module = new Scope();
    this.declare(body, module);
    this.walkBody(body, module);
  }

  private src(span: Span | undefined): string | undefined {
    return sliceOf(this.text, span);
  }

  private record(span: Span, type: string | undefined): void {
    if (type !== undefined) {
      this.types.set(rangeKey(span), type);
    }
  }

  /** Functions and classes of a module, before its code runs. */
  private declare(body: ReadonlyArray<Stmt>, module: Scope): void {
    for (const stmt of body) {
      if (stmt.type === 'FunctionDef') {
        this.functions.set(stmt.name, callableOf(this.text, stmt, false));
        module.values.set(stmt.name, 'Callable');
      } else if (stmt.type === 'ClassDef') {
        this.declareClass(stmt);
        module.values.set(stmt.name, `${CLASS}${stmt.name}`);
      }
    }
  }

  private declareClass(cls: ClassDef): void {
    const scope: ClassScope = {
      name: cls.name,
      bases: cls.bases
        .filter((b) => !b.keyword && !b.star)
        .map((b) => this.src(b.value) ?? ''),
      fields: new Map(),
      methods: new Map(),
    };
    this.classes.set(cls.name, scope);
    for (const stmt of cls.body.body) {
      if (stmt.type === 'FunctionDef') {
        const method = callableOf(this.text, stmt, true);
        const decorated = stmt.decorators.some((d) =>
          /^@(staticmethod)\b/.test(this.src(d) ?? '')
        );
        scope.methods.set(
          stmt.name,
          decorated ? callableOf(this.text, stmt, false) : method
        );
      } else if (stmt.type === 'Assign' && stmt.annotation) {
        for (const target of stmt.targets) {
          if (target.type === 'Name') {
            scope.fields.set(target.name, normalize(this.src(stmt.annotation)));
          }
        }
      }
    }
  }

  private walkBody(body: ReadonlyArray<Stmt>, scope: Scope): void {
    for (const stmt of body) {
      this.walkStatement(stmt, scope);
    }
  }

  private walkBlock(block: Block | undefined, scope: Scope): void {
    if (block) {
      this.walkBody(block.body, scope);
    }
  }

  private walkClass(cls: ClassDef, parent: Scope): void {
    const owner = this.classes.get(cls.name);
    const scope = new Scope(parent, owner);
    // `__init__` first: it sets the fields the other methods read.
    const methods = cls.body.body.filter(
      (s): s is FunctionDef => s.type === 'FunctionDef'
    );
    const ordered = [
      ...methods.filter((m) => m.name === '__init__'),
      ...methods.filter((m) => m.name !== '__init__'),
    ];
    for (const stmt of cls.body.body) {
      if (stmt.type !== 'FunctionDef') {
        this.walkStatement(stmt, scope);
      }
    }

    for (const method of ordered) {
      this.walkFunction(method, parent, owner);
    }
  }

  private paramType(
    param: Param,
    index: number,
    scope: Scope,
    owner: ClassScope | undefined,
    fn: FunctionDef | undefined
  ): string | undefined {
    if (param.name.startsWith('**')) {
      return 'dict[str, Any]';
    }

    const annotation = normalize(this.src(param.annotation));
    if (param.name.startsWith('*')) {
      return annotation ? `tuple[${annotation}, ...]` : undefined;
    }

    if (annotation !== undefined) {
      return annotation;
    }

    const value = param.defaultValue
      ? this.infer(param.defaultValue, scope)
      : undefined;
    if (value !== undefined && value !== 'None') {
      return value;
    }

    const isStatic = fn?.decorators.some((d) =>
      /^@staticmethod\b/.test(this.src(d) ?? '')
    );
    if (owner && index === 0 && !isStatic) {
      const isClassMethod = fn?.decorators.some((d) =>
        /^@classmethod\b/.test(this.src(d) ?? '')
      );
      return isClassMethod ? `${CLASS}${owner.name}` : owner.name;
    }

    return undefined;
  }

  private walkFunction(
    fn: FunctionDef,
    parent: Scope,
    owner?: ClassScope
  ): void {
    const scope = new Scope(parent, owner);
    for (const [index, param] of fn.params.entries()) {
      const type = this.paramType(param, index, scope, owner, fn);
      const bare = param.name.replace(/^\*+/, '');
      scope.values.set(bare, type);
      this.record(param, type);
      const nameStart = param.start + param.name.length - bare.length;
      this.record({ start: nameStart, end: nameStart + bare.length }, type);
    }

    this.walkBlock(fn.body, scope);
  }

  /** Gives an assignment target its type (`a, b = pair` unpacks it). */
  private assignTarget(
    target: Expr,
    type: string | undefined,
    scope: Scope
  ): void {
    const t = unwrap(target);
    switch (t.type) {
      case 'Name': {
        scope.assign(t.name, type);
        this.record(t, scope.find(t.name)?.type ?? type);
        break;
      }

      case 'Collection': {
        const { name, args } = generic(type ?? '');
        for (const [index, item] of t.items.entries()) {
          const part =
            name === 'tuple' && args[1] !== '...'
              ? known(args[index])
              : itemOf(type);
          this.assignTarget(item, part, scope);
        }

        break;
      }

      case 'Attribute': {
        const object = unwrap(t.object);
        const owner = scope.owner;
        if (
          object.type === 'Name' &&
          object.name === 'self' &&
          owner &&
          type !== undefined &&
          owner.fields.get(t.name) === undefined
        ) {
          owner.fields.set(t.name, type);
        }

        const field = this.infer(t, scope);
        this.record(t, field);
        // The field's name, as its symbol is declared.
        this.record({ start: t.end - t.name.length, end: t.end }, field);
        break;
      }

      default: {
        this.infer(t, scope);
        break;
      }
    }
  }

  private walkStatement(stmt: Stmt, scope: Scope): void {
    switch (stmt.type) {
      case 'FunctionDef': {
        this.walkFunction(stmt, scope, undefined);
        break;
      }

      case 'ClassDef': {
        this.walkClass(stmt, scope);
        break;
      }

      case 'Expr': {
        this.infer(stmt.value, scope);
        break;
      }

      case 'Assign': {
        const annotation = normalize(this.src(stmt.annotation));
        const value = stmt.value ? this.infer(stmt.value, scope) : undefined;
        const type = annotation ?? (value === 'None' ? undefined : value);
        for (const target of stmt.targets) {
          const name = unwrap(target);
          if (annotation !== undefined && name.type === 'Name') {
            scope.values.set(name.name, annotation);
          }

          this.assignTarget(target, type, scope);
        }

        break;
      }

      case 'AugAssign': {
        const target = this.infer(stmt.target, scope);
        const value = this.infer(stmt.value, scope);
        this.record(
          stmt.target,
          binaryType(stmt.op.replace(/=$/, ''), target, value) ?? target
        );
        break;
      }

      case 'If': {
        this.infer(stmt.test, scope);
        this.walkBlock(stmt.body, scope);
        for (const elif of stmt.elifs) {
          this.infer(elif.test, scope);
          this.walkBlock(elif.body, scope);
        }

        this.walkBlock(stmt.orelse, scope);
        break;
      }

      case 'For': {
        const iterable = this.infer(stmt.iter, scope);
        this.assignTarget(stmt.target, itemOf(iterable), scope);
        this.walkBlock(stmt.body, scope);
        this.walkBlock(stmt.orelse, scope);
        break;
      }

      case 'While': {
        this.infer(stmt.test, scope);
        this.walkBlock(stmt.body, scope);
        this.walkBlock(stmt.orelse, scope);
        break;
      }

      case 'With': {
        for (const item of stmt.items) {
          const context = this.infer(item.context, scope);
          if (item.target) {
            this.assignTarget(item.target, context, scope);
          }
        }

        this.walkBlock(stmt.body, scope);
        break;
      }

      case 'Try': {
        this.walkBlock(stmt.body, scope);
        for (const handler of stmt.handlers) {
          const exception = handler.exception && unwrap(handler.exception);
          if (handler.name) {
            scope.assign(
              handler.name,
              exception?.type === 'Name' ? exception.name : undefined
            );
          }

          this.walkBlock(handler.body, scope);
        }

        this.walkBlock(stmt.orelse, scope);
        this.walkBlock(stmt.finalbody, scope);
        break;
      }

      case 'Match': {
        this.infer(stmt.subject, scope);
        for (const branch of stmt.cases) {
          this.walkBlock(branch.body, scope);
        }

        break;
      }

      case 'Return':
      case 'Yield': {
        if (stmt.value) {
          this.infer(stmt.value, scope);
        }

        break;
      }

      case 'Raise': {
        if (stmt.exception) {
          this.infer(stmt.exception, scope);
        }

        break;
      }

      case 'Assert': {
        this.infer(stmt.test, scope);
        break;
      }

      default: {
        break;
      }
    }
  }

  // ------------------------------------------------------------- members

  /** A member of a type: the file's classes, then the built-ins. */
  private member(type: string, name: string, depth = 0): Member | undefined {
    const own = this.classes.get(type);
    if (own) {
      if (own.fields.has(name)) {
        return { kind: 'value', type: own.fields.get(name) };
      }

      const method = own.methods.get(name);
      if (method) {
        return {
          kind: 'method',
          type: this.result(method, own.name),
          isAsync: method.isAsync,
        };
      }

      for (const base of own.bases) {
        const found =
          depth < 16 ? this.member(base, name, depth + 1) : undefined;
        if (found) {
          return found;
        }
      }

      return undefined;
    }

    const { name: base, args } = generic(type);
    const builtin = pythonBuiltins().classes.get(base);
    const method = builtin?.methods.get(name);
    if (!method) {
      return undefined;
    }

    return {
      kind: 'method',
      type: method.returns ? substitute(method.returns, args) : undefined,
    };
  }

  /** The result of a function, `Self` / the class's own name resolved. */
  private result(fn: Callable, owner?: string): string | undefined {
    const returns = normalize(fn.returns);
    return returns === 'Self' && owner ? owner : returns;
  }

  /** A member of something imported (`json.load`, `Path.cwd`). */
  private importedMember(
    declaration: ImportedDeclaration,
    name: string
  ): ScriptSymbol | undefined {
    return declaration.members?.find((m) => m.name === name);
  }

  private symbolType(symbol: ScriptSymbol | undefined): string | undefined {
    if (!symbol) {
      return undefined;
    }

    if (symbol.kind === 'function' || symbol.kind === 'method') {
      return 'Callable';
    }

    if (symbol.kind === 'class') {
      return `${CLASS}${symbol.name}`;
    }

    return normalize(symbol.type?.text);
  }

  private name(name: string, scope: Scope): string | undefined {
    const local = scope.find(name);
    if (local) {
      return local.type;
    }

    const imported = this.imports.get(name);
    if (imported) {
      return imported.declaration
        ? this.symbolType(imported.declaration)
        : `${MODULE}${name}`;
    }

    if (name === '__name__' || name === '__file__') {
      return 'str';
    }

    return undefined;
  }

  // --------------------------------------------------------- expressions

  private infer(expr: Expr, scope: Scope): string | undefined {
    const type = this.typeOf(expr, scope);
    const shown = expr.type !== 'Literal' || expr.kind !== 'none';
    if (shown) {
      this.record(expr, type);
    }

    return type;
  }

  private typeOf(expr: Expr, scope: Scope): string | undefined {
    switch (expr.type) {
      case 'Name': {
        return this.name(expr.name, scope);
      }

      case 'Literal': {
        switch (expr.kind) {
          case 'string': {
            return 'str';
          }

          case 'none': {
            return 'None';
          }

          default: {
            return expr.kind;
          }
        }
      }

      case 'FString': {
        for (const part of expr.parts) {
          this.infer(part, scope);
        }

        return 'str';
      }

      case 'Paren': {
        return this.infer(expr.expr, scope);
      }

      case 'Attribute': {
        return this.attribute(this.infer(expr.object, scope), expr.name);
      }

      case 'Subscript': {
        const object = this.infer(expr.object, scope);
        const index = unwrap(expr.index);
        if (index.type !== 'Opaque') {
          this.infer(index, scope);
        }

        return subscriptOf(object, index);
      }

      case 'Call': {
        return this.call(expr, scope);
      }

      case 'Binary': {
        const left = this.infer(expr.left, scope);
        const right = this.infer(expr.right, scope);
        return binaryType(expr.op, left, right);
      }

      case 'Unary': {
        const argument = this.infer(expr.argument, scope);
        if (expr.op === 'not') {
          return 'bool';
        }

        return expr.op === '~' ? 'int' : argument;
      }

      case 'Conditional': {
        this.infer(expr.test, scope);
        const yes = this.infer(expr.consequent, scope);
        const no = this.infer(expr.alternate, scope);
        if (yes === 'None') {
          return no;
        }

        return no === 'None' ? yes : common([yes, no]);
      }

      case 'Collection': {
        const items = expr.items.map((item) => this.infer(item, scope));
        if (expr.kind === 'tuple') {
          return items.every((t) => t !== undefined)
            ? `tuple[${items.join(', ')}]`
            : undefined;
        }

        const item = common(items);
        return item ? `${expr.kind}[${item}]` : expr.kind;
      }

      case 'Dict': {
        const keys: Array<string | undefined> = [];
        const values: Array<string | undefined> = [];
        for (const entry of expr.entries) {
          keys.push(entry.key ? this.infer(entry.key, scope) : undefined);
          values.push(this.infer(entry.value, scope));
        }

        const key = common(keys);
        const value = common(values);
        return key && value ? `dict[${key}, ${value}]` : 'dict';
      }

      case 'Comprehension': {
        for (const source of expr.sources) {
          this.infer(source, scope);
        }

        return expr.kind === 'generator' ? undefined : expr.kind;
      }

      case 'Await': {
        this.infer(expr.argument, scope);
        return this.awaited.get(rangeKey(unwrap(expr.argument)));
      }

      case 'Lambda': {
        return 'Callable';
      }

      case 'Starred': {
        this.infer(expr.value, scope);
        return undefined;
      }

      default: {
        return undefined;
      }
    }
  }

  private attribute(
    object: string | undefined,
    name: string
  ): string | undefined {
    if (object === undefined) {
      return undefined;
    }

    if (object.startsWith(MODULE)) {
      const declaration = this.imports.get(object.slice(MODULE.length));
      return declaration
        ? this.symbolType(this.importedMember(declaration, name))
        : undefined;
    }

    const cls = object.startsWith(CLASS)
      ? object.slice(CLASS.length)
      : undefined;
    const member = this.member(cls ?? object, name);
    if (!member) {
      return undefined;
    }

    return member.kind === 'value' ? member.type : 'Callable';
  }

  private call(
    expr: Extract<Expr, { type: 'Call' }>,
    scope: Scope
  ): string | undefined {
    const callee = unwrap(expr.callee);
    const args = expr.args.map((arg) => this.infer(arg.value, scope));
    const result = this.callResult(callee, expr.args, args, scope);
    if (result?.isAsync) {
      if (result.type !== undefined) {
        this.awaited.set(rangeKey(expr), result.type);
      }

      return undefined;
    }

    return result?.type;
  }

  private callResult(
    callee: Expr,
    argExprs: ReadonlyArray<Arg>,
    args: ReadonlyArray<string | undefined>,
    scope: Scope
  ): { type: string | undefined; isAsync?: boolean } | undefined {
    if (callee.type === 'Attribute') {
      const object = this.infer(callee.object, scope);
      if (object === undefined) {
        return undefined;
      }

      if (object.startsWith(MODULE)) {
        const declaration = this.imports.get(object.slice(MODULE.length));
        const member = declaration
          ? this.importedMember(declaration, callee.name)
          : undefined;
        return { type: this.importedCall(member) };
      }

      const cls = object.startsWith(CLASS)
        ? object.slice(CLASS.length)
        : undefined;
      const member = this.member(cls ?? object, callee.name);
      return member?.kind === 'method'
        ? { type: member.type, isAsync: member.isAsync }
        : undefined;
    }

    if (callee.type !== 'Name') {
      this.infer(callee, scope);
      return undefined;
    }

    const name = callee.name;
    const local = scope.find(name);
    if (local) {
      if (local.type?.startsWith(CLASS)) {
        return { type: local.type.slice(CLASS.length) };
      }

      const fn = this.functions.get(name);
      return fn && local.type === 'Callable'
        ? { type: this.result(fn), isAsync: fn.isAsync }
        : undefined;
    }

    const imported = this.imports.get(name);
    if (imported) {
      return { type: this.importedCall(imported.declaration) };
    }

    if (GENERIC_CALLS.has(name)) {
      return { type: this.genericCall(name, argExprs, args) };
    }

    const builtin = pythonBuiltins().functions.get(name);
    if (builtin) {
      return { type: normalize(builtin.returns) };
    }

    // Built-in exceptions (`ValueError("…")`).
    return /^[A-Z]\w*(Error|Exception|Warning)$/.test(name)
      ? { type: name }
      : undefined;
  }

  private importedCall(symbol: ScriptSymbol | undefined): string | undefined {
    if (!symbol) {
      return undefined;
    }

    if (symbol.kind === 'class') {
      return symbol.name;
    }

    return symbol.kind === 'function' || symbol.kind === 'method'
      ? normalize(symbol.returns?.text)
      : undefined;
  }

  /** `sum(xs)`, `sorted(xs)`, `enumerate(xs)`: typed by their arguments. */
  private genericCall(
    name: string,
    argExprs: ReadonlyArray<Arg>,
    args: ReadonlyArray<string | undefined>
  ): string | undefined {
    const positional = args.filter((_, i) => !argExprs[i]?.keyword);
    const [first] = positional;
    const item = itemOf(first);
    switch (name) {
      case 'str':
      case 'int':
      case 'float':
      case 'bool':
      case 'bytes': {
        return name;
      }

      case 'abs': {
        return first && NUMBERS.has(first) ? first : undefined;
      }

      case 'round': {
        return positional.length > 1 ? 'float' : 'int';
      }

      case 'sum': {
        return item && NUMBERS.has(item) ? item : undefined;
      }

      case 'min':
      case 'max': {
        return positional.length === 1 ? item : common(positional);
      }

      case 'sorted':
      case 'reversed':
      case 'list': {
        return item ? `list[${item}]` : undefined;
      }

      case 'set': {
        return item ? `set[${item}]` : undefined;
      }

      case 'tuple': {
        return item ? `tuple[${item}, ...]` : undefined;
      }

      case 'dict': {
        return first && generic(first).name === 'dict' ? first : 'dict';
      }

      case 'enumerate': {
        return item ? `list[tuple[int, ${item}]]` : undefined;
      }

      case 'zip': {
        const items = positional.map((a) => itemOf(a));
        return items.length > 0 && items.every((t) => t !== undefined)
          ? `list[tuple[${items.join(', ')}]]`
          : undefined;
      }

      case 'iter': {
        return first;
      }

      case 'next': {
        return item;
      }

      default: {
        return undefined;
      }
    }
  }
}

/** Types that say no more than the parser (`list` of unknown items). */
const VAGUE = new Set(['list', 'set', 'tuple', 'Callable']);

/**
 * Types of the values of a Python file, by source range (see
 * `TypeLookup`): what `applyTypes` makes the pins and symbols of its graph.
 */
export function pythonTypes(
  text: string,
  body: ReadonlyArray<Stmt>,
  imports: ReadonlyArray<ImportedDeclaration> = []
): TypeMap {
  const types = new Map<string, TypeInfo>();
  let found: ReadonlyMap<string, string>;
  try {
    found = new TypeLookup(text, body, imports).types;
  } catch {
    // Code the parser recovered from in an unexpected shape: the graph
    // keeps the parser's types.
    return types;
  }

  for (const [key, type] of found) {
    if (type.startsWith(CLASS) || type.startsWith(MODULE) || VAGUE.has(type)) {
      continue;
    }

    const members = builtinMembers(type);
    types.set(key, {
      text: type,
      dataType: dataTypeOf(type),
      ...(members ? { members } : {}),
    });
  }

  return types;
}
