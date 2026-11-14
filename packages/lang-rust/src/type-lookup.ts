import type { TypeInfo, TypeMap } from '@vizscript/core';
import { rangeKey } from '@vizscript/core';
import type {
  Block,
  Expr,
  FunctionItem,
  IfStmt,
  Item,
  MatchStmt,
  Pattern,
  Span,
  Stmt,
} from './ast';
import type { Callable } from './builtin-types';
import {
  builtinMembers,
  builtinMethod,
  callableOf,
  sliceOf,
  stubOf,
  substitute,
} from './builtin-types';
import { dataTypeOf } from './data-type';
import { unwrap } from './lower-utils';
import {
  binaryType,
  common,
  concrete,
  generic,
  isInteger,
  itemOf,
  literalType,
  macroType,
  normalize,
  patternTypes,
  same,
  splitTop,
  unify,
} from './type-text';

// ---------------------------------------------------------------- scopes

/** A struct or enum of the file, with its fields and `impl` methods. */
interface TypeScope {
  fields: Map<string, string | undefined>;
  methods: Map<string, Callable>;
}

class Scope {
  public readonly values = new Map<string, string | undefined>();

  public constructor(public readonly parent?: Scope) {}

  public find(name: string): { type: string | undefined } | undefined {
    if (this.values.has(name)) {
      return { type: this.values.get(name) };
    }

    return this.parent?.find(name);
  }
}

interface Result {
  type: string | undefined;
  isAsync?: boolean;
}

/**
 * Follows the types of values through a Rust file, like rustc's inference
 * for straightforward code: annotations, `let` values, patterns of `for`,
 * `if let` and `match`, fields and `impl` methods of the file's types, and
 * methods of the standard types (`String`, `Vec`, `Option`, iterators,
 * numbers). Answers by source range, as Rust writes the type without
 * references (`Option<Item>`); unknown values have none.
 */
class TypeLookup {
  public readonly types = new Map<string, string>();
  private readonly typesOfFile = new Map<string, TypeScope>();
  private readonly enums = new Set<string>();
  private readonly functions = new Map<string, Callable>();
  /** Calls of `async fn`s: what awaiting them gives. */
  private readonly awaited = new Map<string, string>();
  /** The type of `self` in the function being walked. */
  private owner: string | undefined;

  public constructor(
    private readonly text: string,
    items: ReadonlyArray<Item>
  ) {
    const module = new Scope();
    this.declare(items, module);
    this.walkItems(items, module);
  }

  private src(span: Span | undefined): string | undefined {
    return sliceOf(this.text, span);
  }

  private record(span: Span, type: string | undefined): void {
    if (type !== undefined) {
      this.types.set(rangeKey(span), type);
    }
  }

  private typeScope(name: string): TypeScope {
    let scope = this.typesOfFile.get(name);
    if (!scope) {
      scope = { fields: new Map(), methods: new Map() };
      this.typesOfFile.set(name, scope);
    }

    return scope;
  }

  private declare(items: ReadonlyArray<Item>, module: Scope): void {
    for (const item of items) {
      switch (item.type) {
        case 'Function': {
          this.functions.set(item.name, callableOf(this.text, item));
          break;
        }

        case 'Struct': {
          const scope = this.typeScope(item.name);
          for (const [index, field] of item.fields.entries()) {
            scope.fields.set(
              item.tuple ? String(index) : field.name,
              normalize(this.src(field.type), item.name)
            );
          }

          break;
        }

        case 'Enum': {
          this.enums.add(item.name);
          this.typeScope(item.name);
          break;
        }

        case 'Impl': {
          const target = normalize(item.target) ?? item.target;
          const scope = this.typeScope(generic(target).name);
          for (const member of item.items) {
            if (member.type === 'Function') {
              const method = callableOf(this.text, member);
              scope.methods.set(member.name, {
                ...method,
                returns: normalize(method.returns, target),
              });
            }
          }

          break;
        }

        case 'Const':
        case 'Static': {
          module.values.set(item.name, normalize(this.src(item.valueType)));
          break;
        }

        case 'Mod': {
          if (item.items) {
            this.declare(item.items, module);
          }

          break;
        }

        default: {
          break;
        }
      }
    }
  }

