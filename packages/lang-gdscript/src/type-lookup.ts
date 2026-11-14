import type {
  EngineClass,
  ScriptSymbol,
  TypeInfo,
  TypeMap,
  TypeMember,
} from '@vizscript/core';
import { classMembers, rangeKey } from '@vizscript/core';
import type { Block, Expr, FuncDecl, Script, Span, Stmt } from './ast';
import { dataTypeOf } from './data-type';
import { godotBuiltins, godotClasses, godotGlobals } from './godot';
import { unwrap } from './lower-utils';

/** A class used by name (`Input.get_axis()`, `Vector2.ZERO`, `X.new()`). */
const CLASS = 'class:';
/** The script itself when it has no `class_name`. */
const SELF = '@self';
/** The base class of a script without `extends`. */
const BASE = 'RefCounted';

const NUMBERS = new Set(['int', 'float']);
const STRINGS = new Set(['String', 'StringName']);
const VECTORS = new Set([
  'Vector2',
  'Vector2i',
  'Vector3',
  'Vector3i',
  'Vector4',
  'Vector4i',
  'Color',
]);
const BOOLEAN_OPS = new Set([
  '==',
  '!=',
  '<',
  '>',
  '<=',
  '>=',
  'in',
  'not in',
  'and',
  'or',
  '&&',
  '||',
]);
const BITWISE_OPS = new Set(['&', '|', '^', '<<', '>>']);
/** Parameters of Godot's callbacks (`func _process(delta):`). */
const CALLBACK_PARAMS: Record<string, ReadonlyArray<string>> = {
  _process: ['float'],
  _physics_process: ['float'],
  _input: ['InputEvent'],
  _unhandled_input: ['InputEvent'],
  _unhandled_key_input: ['InputEvent'],
  _shortcut_input: ['InputEvent'],
  _gui_input: ['InputEvent'],
  _notification: ['int'],
};
/** Godot's global constants. */
const CONSTANTS: Record<string, string> = {
  PI: 'float',
  TAU: 'float',
  INF: 'float',
  NAN: 'float',
};
/** Types made by calling their name (`int(x)`, `Vector2(1, 2)`). */
const CONSTRUCTORS = new Set([
  'int',
  'float',
  'bool',
  'String',
  'StringName',
  'NodePath',
  'Transform2D',
  'Transform3D',
  'Basis',
  'Quaternion',
  'AABB',
  ...VECTORS,
]);
const PACKED: Record<string, string> = {
  PackedByteArray: 'int',
  PackedInt32Array: 'int',
  PackedInt64Array: 'int',
  PackedFloat32Array: 'float',
  PackedFloat64Array: 'float',
  PackedStringArray: 'String',
  PackedVector2Array: 'Vector2',
  PackedVector3Array: 'Vector3',
  PackedColorArray: 'Color',
};
/** Array methods that return an element (`items.pop_back()`). */
const ELEMENT_METHODS = new Set([
  'back',
  'front',
  'pick_random',
  'pop_back',
  'pop_front',
  'pop_at',
  'max',
  'min',
]);
/** Global functions whose result follows their arguments. */
const GENERIC_GLOBALS = new Set([
  'abs',
  'sign',
  'min',
  'max',
  'clamp',
  'lerp',
  'snapped',
  'wrap',
]);

/** The class whose members a type has (`Array[Node]` → `Array`). */
function classOf(type: string): string {
  if (/^Array\[.+\]$/.test(type) || type in PACKED) {
    return 'Array';
  }

  return STRINGS.has(type) || type === 'NodePath' ? 'String' : type;
}

/** What iterating or indexing a value gives (`Array[Node]` → `Node`). */
function elementOf(type: string | undefined): string | undefined {
  if (type === undefined) {
    return undefined;
  }

  const typed = type.match(/^Array\[(.+)\]$/);
  if (typed) {
    return typed[1];
  }

  if (STRINGS.has(type)) {
    return 'String';
  }

  if (type.endsWith('i') && VECTORS.has(type)) {
    return 'int';
  }

  return VECTORS.has(type) ? 'float' : PACKED[type];
}

