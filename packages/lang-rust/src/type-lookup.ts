import type {
  ImportedDeclaration,
  TypeInfo,
  TypeMap,
  TypeMember,
} from '@vizscript/core';
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
import { builtinMembers, callableOf } from './builtin-types';
import { dataTypeOf } from './data-type';
import { importedCallable } from './imported-types';
import { Scope, TypeExpressions } from './type-expressions';
import {
  binaryType,
  concrete,
  generic,
  itemOf,
  normalize,
  patternTypes,
  same,
} from './type-text';

/**
 * Follows the types of values through a Rust file, like rustc's inference
 * for straightforward code: annotations, `let` values, patterns of `for`,
 * `if let` and `match`, fields and `impl` methods of the file's types, and
 * methods of the standard types (`String`, `Vec`, `Option`, iterators,
 * numbers). Answers by source range, as Rust writes the type without
 * references (`Option<Item>`); unknown values have none.
 */
class TypeLookup extends TypeExpressions {
  public constructor(
    text: string,
    items: ReadonlyArray<Item>,
    imports: ReadonlyArray<ImportedDeclaration>
  ) {
    super(text);
    const module = new Scope();
    this.declareImports(imports);
    this.declare(items, module);
    this.walkItems(items, module);
  }

  /**
   * Functions and types of `use` imports (crates, other files): what calls
   * of them give, the fields and methods of their types. The file's own
   * declarations come after them and win.
   */
  private declareImports(imports: ReadonlyArray<ImportedDeclaration>): void {
    for (const { name, declaration, members } of imports) {
      if (declaration?.kind === 'function') {
        this.functions.set(name, importedCallable(declaration));
        continue;
      }

      if (
        declaration?.kind !== 'class' &&
        declaration?.kind !== 'enum' &&
        declaration?.kind !== 'type'
      ) {
        continue;
      }

      // Types go by their last segment, like `normalize` writes them
      // (`serde_json::Value` named by its path is a `Value`).
      const type = name.split('::').at(-1) ?? name;
      if (declaration.kind === 'enum') {
        this.enums.add(type);
      }

      // Traits, and aliases (`Result<T>`) whose target has the members.
      if (declaration.modifiers.includes('trait') || declaration.type) {
        continue;
      }

      const scope = this.typeScope(type);
      scope.imported = true;
      for (const member of members ?? []) {
        if (member.kind === 'method') {
          scope.methods.set(member.name, importedCallable(member, type));
        } else if (member.kind === 'variable') {
          scope.fields.set(member.name, normalize(member.type?.text, type));
        }
      }
    }
  }

  /** Members of an imported type for the action menu (`Value::as_str`). */
  public importedMembers(type: string): TypeMember[] | undefined {
    const scope = this.typesOfFile.get(generic(type).name);
    if (!scope?.imported) {
      return undefined;
    }

    const members: TypeMember[] = [
      ...[...scope.fields].map(([name, fieldType]): TypeMember => ({
        name,
        kind: 'property',
        type: dataTypeOf(fieldType),
      })),
      ...[...scope.methods].map(([name, method]): TypeMember => ({
        name,
        kind: 'method',
        type: dataTypeOf(method.returns ?? '()'),
        detail: method.detail,
      })),
    ];
    return members.length > 0 ? members : undefined;
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
  protected bind(
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

  protected bindPattern(
    pattern: Pattern,
    type: string | undefined,
    scope: Scope
  ): void {
    this.bind(pattern, this.src(pattern) ?? '', type, scope);
  }

  /** The value of a block: its last expression without `;`. */
  protected walkBlock(block: Block, parent: Scope): string | undefined {
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

  protected walkIf(stmt: IfStmt, scope: Scope): string | undefined {
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
  protected walkBody(body: Block | Expr, scope: Scope): string | undefined {
    return 'type' in body
      ? this.infer(body, scope)
      : this.walkBlock(body, scope);
  }

  protected walkMatch(stmt: MatchStmt, scope: Scope): string | undefined {
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
}

/**
 * Types of the values of a Rust file, by source range (see `TypeLookup`):
 * what `applyTypes` makes the pins and symbols of its graph.
 */
export function rustTypes(
  text: string,
  items: ReadonlyArray<Item>,
  imports: ReadonlyArray<ImportedDeclaration> = []
): TypeMap {
  const types = new Map<string, TypeInfo>();
  let lookup: TypeLookup;
  try {
    lookup = new TypeLookup(text, items, imports);
  } catch {
    // Code the parser recovered from in an unexpected shape: the graph
    // keeps the parser's types.
    return types;
  }

  for (const [key, type] of lookup.types) {
    if (type.includes('_') && /(?:^|[<(,\s])_(?:[>),]|$)/.test(type)) {
      continue;
    }

    if (type.startsWith('Range<') || type === 'fmt::Result') {
      continue;
    }

    const members = builtinMembers(type) ?? lookup.importedMembers(type);
    types.set(key, {
      text: type,
      dataType: dataTypeOf(type),
      ...(members ? { members } : {}),
    });
  }

  // Calls: the parameters of what they call, also when the result is
  // unknown (`any` keeps the parser's type).
  for (const [key, signature] of lookup.signatures) {
    types.set(key, {
      ...(types.get(key) ?? { text: '_', dataType: 'any' }),
      signature,
    });
  }

  return types;
}
