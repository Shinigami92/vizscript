import type {
  DataType,
  SourceRange,
  SymbolParam,
  TypeInfo,
  TypeMember,
} from '@vizscript/core';
import type * as TS from 'typescript';

const NOWHERE: SourceRange = { start: 0, end: 0 };

/** Members listed per type, at most (big DOM types have hundreds). */
const MEMBER_LIMIT = 150;

/**
 * The smallest node of `file` that covers `range`. A declaration found
 * this way (`url: string`, `retries = 3`) stands for its name.
 */
function nodeAt(
  ts: typeof TS,
  file: TS.SourceFile,
  range: SourceRange
): TS.Node | undefined {
  let found: TS.Node | undefined;
  const visit = (node: TS.Node): void => {
    if (node.getStart(file) <= range.start && range.end <= node.end) {
      found = node;
      ts.forEachChild(node, visit);
    }
  };
  ts.forEachChild(file, visit);
  if (
    found &&
    (ts.isVariableDeclaration(found) ||
      ts.isParameter(found) ||
      ts.isBindingElement(found) ||
      ts.isPropertyDeclaration(found)) &&
    found.name.getStart(file) === range.start
  ) {
    return found.name;
  }

  return found;
}

/** Types and their mapping to pin types, for one request. */
class TypeMapper {
  private readonly members = new Map<TS.Type, ReadonlyArray<TypeMember>>();

  public constructor(
    private readonly ts: typeof TS,
    private readonly checker: TS.TypeChecker
  ) {}

  public text(type: TS.Type): string {
    // As written in the code: `Command`, not `import("…").Command`.
    return this.checker.typeToString(
      type,
      undefined,
      this.ts.TypeFormatFlags.NoTruncation |
        this.ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope
    );
  }

  /** `0.2` → `number`, `'a' | 'b'` → `string`, `true` → `boolean`. */
  public widen(type: TS.Type): TS.Type {
    const { ts, checker } = this;
    if (type.flags & ts.TypeFlags.BooleanLiteral) {
      return checker.getBooleanType();
    }

    if (type.isUnion() && type.types.every((t) => t.isStringLiteral())) {
      return checker.getStringType();
    }

    if (type.isUnion() && type.types.every((t) => t.isNumberLiteral())) {
      return checker.getNumberType();
    }

    return checker.getBaseTypeOfLiteralType(type);
  }

  /** The pin type of a TypeScript type. */
  public dataType(type: TS.Type): DataType {
    const { ts, checker } = this;
    const flags = type.flags;
    if (
      flags &
      (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)
    ) {
      return 'any';
    }

    if (flags & ts.TypeFlags.StringLike) {
      return 'string';
    }

    if (flags & ts.TypeFlags.NumberLike) {
      return 'number';
    }

    if (flags & ts.TypeFlags.BooleanLike) {
      return 'bool';
    }

    if (flags & ts.TypeFlags.BigIntLike) {
      return 'bigint';
    }

    if (flags & ts.TypeFlags.Void) {
      return 'void';
    }

    if (flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) {
      return 'null';
    }

    if (type.isUnion()) {
      // `T | undefined` is a `T` pin (an optional value).
      const present = type.types.filter(
        (t) => !(t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined))
      );
      const kinds = new Set(present.map((t) => this.dataType(t)));
      const [only] = kinds;
      return kinds.size === 1 && only !== undefined ? only : 'any';
    }

    if (checker.isArrayType(type) || checker.isTupleType(type)) {
      const [element] = checker.getTypeArguments(type as TS.TypeReference);
      const inner = element ? this.dataType(this.widen(element)) : 'any';
      return inner === 'any' ? 'array' : `${inner}[]`;
    }

    const name = type.getSymbol()?.getName();
    if (name === 'RegExp') {
      return 'regexp';
    }

    if (
      type.getCallSignatures().length > 0 &&
      type.getProperties().length === 0
    ) {
      return 'function';
    }

    // Anonymous object types (`{ a: number }`, `__type`, `__object`).
    if (!name || name.startsWith('__')) {
      return 'object';
    }