function binaryType(
  op: string,
  left: string | undefined,
  right: string | undefined
): string | undefined {
  if (BOOLEAN_OPS.has(op)) {
    return 'bool';
  }

  if (BITWISE_OPS.has(op)) {
    return 'int';
  }

  if (left === undefined || right === undefined) {
    return undefined;
  }

  if (STRINGS.has(left) && (op === '%' || (op === '+' && STRINGS.has(right)))) {
    return 'String';
  }

  if (NUMBERS.has(left) && NUMBERS.has(right)) {
    return left === 'int' && right === 'int' ? 'int' : 'float';
  }

  if (VECTORS.has(left) && (NUMBERS.has(right) || right === left)) {
    return left;
  }

  if (VECTORS.has(right) && NUMBERS.has(left) && op === '*') {
    return right;
  }

  return op === '+' && left === right && classOf(left) === 'Array'
    ? left
    : undefined;
}

/** `abs(x)`, `min(a, b)`, `lerp(a, b, t)`: the type of the values. */
function genericResult(
  args: ReadonlyArray<string | undefined>
): string | undefined {
  const [first] = args;
  if (first !== undefined && VECTORS.has(first)) {
    return first;
  }

  const numbers = args.filter((a): a is string => a !== undefined);
  if (numbers.length === 0 || !numbers.every((a) => NUMBERS.has(a))) {
    return undefined;
  }

  return numbers.every((a) => a === 'int') && args.length === numbers.length
    ? 'int'
    : 'float';
}

/** What `load("res://…")` / `preload` gives, from the file's extension. */
function resourceType(arg: Expr | undefined): string {
  const path = arg?.type === 'Literal' ? arg.value : '';
  if (/\.t?scn$/i.test(path)) {
    return 'PackedScene';
  }

  return /\.(png|jpe?g|svg|webp)$/i.test(path) ? 'Texture2D' : 'Resource';
}

let allClasses: EngineClass[] | undefined;

function knownClasses(): EngineClass[] {
  allClasses ??= [...godotClasses(), ...godotBuiltins()];
  return allClasses;
}

interface Member {
  kind: 'value' | 'method';
  /** Type of the value, or result of the method. */
  type: string | undefined;
}

function engineMember(type: string, name: string): Member | undefined {
  const symbol = classMembers(knownClasses(), classOf(type)).find(
    (s) => s.name === name
  );
  if (!symbol) {
    return undefined;
  }

  if (symbol.kind === 'method' || symbol.kind === 'function') {
    const returns = symbol.returns?.text;
    return {
      kind: 'method',
      type:
        returns === 'Variant' && ELEMENT_METHODS.has(name)
          ? elementOf(type)
          : returns,
    };
  }

  return {
    kind: 'value',
    type: symbol.kind === 'signal' ? 'Signal' : symbol.type?.text,
  };
}

/** Members a script class declares, and the class it extends. */
interface ClassScope {
  name: string;
  base: string;
  /** Variables, constants and signals; `undefined`: type unknown. */
  values: Map<string, string | undefined>;
  /** Functions with their declared result. */
  functions: Map<string, string | undefined>;
}

/** Variables of a function or block. */
class Scope {
  public readonly values = new Map<string, string | undefined>();

  public constructor(public readonly parent?: Scope) {}

  public find(name: string): { type: string | undefined } | undefined {
    const owner = this.owner(name);
    return owner ? { type: owner.values.get(name) } : undefined;
  }

  /** Gives a variable declared without a type the type of its value. */
  public assign(name: string, type: string): void {
    const owner = this.owner(name);
    if (owner && owner.values.get(name) === undefined) {
      owner.values.set(name, type);
    }
  }

  /** The scope that declares `name`. */
  private owner(name: string): Scope | undefined {
    return this.values.has(name) ? this : this.parent?.owner(name);
  }
}

/** A literal array or dictionary: the parser types its elements better. */
function isCollection(expr: Expr | undefined): boolean {
  const e = expr && unwrap(expr);
  return e?.type === 'Array' || e?.type === 'Dictionary';
}

/**
 * Follows the types of values through a script, like Godot's analyzer:
 * declared and inferred variables, members of Godot's classes and built-in
 * types, global functions and operators. Answers by source range, as Godot
 * writes the type (`float`, `Array[Node]`); unknown values have none.
 */
class TypeLookup {
  public readonly types = new Map<string, string>();
  private readonly classes = new Map<string, ClassScope>();
  private readonly enums = new Set<string>();
  private current: ClassScope;

  public constructor(script: Script) {
    this.current = this.declareClass(
      script.className ?? SELF,
      script.extendsName ?? BASE,
      script.body
    );
    this.walkClass(this.current, script.body);
  }

  private record(span: Span, type: string | undefined): void {
    if (type !== undefined) {
      this.types.set(rangeKey(span), type);
    }
  }