  private walkItems(items: ReadonlyArray<Item>, scope: Scope): void {
    for (const item of items) {
      this.walkItem(item, scope);
    }
  }

  private walkItem(item: Item, scope: Scope): void {
    switch (item.type) {
      case 'Function': {
        this.walkFunction(item, scope, undefined);
        break;
      }

      case 'Impl': {
        const target = normalize(item.target) ?? item.target;
        for (const member of item.items) {
          if (member.type === 'Function') {
            this.walkFunction(member, scope, target);
          }
        }

        break;
      }

      case 'Trait': {
        for (const member of item.items) {
          if (member.type === 'Function') {
            this.walkFunction(member, scope, undefined);
          }
        }

        break;
      }

      case 'Const':
      case 'Static': {
        if (item.value) {
          const value = this.infer(item.value, scope);
          const declared = scope.find(item.name)?.type;
          this.record(item.nameSpan, declared ?? value);
        }

        break;
      }

      case 'Mod': {
        if (item.items) {
          this.walkItems(item.items, scope);
        }

        break;
      }

      default: {
        break;
      }
    }
  }

  private walkFunction(
    fn: FunctionItem,
    parent: Scope,
    owner: string | undefined
  ): void {
    const outer = this.owner;
    this.owner = owner;
    const scope = new Scope(parent);
    if (fn.self && owner) {
      scope.values.set('self', owner);
      this.record(fn.self, owner);
    }

    for (const param of fn.params) {
      const type = normalize(this.src(param.type), owner);
      this.bind(param.pattern, this.src(param.pattern) ?? '', type, scope);
      this.record(param, type);
    }

    if (fn.body) {
      this.walkBlock(fn.body, scope);
    }

    this.owner = outer;
  }

  /** Declares the names of a pattern with their types and records them. */
  private bind(
    span: Span & { bindings?: Pattern['bindings'] },
    text: string,
    type: string | undefined,
    scope: Scope
  ): void {
    const types = new Map<string, string | undefined>();
    patternTypes(text, type, types);
    const bindings = span.bindings ?? [];
    for (const [name, bound] of types) {
      scope.values.set(name, bound);
      const at = bindings.find((b) => b.name === name);
      if (at) {
        this.record(at, bound);
      } else if (types.size === 1) {
        this.record(span, bound);
      }
    }

    // Names the pattern binds that the text matching didn't reach.
    for (const binding of bindings) {
      if (!scope.values.has(binding.name)) {
        scope.values.set(binding.name, undefined);
      }
    }
  }

  private bindPattern(
    pattern: Pattern,
    type: string | undefined,
    scope: Scope
  ): void {
    this.bind(pattern, this.src(pattern) ?? '', type, scope);
  }

  /** The value of a block: its last expression without `;`. */
  private walkBlock(block: Block, parent: Scope): string | undefined {
    const scope = new Scope(parent);
    let value: string | undefined;
    for (const [index, stmt] of block.body.entries()) {
      const type = this.walkStatement(stmt, scope);
      value =
        index === block.body.length - 1 &&
        stmt.type === 'Expr' &&
        !stmt.semicolon
          ? type
          : undefined;
    }

    return value;
  }

