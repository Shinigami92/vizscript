import type {
  ImportedDeclaration,
  ScriptSymbol,
  SymbolParam,
} from '@vizscript/core';
import { rangeKey } from '@vizscript/core';
import type { Arg, Expr, Span } from './ast';
import type { Callable } from './builtin-types';
import {
  pythonBuiltins,
  signatureOf,
  sliceOf,
  substitute,
} from './builtin-types';
import { unwrap } from './lower-utils';
import {
  binaryType,
  common,
  generic,
  GENERIC_CALLS,
  itemOf,
  normalize,
  NUMBERS,
  subscriptOf,
} from './type-text';

/** A class used by name (`Item(...)`, `Item.create()`). */
export const CLASS = 'class:';
/** An imported module (`json`), by its local name. */
export const MODULE = 'module:';

// ---------------------------------------------------------------- scopes

/** A class of the file: its fields, methods and bases. */
export interface ClassScope {
  name: string;
  bases: string[];
  fields: Map<string, string | undefined>;
  methods: Map<string, Callable>;
}

/** Names of a module or function (Python has no block scopes). */
export class Scope {
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
  /** Parameters of a method. */
  params?: ReadonlyArray<SymbolParam>;
}

/** What a call gives, and the parameters of what it calls. */
interface CallResult {
  type: string | undefined;
  isAsync?: boolean;
  params?: ReadonlyArray<SymbolParam>;
}

/**
 * The expression half of `TypeLookup`: what values, members and calls are
 * (`typeOf`), from the names and classes the statement walker
 * (`TypeLookup` in `type-lookup.ts`) records. Answers by source range, as
 * Python writes the type (`list[str]`); unknown values have none.
 */
export abstract class TypeExpressions {
  public readonly types = new Map<string, string>();
  protected readonly classes = new Map<string, ClassScope>();
  /** Module-level functions. */
  protected readonly functions = new Map<string, Callable>();
  protected readonly imports = new Map<string, ImportedDeclaration>();
  /** Parameters of what calls reach, by the call's range. */
  public readonly signatures = new Map<string, ReadonlyArray<SymbolParam>>();
  /** Calls of `async def` functions: what awaiting them gives. */
  protected readonly awaited = new Map<string, string>();

  protected constructor(
    protected readonly text: string,
    imports: ReadonlyArray<ImportedDeclaration>
  ) {
    for (const declaration of imports) {
      this.imports.set(declaration.name, declaration);
    }
  }

  protected src(span: Span | undefined): string | undefined {
    return sliceOf(this.text, span);
  }

  protected record(span: Span, type: string | undefined): void {
    if (type !== undefined) {
      this.types.set(rangeKey(span), type);
    }
  }

  /** A member of a type: the file's classes, then the built-ins. */
  protected member(type: string, name: string, depth = 0): Member | undefined {
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
          params: signatureOf(method),
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
    if (builtin?.fields.has(name)) {
      return { kind: 'value', type: normalize(builtin.fields.get(name)) };
    }

    const method = builtin?.methods.get(name);
    if (!method) {
      return undefined;
    }

    return {
      kind: 'method',
      type: method.returns ? substitute(method.returns, args) : undefined,
      params: signatureOf(method, args),
    };
  }

  /** The result of a function, `Self` / the class's own name resolved. */
  protected result(fn: Callable, owner?: string): string | undefined {
    const returns = normalize(fn.returns);
    return returns === 'Self' && owner ? owner : returns;
  }

  /** A member of something imported (`json.load`, `Path.cwd`). */
  protected importedMember(
    declaration: ImportedDeclaration,
    name: string
  ): ScriptSymbol | undefined {
    return declaration.members?.find((m) => m.name === name);
  }

  protected symbolType(symbol: ScriptSymbol | undefined): string | undefined {
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

  protected name(name: string, scope: Scope): string | undefined {
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

  protected infer(expr: Expr, scope: Scope): string | undefined {
    const type = this.typeOf(expr, scope);
    const shown = expr.type !== 'Literal' || expr.kind !== 'none';
    if (shown) {
      this.record(expr, type);
    }

    return type;
  }

  protected typeOf(expr: Expr, scope: Scope): string | undefined {
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

  protected attribute(
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

  protected call(
    expr: Extract<Expr, { type: 'Call' }>,
    scope: Scope
  ): string | undefined {
    const callee = unwrap(expr.callee);
    const args = expr.args.map((arg) => this.infer(arg.value, scope));
    const result = this.callResult(callee, expr.args, args, scope);
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

  protected callResult(
    callee: Expr,
    argExprs: ReadonlyArray<Arg>,
    args: ReadonlyArray<string | undefined>,
    scope: Scope
  ): CallResult | undefined {
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
        return { type: this.importedCall(member), params: member?.params };
      }

      const cls = object.startsWith(CLASS)
        ? object.slice(CLASS.length)
        : undefined;
      const member = this.member(cls ?? object, callee.name);
      return member?.kind === 'method' ? member : undefined;
    }

    if (callee.type !== 'Name') {
      this.infer(callee, scope);
      return undefined;
    }

    const name = callee.name;
    const local = scope.find(name);
    if (local) {
      if (local.type?.startsWith(CLASS)) {
        // A class of the file: its `__init__` takes the arguments.
        const cls = local.type.slice(CLASS.length);
        const init = this.member(cls, '__init__');
        return { type: cls, params: init?.params };
      }

      const fn = this.functions.get(name);
      return fn && local.type === 'Callable'
        ? {
            type: this.result(fn),
            isAsync: fn.isAsync,
            params: signatureOf(fn),
          }
        : undefined;
    }

    const imported = this.imports.get(name);
    if (imported) {
      return {
        type: this.importedCall(imported.declaration),
        params: imported.declaration?.params,
      };
    }

    if (GENERIC_CALLS.has(name)) {
      return { type: this.genericCall(name, argExprs, args) };
    }

    const builtin = pythonBuiltins().functions.get(name);
    if (builtin) {
      return { type: normalize(builtin.returns), params: signatureOf(builtin) };
    }

    // Built-in exceptions (`ValueError("…")`).
    return /^[A-Z]\w*(Error|Exception|Warning)$/.test(name)
      ? { type: name }
      : undefined;
  }

  protected importedCall(symbol: ScriptSymbol | undefined): string | undefined {
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
  protected genericCall(
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
        // Without a start value it adds numbers, also of unknown items.
        if (item && NUMBERS.has(item)) {
          return item;
        }

        return positional.length === 1 ? 'float' : undefined;
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