  private declareClass(
    name: string,
    base: string,
    body: ReadonlyArray<Stmt>
  ): ClassScope {
    const scope: ClassScope = {
      name,
      base,
      values: new Map(),
      functions: new Map(),
    };
    this.classes.set(name, scope);
    for (const stmt of body) {
      switch (stmt.type) {
        case 'Var': {
          scope.values.set(stmt.name, stmt.typeRef?.name);
          break;
        }

        case 'Func': {
          if (stmt.name) {
            scope.functions.set(stmt.name, stmt.returnType?.name);
          }

          break;
        }

        case 'Signal': {
          scope.values.set(stmt.name, 'Signal');
          break;
        }

        case 'Class': {
          this.declareClass(stmt.name, stmt.extends ?? BASE, stmt.body.body);
          break;
        }

        case 'Enum': {
          if (stmt.name) {
            this.enums.add(stmt.name);
          }

          break;
        }

        default: {
          break;
        }
      }
    }

    return scope;
  }

  private walkClass(scope: ClassScope, body: ReadonlyArray<Stmt>): void {
    const outer = this.current;
    this.current = scope;
    const members = new Scope();
    // Variables first: functions use them wherever they are declared.
    for (const stmt of body) {
      if (stmt.type === 'Var') {
        const type = this.declare(stmt, members);
        if (stmt.typeRef === undefined && type !== undefined) {
          scope.values.set(stmt.name, type);
        }

        for (const accessor of [stmt.setter, stmt.getter]) {
          if (accessor) {
            this.walkFunction(accessor, members, type);
          }
        }
      }
    }

    for (const stmt of body) {
      if (stmt.type === 'Func') {
        this.walkFunction(
          stmt,
          members,
          undefined,
          stmt.name ? CALLBACK_PARAMS[stmt.name] : undefined
        );
      } else if (stmt.type === 'Class') {
        const inner = this.classes.get(stmt.name);
        if (inner) {
          this.walkClass(inner, stmt.body.body);
        }
      }
    }

    this.current = outer;
  }

  /** A `var` / `const`: its type, declared or of its value. */
  private declare(
    stmt: Extract<Stmt, { type: 'Var' }>,
    scope: Scope
  ): string | undefined {
    const value = stmt.value ? this.infer(stmt.value, scope) : undefined;
    const type = stmt.typeRef?.name ?? value;
    if (stmt.typeRef !== undefined || !isCollection(stmt.value)) {
      this.record(stmt.nameSpan, type);
    }

    return type;
  }

  /**
   * `valueType`: the type of a setter's parameter; `known`: parameters of
   * a Godot callback.
   */
  private walkFunction(
    fn: FuncDecl,
    parent: Scope,
    valueType?: string,
    known?: ReadonlyArray<string>
  ): void {
    const scope = new Scope(parent);
    for (const [index, param] of fn.params.entries()) {
      const value = param.defaultValue
        ? this.infer(param.defaultValue, scope)
        : undefined;
      const type = param.type?.name ?? value ?? valueType ?? known?.[index];
      scope.values.set(param.name, type);
      this.record(param, type);
      this.record(
        { start: param.start, end: param.start + param.name.length },
        type
      );
    }

    this.walkBlock(fn.body, scope);
  }

  private walkBlock(block: Block, parent: Scope): void {
    const scope = new Scope(parent);
    for (const stmt of block.body) {
      this.walkStatement(stmt, scope);
    }
  }

  private walkStatement(stmt: Stmt, scope: Scope): void {
    switch (stmt.type) {
      case 'Var': {
        scope.values.set(stmt.name, this.declare(stmt, scope));
        break;
      }

      case 'Expr': {
        this.infer(stmt.expr, scope);
        break;
      }

      case 'Assign': {
        this.infer(stmt.target, scope);
        const value = this.infer(stmt.value, scope);
        const target = unwrap(stmt.target);
        if (target.type === 'Identifier' && value && stmt.op === '=') {
          scope.assign(target.name, value);
        }

        break;
      }

      case 'If': {
        this.infer(stmt.test, scope);
        this.walkBlock(stmt.body, scope);
        for (const elif of stmt.elifs) {
          this.infer(elif.test, scope);
          this.walkBlock(elif.body, scope);
        }

        if (stmt.orelse) {
          this.walkBlock(stmt.orelse, scope);
        }

        break;
      }

      case 'For': {
        const iterable = this.infer(stmt.iterable, scope);
        const item =
          stmt.variableType?.name ??
          (iterable === 'int' ? 'int' : elementOf(iterable));
        const inner = new Scope(scope);
        inner.values.set(stmt.variable, item);
        this.record(stmt.variableSpan, item);
        this.walkBlock(stmt.body, inner);
        break;
      }

      case 'While': {
        this.infer(stmt.test, scope);
        this.walkBlock(stmt.body, scope);
        break;
      }

      case 'Match': {
        this.infer(stmt.subject, scope);
        for (const branch of stmt.branches) {
          this.walkBlock(branch.body, scope);
        }

        break;
      }

      case 'Return': {
        if (stmt.value) {
          this.infer(stmt.value, scope);
        }

        break;
      }

      case 'Func': {
        this.walkFunction(stmt, scope);
        break;
      }

      default: {
        break;
      }
    }
  }