  /** Walks a statement; an expression statement gives its value's type. */
  private walkStatement(stmt: Stmt, scope: Scope): string | undefined {
    switch (stmt.type) {
      case 'Item': {
        this.walkItem(stmt.item, scope);
        return undefined;
      }

      case 'Let': {
        const value = stmt.value ? this.infer(stmt.value, scope) : undefined;
        const declared = normalize(this.src(stmt.valueType), this.owner);
        if (stmt.orelse) {
          this.walkBlock(stmt.orelse, scope);
        }

        this.bindPattern(stmt.pattern, declared ?? concrete(value), scope);
        return undefined;
      }

      case 'Expr': {
        return this.infer(stmt.value, scope);
      }

      case 'Assign': {
        const target = this.infer(stmt.target, scope);
        const value = this.infer(stmt.value, scope);
        this.record(
          stmt.target,
          stmt.op === '='
            ? target
            : binaryType(stmt.op.slice(0, -1), target, value)
        );
        return undefined;
      }

      case 'If': {
        return this.walkIf(stmt, scope);
      }

      case 'Match': {
        return this.walkMatch(stmt, scope);
      }

      case 'For': {
        const iterable = this.infer(stmt.iter, scope);
        const inner = new Scope(scope);
        this.bindPattern(stmt.pattern, itemOf(iterable), inner);
        this.walkBlock(stmt.body, inner);
        return undefined;
      }

      case 'While': {
        const inner = new Scope(scope);
        this.infer(stmt.condition, inner);
        this.walkBlock(stmt.body, inner);
        return undefined;
      }

      case 'Loop': {
        this.walkBlock(stmt.body, scope);
        return undefined;
      }

      case 'BlockStmt': {
        return this.walkBlock(stmt.block, scope);
      }

      case 'Return':
      case 'Break': {
        if (stmt.value) {
          this.infer(stmt.value, scope);
        }

        return undefined;
      }

      default: {
        return undefined;
      }
    }
  }

  private walkIf(stmt: IfStmt, scope: Scope): string | undefined {
    const branches: Array<string | undefined> = [];
    for (const part of [stmt, ...stmt.elifs]) {
      const inner = new Scope(scope);
      this.infer(part.condition, inner);
      branches.push(this.walkBlock(part.body, inner));
    }

    if (!stmt.orelse) {
      return undefined;
    }

    branches.push(this.walkBlock(stmt.orelse, scope));
    return same(branches);
  }

  /** A body that is a block or an expression (match arms, closures). */
  private walkBody(body: Block | Expr, scope: Scope): string | undefined {
    return 'type' in body
      ? this.infer(body, scope)
      : this.walkBlock(body, scope);
  }

  private walkMatch(stmt: MatchStmt, scope: Scope): string | undefined {
    const subject = this.infer(stmt.subject, scope);
    const arms: Array<string | undefined> = [];
    for (const arm of stmt.arms) {
      const inner = new Scope(scope);
      this.bindPattern(arm.pattern, subject, inner);
      if (arm.guard) {
        this.infer(arm.guard, inner);
      }

      arms.push(this.walkBody(arm.body, inner));
    }

    return same(arms);
  }

  // ------------------------------------------------------------- members

  private field(type: string | undefined, name: string): string | undefined {
    if (type === undefined) {
      return undefined;
    }

    if (type.startsWith('(') && /^\d+$/.test(name)) {
      return splitTop(type.slice(1, -1))[Number(name)];
    }

    return this.typesOfFile.get(generic(type).name)?.fields.get(name);
  }

  private method(type: string, name: string): Result | undefined {
    const own = this.typesOfFile.get(generic(type).name)?.methods.get(name);
    if (own) {
      return { type: own.returns, isAsync: own.isAsync };
    }

    const builtin = builtinMethod(type, name);
    if (builtin) {
      const target = stubOf(type);
      return {
        type: builtin.returns
          ? substitute(
              builtin.returns,
              concrete(type) ?? type,
              target?.args ?? []
            )
          : '()',
      };
    }

    // Traits most types implement.
    if (name === 'clone' || name === 'to_owned') {
      return { type: concrete(type) };
    }

    return name === 'to_string' ? { type: 'String' } : undefined;
  }

  // --------------------------------------------------------- expressions

  private infer(expr: Expr, scope: Scope): string | undefined {
    const type = this.typeOf(expr, scope);
    this.record(expr, concrete(type));
    return type;
  }