    return this.text(type);
  }

  /** Fields and methods of an object type, for the action menu. */
  public membersOf(type: TS.Type): ReadonlyArray<TypeMember> | undefined {
    const cached = this.members.get(type);
    if (cached) {
      return cached;
    }

    const { ts, checker } = this;
    const primitive =
      ts.TypeFlags.StringLike |
      ts.TypeFlags.NumberLike |
      ts.TypeFlags.BooleanLike |
      ts.TypeFlags.BigIntLike |
      ts.TypeFlags.ESSymbolLike |
      ts.TypeFlags.Void |
      ts.TypeFlags.Undefined |
      ts.TypeFlags.Null;
    if (
      type.flags & primitive ||
      checker.isArrayType(type) ||
      checker.isTupleType(type) ||
      type.isUnion()
    ) {
      return undefined;
    }

    const members: TypeMember[] = [];
    for (const symbol of checker.getPropertiesOfType(type)) {
      const name = symbol.getName();
      const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
      if (
        members.length >= MEMBER_LIMIT ||
        name.startsWith('__') ||
        name.startsWith('#') ||
        !declaration
      ) {
        continue;
      }

      const memberType = checker.getTypeOfSymbolAtLocation(symbol, declaration);
      const [signature] = memberType.getCallSignatures();
      const method =
        signature !== undefined &&
        (ts.isMethodDeclaration(declaration) ||
          ts.isMethodSignature(declaration) ||
          ts.isFunctionDeclaration(declaration));
      members.push(
        method
          ? {
              name,
              kind: 'method',
              type: this.dataType(checker.getReturnTypeOfSignature(signature)),
              detail: `${name}${checker.signatureToString(signature)}`,
            }
          : {
              name,
              kind: 'property',
              type: this.dataType(this.widen(memberType)),
              detail: `${name}: ${this.text(memberType)}`,
            }
      );
    }

    this.members.set(type, members);
    return members;
  }

  /**
   * The parameters of the function a call resolves to (the matching
   * overload), with optional ones defaulting to `undefined`.
   */
  public signature(
    call: TS.CallExpression | TS.NewExpression
  ): SymbolParam[] | undefined {
    const { ts, checker } = this;
    const resolved = checker.getResolvedSignature(call);
    const params = resolved?.getParameters() ?? [];
    if (params.length === 0) {
      return undefined;
    }

    return params.map((symbol): SymbolParam => {
      const declaration = symbol.valueDeclaration;
      const parameter =
        declaration && ts.isParameter(declaration) ? declaration : undefined;
      const type = checker.getTypeOfSymbolAtLocation(symbol, call);
      const optional =
        parameter !== undefined &&
        (parameter.questionToken !== undefined ||
          parameter.initializer !== undefined);
      const defaultText = parameter?.initializer
        ? parameter.initializer.getText(parameter.getSourceFile())
        : optional
          ? 'undefined'
          : undefined;
      return {
        name: symbol.getName(),
        nameRange: NOWHERE,
        type: { text: this.text(type), range: NOWHERE },
        dataType: this.dataType(this.widen(type)),
        ...(defaultText === undefined ? {} : { defaultText }),
        ...(parameter?.dotDotDotToken ? { rest: true } : {}),
      };
    });
  }

  public info(type: TS.Type): TypeInfo {
    const widened = this.widen(type);
    const dataType = this.dataType(widened);
    const members = dataType === 'any' ? undefined : this.membersOf(widened);
    return {
      text: this.text(widened),
      dataType,
      ...(members && members.length > 0 ? { members } : {}),
    };
  }
}

/**
 * The types TypeScript's checker sees at `ranges` of `fileName`: one
 * answer per range, `undefined` where no node covers it.
 */
export function checkerTypesAt(
  ts: typeof TS,
  program: TS.Program,
  fileName: string,
  ranges: ReadonlyArray<SourceRange>
): Array<TypeInfo | undefined> {
  const file = program.getSourceFile(fileName);
  if (!file) {
    return ranges.map(() => undefined);
  }

  const checker = program.getTypeChecker();
  const mapper = new TypeMapper(ts, checker);
  return ranges.map((range) => {
    const node = nodeAt(ts, file, range);
    if (!node || node === file) {
      return undefined;
    }

    try {
      const info = mapper.info(checker.getTypeAtLocation(node));
      const signature =
        ts.isCallExpression(node) || ts.isNewExpression(node)
          ? mapper.signature(node)
          : undefined;
      return signature ? { ...info, signature } : info;
    } catch {
      return undefined;
    }
  });
}