  /** A member of a type, the script's classes first. */
  private member(type: string, name: string, depth = 0): Member | undefined {
    const own = this.classes.get(type);
    if (!own) {
      return engineMember(type, name);
    }

    if (own.values.has(name)) {
      return { kind: 'value', type: own.values.get(name) };
    }

    if (own.functions.has(name)) {
      return { kind: 'method', type: own.functions.get(name) };
    }

    return depth < 16 ? this.member(own.base, name, depth + 1) : undefined;
  }

  private identifier(name: string, scope: Scope): string | undefined {
    const local = scope.find(name);
    if (local) {
      return local.type;
    }

    const member = this.member(this.current.name, name);
    if (member) {
      return member.kind === 'value' ? member.type : 'Callable';
    }

    if (name in CONSTANTS) {
      return CONSTANTS[name];
    }

    const known =
      this.classes.has(name) ||
      this.enums.has(name) ||
      CONSTRUCTORS.has(name) ||
      knownClasses().some((c) => c.name === name);
    return known ? `${CLASS}${name}` : undefined;
  }

  private infer(expr: Expr, scope: Scope): string | undefined {
    const type = this.typeOf(expr, scope);
    if (expr.type !== 'Self' && expr.type !== 'Super' && !isCollection(expr)) {
      this.record(expr, type);
    }

    return type;
  }

  private typeOf(expr: Expr, scope: Scope): string | undefined {
    switch (expr.type) {
      case 'Literal': {
        switch (expr.kind) {
          case 'null': {
            return undefined;
          }

          case 'string': {
            return 'String';
          }

          case 'stringName': {
            return 'StringName';
          }

          case 'nodePath': {
            return 'NodePath';
          }

          default: {
            return expr.kind;
          }
        }
      }

      case 'Identifier': {
        return this.identifier(expr.name, scope);
      }

      case 'Self': {
        return this.current.name;
      }

      case 'Super': {
        return this.current.base;
      }

      case 'NodePath': {
        return 'Node';
      }

      case 'Paren': {
        return this.infer(expr.expr, scope);
      }

      case 'Binary': {
        const left = this.infer(expr.left, scope);
        const right = this.infer(expr.right, scope);
        return binaryType(expr.op, left, right);
      }

      case 'Unary': {
        const argument = this.infer(expr.argument, scope);
        if (expr.op === 'not' || expr.op === '!') {
          return 'bool';
        }

        return expr.op === '~' ? 'int' : argument;
      }

      case 'Ternary': {
        this.infer(expr.test, scope);
        const yes = this.infer(expr.consequent, scope);
        const no = this.infer(expr.alternate, scope);
        if (yes === no) {
          return yes;
        }

        return yes && no && NUMBERS.has(yes) && NUMBERS.has(no)
          ? 'float'
          : undefined;
      }

      case 'Cast': {
        this.infer(expr.expr, scope);
        return expr.target.name;
      }

      case 'Is': {
        this.infer(expr.expr, scope);
        return 'bool';
      }

      case 'Call': {
        return this.callType(expr, scope);
      }

      case 'Attribute': {
        return this.attributeType(this.infer(expr.object, scope), expr.name);
      }

      case 'Subscript': {
        const object = this.infer(expr.object, scope);
        this.infer(expr.index, scope);
        return elementOf(object);
      }

      case 'Array': {
        for (const element of expr.elements) {
          this.infer(element, scope);
        }

        return 'Array';
      }

      case 'Dictionary': {
        for (const entry of expr.entries) {
          this.infer(entry.key, scope);
          this.infer(entry.value, scope);
        }

        return 'Dictionary';
      }

      case 'Await': {
        const value = this.infer(expr.argument, scope);
        return unwrap(expr.argument).type === 'Call' ? value : undefined;
      }

      case 'Lambda': {
        this.walkFunction(expr.fn, scope);
        return 'Callable';
      }

      default: {
        return undefined;
      }
    }
  }