  private typeOf(expr: Expr, scope: Scope): string | undefined {
    switch (expr.type) {
      case 'Name': {
        return this.name(expr.name, scope);
      }

      case 'Literal': {
        return literalType(expr);
      }

      case 'Paren': {
        return this.infer(expr.expr, scope);
      }

      case 'Field': {
        return this.field(this.infer(expr.object, scope), expr.name);
      }

      case 'Index': {
        const object = this.infer(expr.object, scope);
        this.infer(expr.index, scope);
        if (object === 'String' || object === 'str') {
          return 'str';
        }

        const { name, args } = generic(object ?? '');
        return name.endsWith('Map') ? args[1] : itemOf(object);
      }

      case 'Call': {
        const args = expr.args.map((arg) => this.infer(arg, scope));
        const result = this.call(expr, args, scope);
        if (result?.isAsync) {
          if (result.type !== undefined) {
            this.awaited.set(rangeKey(expr), result.type);
          }

          return undefined;
        }

        return result?.type;
      }

      case 'Macro': {
        const args = (expr.args ?? []).map((arg) => this.infer(arg, scope));
        return macroType(
          expr.name.split('::').at(-1) ?? expr.name,
          args,
          expr.repeat
        );
      }

      case 'Binary': {
        const left = this.infer(expr.left, scope);
        const right = this.infer(expr.right, scope);
        return binaryType(expr.op, left, right);
      }

      case 'Unary': {
        const argument = this.infer(expr.argument, scope);
        return expr.op === '!' && argument !== 'bool' && !isInteger(argument)
          ? undefined
          : argument;
      }

      case 'Ref': {
        return this.infer(expr.argument, scope);
      }

      case 'Cast': {
        this.infer(expr.value, scope);
        return normalize(this.src(expr.target), this.owner);
      }

      case 'Range': {
        const from = expr.from ? this.infer(expr.from, scope) : undefined;
        const to = expr.to ? this.infer(expr.to, scope) : undefined;
        const item = concrete(unify(from ?? to, to ?? from));
        return item ? `Range<${item}>` : undefined;
      }

      case 'Try': {
        const value = this.infer(expr.value, scope);
        const { name, args } = generic(value ?? '');
        return name === 'Option' || name === 'Result' ? args[0] : undefined;
      }

      case 'Await': {
        this.infer(expr.value, scope);
        return this.awaited.get(rangeKey(unwrap(expr.value)));
      }

      case 'Struct': {
        for (const field of expr.fields) {
          if (field.value) {
            this.infer(field.value, scope);
          }
        }

        if (expr.base) {
          this.infer(expr.base, scope);
        }

        return normalize(expr.name, this.owner);
      }

      case 'Array': {
        const items = expr.items.map((item) => this.infer(item, scope));
        const item = expr.repeat ? items[0] : common(items);
        return item ? `[${concrete(item)}]` : undefined;
      }

      case 'Tuple': {
        const items = expr.items.map((item) =>
          concrete(this.infer(item, scope))
        );
        return items.every((t) => t !== undefined)
          ? `(${items.join(', ')})`
          : undefined;
      }

      case 'Closure': {
        const inner = new Scope(scope);
        for (const param of expr.params) {
          this.bind(
            param.pattern,
            this.src(param.pattern) ?? '',
            normalize(this.src(param.type), this.owner),
            inner
          );
        }

        this.walkBody(expr.body, inner);
        return undefined;
      }

      case 'If': {
        return this.walkIf(expr.stmt, scope);
      }

      case 'Match': {
        return this.walkMatch(expr.stmt, scope);
      }

      case 'Block': {
        return this.walkBlock(expr.block, scope);
      }

      case 'Let': {
        // `if let Some(x) = value`: the names live in the branch's scope.
        const value = this.infer(expr.value, scope);
        this.bindPattern(expr.pattern, value, scope);
        return 'bool';
      }

      case 'LetChain': {
        for (const part of expr.parts) {
          this.infer(part, scope);
        }

        return 'bool';
      }

      default: {
        return undefined;
      }
    }
  }

