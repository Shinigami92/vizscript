import type { ImportedDeclaration, TypeInfo, TypeMap } from '@vizscript/core';
import type { Block, ClassDef, Expr, FunctionDef, Param, Stmt } from './ast';
import { builtinMembers, callableOf } from './builtin-types';
import { dataTypeOf, unwrap } from './lower-utils';
import type { ClassScope } from './type-expressions';
import { CLASS, MODULE, Scope, TypeExpressions } from './type-expressions';
import { binaryType, generic, itemOf, known, normalize } from './type-text';

/**
 * Follows the types of values through a Python file, like a type checker
 * would for code without surprises: annotations, assignments (the first
 * value an unannotated name gets), loops, `with` and `except` targets,
 * classes of the file with the fields their methods set, imported
 * declarations, and the built-in types and functions. The statements are
 * walked here; what expressions are comes from `TypeExpressions`.
 */
class TypeLookup extends TypeExpressions {
  public constructor(
    text: string,
    body: ReadonlyArray<Stmt>,
    imports: ReadonlyArray<ImportedDeclaration>
  ) {
    super(text, imports);
    const module = new Scope();
    this.declare(body, module);
    this.walkBody(body, module);
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
  let lookup: TypeLookup;
  try {
    lookup = new TypeLookup(text, body, imports);
  } catch {
    // Code the parser recovered from in an unexpected shape: the graph
    // keeps the parser's types.
    return types;
  }

  for (const [key, type] of lookup.types) {
    // An imported module (`json`) is an object, like UE's object Gets.
    if (type.startsWith(MODULE)) {
      types.set(key, { text: 'module', dataType: 'module' });
      continue;
    }

    if (type.startsWith(CLASS) || VAGUE.has(type)) {
      continue;
    }

    const members = builtinMembers(type);
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
      ...(types.get(key) ?? { text: 'Any', dataType: 'any' }),
      signature,
    });
  }

  return types;
}