  private attributeType(
    object: string | undefined,
    name: string
  ): string | undefined {
    if (object === undefined) {
      return undefined;
    }

    const cls = object.startsWith(CLASS)
      ? object.slice(CLASS.length)
      : undefined;
    if (cls !== undefined && this.enums.has(cls)) {
      return 'int';
    }

    const member = this.member(cls ?? object, name);
    if (!member) {
      return undefined;
    }

    return member.kind === 'value' ? member.type : 'Callable';
  }

  private callType(
    expr: Extract<Expr, { type: 'Call' }>,
    scope: Scope
  ): string | undefined {
    const callee = unwrap(expr.callee);
    const args = expr.args.map((arg) => this.infer(arg, scope));
    if (callee.type === 'Attribute') {
      const object = this.infer(callee.object, scope);
      if (object === undefined) {
        return undefined;
      }

      const cls = object.startsWith(CLASS)
        ? object.slice(CLASS.length)
        : undefined;
      if (cls !== undefined && callee.name === 'new') {
        return cls;
      }

      const member = this.member(cls ?? object, callee.name);
      return member?.kind === 'method' ? member.type : undefined;
    }

    if (callee.type !== 'Identifier') {
      this.infer(callee, scope);
      return undefined;
    }

    const name = callee.name;
    if (scope.find(name)) {
      // A variable holding a function (`callback()`).
      return undefined;
    }

    const member = this.member(this.current.name, name);
    if (member?.kind === 'method') {
      return member.type;
    }

    if (name === 'load' || name === 'preload') {
      return resourceType(expr.args[0] && unwrap(expr.args[0]));
    }

    if (GENERIC_GLOBALS.has(name)) {
      return genericResult(args);
    }

    const global = godotGlobals().get(name);
    if (global) {
      return global.returns?.text;
    }

    return CONSTRUCTORS.has(name) || this.classes.has(name) ? name : undefined;
  }
}

function signature(symbol: ScriptSymbol): string {
  const type = symbol.type?.text;
  if (symbol.kind !== 'method') {
    return type ? `${symbol.name}: ${type}` : symbol.name;
  }

  const params = (symbol.params ?? [])
    .map((p) => (p.type ? `${p.name}: ${p.type.text}` : p.name))
    .join(', ');
  return `${symbol.name}(${params}) -> ${symbol.returns?.text ?? 'Variant'}`;
}

const membersCache = new Map<string, ReadonlyArray<TypeMember> | undefined>();

/** Members of a built-in type (`Vector2`, `String`), for the action menu. */
function builtinMembers(type: string): ReadonlyArray<TypeMember> | undefined {
  const cls = classOf(type);
  if (!membersCache.has(cls)) {
    const builtin = godotBuiltins().find((c) => c.name === cls);
    membersCache.set(
      cls,
      builtin?.members
        .filter((m) => m.kind !== 'constant')
        .map((m): TypeMember => {
          const method = m.kind === 'method';
          return {
            name: m.name,
            kind: method ? 'method' : 'property',
            type: dataTypeOf(method ? m.returns?.text : m.type?.text),
            detail: signature(m),
          };
        })
    );
  }

  return membersCache.get(cls);
}

/**
 * Types of the values of a GDScript file, by source range (see
 * `TypeLookup`): what `applyTypes` makes the pins and symbols of its graph.
 */
export function gdscriptTypes(script: Script): TypeMap {
  const types = new Map<string, TypeInfo>();
  let found: ReadonlyMap<string, string>;
  try {
    found = new TypeLookup(script).types;
  } catch {
    // Code the parser recovered from in an unexpected shape: the graph
    // keeps the parser's types.
    return types;
  }

  for (const [key, text] of found) {
    if (
      text.startsWith(CLASS) ||
      text.startsWith('@') ||
      text === 'Variant' ||
      text === 'Array' ||
      text === 'Dictionary'
    ) {
      continue;
    }

    const members = builtinMembers(text);
    types.set(key, {
      text,
      dataType: dataTypeOf(text),
      ...(members ? { members } : {}),
    });
  }

  return types;
}