  private name(name: string, scope: Scope): string | undefined {
    const local = scope.find(name);
    if (local) {
      return local.type;
    }

    if (name === 'self') {
      return this.owner;
    }

    // `Direction::Up`: a variant of an enum of the file.
    const [head, last] = name.split('::');
    if (head && last && this.enums.has(head)) {
      return head;
    }

    return head === 'Self' && last && this.owner && this.enums.has(this.owner)
      ? this.owner
      : undefined;
  }

  private call(
    expr: Extract<Expr, { type: 'Call' }>,
    args: ReadonlyArray<string | undefined>,
    scope: Scope
  ): Result | undefined {
    const callee = unwrap(expr.callee);
    if (callee.type === 'Field') {
      const object = this.infer(callee.object, scope);
      if (object === undefined) {
        return undefined;
      }

      const turbofish = normalize(
        this.src(expr.turbofish)?.replace(/^::</, '').replace(/>$/, ''),
        this.owner
      );
      if (
        turbofish &&
        ['sum', 'product', 'parse', 'collect'].includes(callee.name)
      ) {
        return { type: this.collected(callee.name, turbofish, object) };
      }

      return this.method(object, callee.name);
    }

    if (callee.type !== 'Name') {
      this.infer(callee, scope);
      return undefined;
    }

    const path = callee.name.split('::');
    const [first, second] = path;
    if (path.length === 1 && first) {
      if (scope.find(first)) {
        // A closure in a variable.
        return undefined;
      }

      const fn = this.functions.get(first);
      if (fn) {
        return { type: normalize(fn.returns) ?? '()', isAsync: fn.isAsync };
      }

      if (first === 'Some') {
        const value = concrete(args[0]);
        return value ? { type: `Option<${value}>` } : undefined;
      }

      // A tuple struct (`Meters(5.0)`).
      return this.typesOfFile.has(first) ? { type: first } : undefined;
    }

    const owner = path.slice(0, -1).join('::');
    const typeName = owner === 'Self' ? this.owner : normalize(owner);
    const fnName = path.at(-1) ?? '';
    if (typeName === undefined || second === undefined) {
      return undefined;
    }

    const base = generic(typeName).name;
    if (
      this.enums.has(base) &&
      !this.typesOfFile.get(base)?.methods.has(fnName)
    ) {
      return { type: base };
    }

    const method = this.typesOfFile.get(base)?.methods.get(fnName);
    if (method) {
      return { type: method.returns ?? '()', isAsync: method.isAsync };
    }

    if (base === 'String' && (fnName === 'from' || fnName === 'new')) {
      return { type: 'String' };
    }

    return undefined;
  }

  /** `sum::<f64>()`, `parse::<u32>()`, `collect::<Vec<_>>()`. */
  private collected(
    method: string,
    turbofish: string,
    object: string
  ): string | undefined {
    if (method === 'parse') {
      return undefined;
    }

    if (method !== 'collect') {
      return turbofish;
    }

    const { name, args } = generic(turbofish);
    if (args[0] === '_' || args.length === 0) {
      const item = itemOf(object);
      return item ? `${name}<${item}>` : undefined;
    }

    return turbofish;
  }
}

/**
 * Types of the values of a Rust file, by source range (see `TypeLookup`):
 * what `applyTypes` makes the pins and symbols of its graph.
 */
export function rustTypes(text: string, items: ReadonlyArray<Item>): TypeMap {
  const types = new Map<string, TypeInfo>();
  let found: ReadonlyMap<string, string>;
  try {
    found = new TypeLookup(text, items).types;
  } catch {
    // Code the parser recovered from in an unexpected shape: the graph
    // keeps the parser's types.
    return types;
  }

  for (const [key, type] of found) {
    if (type.includes('_') && /(?:^|[<(,\s])_(?:[>),]|$)/.test(type)) {
      continue;
    }

    if (type.startsWith('Range<') || type === 'fmt::Result') {
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
