import type { SymbolParam } from '@vizscript/core';
import { rangeKey } from '@vizscript/core';
import type { Block, Expr, IfStmt, MatchStmt, Pattern, Span } from './ast';
import type { Callable } from './builtin-types';
import {
  builtinMethod,
  signatureOf,
  sliceOf,
  stubOf,
  substitute,
} from './builtin-types';
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
  splitTop,
  unify,
} from './type-text';

// ---------------------------------------------------------------- scopes

/** A struct or enum of the file, with its fields and `impl` methods. */
export interface TypeScope {
  fields: Map<string, string | undefined>;
  methods: Map<string, Callable>;
  /** Imported (a crate's or another file's): its members for the menu. */
  imported?: boolean;
}

export class Scope {
  public readonly values = new Map<string, string | undefined>();

  public constructor(public readonly parent?: Scope) {}

  public find(name: string): { type: string | undefined } | undefined {
    if (this.values.has(name)) {
      return { type: this.values.get(name) };
    }

    return this.parent?.find(name);
  }
}

export interface Result {
  type: string | undefined;
  isAsync?: boolean;
  /** Parameters of what a call calls. */
  params?: ReadonlyArray<SymbolParam>;
}

/**
 * The expressions of the Rust type lookup: names, members, calls and
 * operators. `TypeLookup` declares the file's items and walks its
 * statements, which expressions reach into (blocks, `if`, `match`,
 * closures, `let` patterns).
 */
export abstract class TypeExpressions {
  public readonly types = new Map<string, string>();
  /** Parameters of what calls reach, by the call's range. */
  public readonly signatures = new Map<string, ReadonlyArray<SymbolParam>>();
  protected readonly typesOfFile = new Map<string, TypeScope>();
  protected readonly enums = new Set<string>();
  protected readonly functions = new Map<string, Callable>();
  /** Calls of `async fn`s: what awaiting them gives. */
  protected readonly awaited = new Map<string, string>();
  /** The type of `self` in the function being walked. */
  protected owner: string | undefined;

  protected constructor(protected readonly text: string) {}

  protected src(span: Span | undefined): string | undefined {
    return sliceOf(this.text, span);
  }

  protected record(span: Span, type: string | undefined): void {
    if (type !== undefined) {
      this.types.set(rangeKey(span), type);
    }
  }

  protected typeScope(name: string): TypeScope {
    let scope = this.typesOfFile.get(name);
    if (!scope) {
      scope = { fields: new Map(), methods: new Map() };
      this.typesOfFile.set(name, scope);
    }

    return scope;
  }

  protected abstract walkBlock(block: Block, parent: Scope): string | undefined;

  protected abstract walkBody(
    body: Block | Expr,
    scope: Scope
  ): string | undefined;

  protected abstract walkIf(stmt: IfStmt, scope: Scope): string | undefined;

  protected abstract walkMatch(
    stmt: MatchStmt,
    scope: Scope
  ): string | undefined;

  protected abstract bind(
    span: Span & { bindings?: Pattern['bindings'] },
    text: string,
    type: string | undefined,
    scope: Scope
  ): void;

  protected abstract bindPattern(
    pattern: Pattern,
    type: string | undefined,
    scope: Scope
  ): void;

  // ------------------------------------------------------------- members

  protected field(type: string | undefined, name: string): string | undefined {
    if (type === undefined) {
      return undefined;
    }

    if (type.startsWith('(') && /^\d+$/.test(name)) {
      return splitTop(type.slice(1, -1))[Number(name)];
    }

    return this.typesOfFile.get(generic(type).name)?.fields.get(name);
  }

  protected method(type: string, name: string): Result | undefined {
    const own = this.typesOfFile.get(generic(type).name)?.methods.get(name);
    if (own) {
      return {
        type: own.returns,
        isAsync: own.isAsync,
        params: signatureOf(own, type),
      };
    }

    const builtin = builtinMethod(type, name);
    if (builtin) {
      const target = stubOf(type);
      return {
        params: signatureOf(
          builtin,
          concrete(type) ?? type,
          target?.args ?? []
        ),
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

  protected infer(expr: Expr, scope: Scope): string | undefined {
    const type = this.typeOf(expr, scope);
    this.record(expr, concrete(type));
    return type;
  }

  protected typeOf(expr: Expr, scope: Scope): string | undefined {
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

        // A range (`&v[1..3]`) is a slice: the same kind of container.
        if (expr.index.type === 'Range') {
          const item = itemOf(object);
          return item === undefined ? undefined : `[${item}]`;
        }

        const { name, args } = generic(object ?? '');
        return name.endsWith('Map') ? args[1] : itemOf(object);
      }

      case 'Call': {
        const args = expr.args.map((arg) => this.infer(arg, scope));
        const result = this.call(expr, args, scope);
        if (result?.params && result.params.length > 0) {
          this.signatures.set(rangeKey(expr), result.params);
        }

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

  protected name(name: string, scope: Scope): string | undefined {
    const local = scope.find(name);
    if (local) {
      return local.type;
    }

    if (name === 'self') {
      return this.owner;
    }

    // `Direction::Up`: a variant of an enum of the file (or of a crate:
    // `serde_json::Value::Null`).
    const parts = name.split('::');
    const [head, last] = parts;
    const owner = normalize(parts.slice(0, -1).join('::'));
    if (parts.length > 1 && owner && this.enums.has(owner)) {
      return owner;
    }

    return head === 'Self' && last && this.owner && this.enums.has(this.owner)
      ? this.owner
      : undefined;
  }

  protected call(
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
        return {
          type: normalize(fn.returns) ?? '()',
          isAsync: fn.isAsync,
          params: signatureOf(fn, ''),
        };
      }

      if (first === 'Some') {
        const value = concrete(args[0]);
        return value ? { type: `Option<${value}>` } : undefined;
      }

      // A tuple struct (`Meters(5.0)`).
      return this.typesOfFile.has(first) ? { type: first } : undefined;
    }

    // A function of a crate by its path (`serde_json::to_string`).
    const imported = this.functions.get(callee.name);
    if (imported) {
      return {
        type: normalize(imported.returns) ?? '()',
        isAsync: imported.isAsync,
        params: signatureOf(imported, ''),
      };
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
      return {
        type: method.returns ?? '()',
        isAsync: method.isAsync,
        params: signatureOf(method, typeName),
      };
    }

    if (base === 'String' && (fnName === 'from' || fnName === 'new')) {
      return { type: 'String' };
    }

    return undefined;
  }

  /** `sum::<f64>()`, `parse::<u32>()`, `collect::<Vec<_>>()`. */
  protected collected(
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
