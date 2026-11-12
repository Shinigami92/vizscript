import type * as t from '@babel/types';
import type {
  DataType,
  ScriptSymbol,
  SourceRange,
  SymbolKind,
  SymbolParam,
  TypeRef,
} from '@vizscript/core';
import { symbolId } from '@vizscript/core';
import { patternAnnotation, typeFromAnnotation } from './annotations';

type FunctionLike =
  | t.FunctionDeclaration
  | t.FunctionExpression
  | t.ArrowFunctionExpression
  | t.ClassMethod
  | t.ClassPrivateMethod
  | t.TSDeclareFunction;

function rangeOf(node: t.Node): SourceRange {
  return { start: node.start ?? 0, end: node.end ?? 0 };
}

/** Range of just the name (Babel's identifier range includes its type). */
function nameRangeOf(node: t.Identifier | t.PrivateName): SourceRange {
  const start = node.start ?? 0;
  const name = node.type === 'PrivateName' ? `#${node.id.name}` : node.name;
  return { start, end: start + name.length };
}

/** Pin type of a value without annotation, from its kind of expression. */
function inferType(expr: t.Node | null | undefined): DataType {
  switch (expr?.type) {
    case 'StringLiteral':
    case 'TemplateLiteral': {
      return 'string';
    }

    case 'NumericLiteral': {
      return 'number';
    }

    case 'BooleanLiteral': {
      return 'bool';
    }

    case 'BigIntLiteral': {
      return 'bigint';
    }

    case 'NullLiteral': {
      return 'null';
    }

    case 'RegExpLiteral': {
      return 'regexp';
    }

    case 'ArrayExpression': {
      return 'array';
    }

    case 'ObjectExpression': {
      return 'object';
    }

    case 'ArrowFunctionExpression':
    case 'FunctionExpression': {
      return 'function';
    }

    case 'NewExpression': {
      return expr.callee.type === 'Identifier' ? expr.callee.name : 'object';
    }

    case 'TSAsExpression':
    case 'TSSatisfiesExpression': {
      return typeFromAnnotation(expr.typeAnnotation);
    }

    default: {
      return 'any';
    }
  }
}

function isFunctionExpression(
  node: t.Node | null | undefined
): node is t.ArrowFunctionExpression | t.FunctionExpression {
  return (
    node?.type === 'ArrowFunctionExpression' ||
    node?.type === 'FunctionExpression'
  );
}

/** Nodes that start a new function scope (locals stop there). */
const SCOPE_BOUNDARIES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'ObjectMethod',
  'ClassMethod',
  'ClassPrivateMethod',
  'ClassDeclaration',
  'ClassExpression',
]);

/** Child nodes of a Babel node (skips comments and location data). */
function children(node: t.Node): t.Node[] {
  const result: t.Node[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (
      key === 'leadingComments' ||
      key === 'trailingComments' ||
      key === 'innerComments' ||
      key === 'loc'
    ) {
      continue;
    }

    for (const item of Array.isArray(value) ? value : [value]) {
      if (
        item !== null &&
        typeof item === 'object' &&
        typeof (item as { type?: unknown }).type === 'string'
      ) {
        result.push(item as t.Node);
      }
    }
  }

  return result;
}

class SymbolCollector {
  readonly symbols: ScriptSymbol[] = [];

  constructor(private readonly text: string) {}

  private typeRef(annotation: t.Node | null | undefined): TypeRef | undefined {
    if (!annotation) {
      return undefined;
    }

    const node =
      annotation.type === 'TSTypeAnnotation'
        ? annotation.typeAnnotation
        : annotation;
    const range = rangeOf(node);
    return { text: this.text.slice(range.start, range.end), range };
  }

  private add(
    symbol: Omit<ScriptSymbol, 'id' | 'modifiers'> & { modifiers?: string[] }
  ): void {
    const id = symbolId(symbol.kind, symbol.scope, symbol.name);
    if (this.symbols.some((s) => s.id === id)) {
      return;
    }

    this.symbols.push({ ...symbol, id, modifiers: symbol.modifiers ?? [] });
  }

  private param(node: t.Node): SymbolParam {
    let pattern = node.type === 'TSParameterProperty' ? node.parameter : node;
    let defaultRange: SourceRange | undefined;
    let rest = false;
    if (pattern.type === 'AssignmentPattern') {
      defaultRange = rangeOf(pattern.right);
      pattern = pattern.left;
    }

    if (pattern.type === 'RestElement') {
      rest = true;
      pattern = pattern.argument;
    }

    const annotation = patternAnnotation(node);
    const type = this.typeRef(annotation);
    let name: string;
    let nameRange: SourceRange;
    if (pattern.type === 'Identifier') {
      name = pattern.name;
      nameRange = nameRangeOf(pattern);
    } else {
      // Destructuring: the pattern without its annotation is the name.
      const r = rangeOf(pattern);
      const end = type ? Math.min(r.end, type.range.start) : r.end;
      name = this.text.slice(r.start, end).replace(/\s*:\s*$/, '');
      nameRange = { start: r.start, end: r.start + name.length };
    }

    return {
      name,
      nameRange,
      ...(type ? { type } : {}),
      dataType: type
        ? typeFromAnnotation(annotation)
        : defaultRange && node.type === 'AssignmentPattern'
          ? inferType(node.right)
          : 'any',
      ...(defaultRange ? { defaultRange } : {}),
      ...(rest ? { rest } : {}),
    };
  }

  private fn(
    kind: SymbolKind,
    name: string,
    nameRange: SourceRange,
    scope: string,
    node: FunctionLike,
    range: SourceRange,
    modifiers: string[]
  ): void {
    const returns = this.typeRef(node.returnType);
    const qualified = scope ? `${scope}.${name}` : name;
    this.add({
      kind,
      name,
      scope,
      range,
      nameRange,
      dataType: 'function',
      modifiers: [...modifiers, ...(node.async ? ['async'] : [])],
      params: node.params.map((p) => this.param(p)),
      ...(returns
        ? { returns, returnType: typeFromAnnotation(node.returnType) }
        : {}),
      graphStart: node.start ?? 0,
    });
    if (node.type !== 'TSDeclareFunction') {
      this.locals(node.body, qualified);
    }
  }

  /** `const`/`let`/`var` declarations inside a function body. */
  private locals(body: t.Node, scope: string): void {
    const visit = (node: t.Node): void => {
      if (SCOPE_BOUNDARIES.has(node.type)) {
        return;
      }

      if (node.type === 'VariableDeclaration') {
        this.variables(node, scope, true, []);
      }

      for (const child of children(node)) {
        visit(child);
      }
    };

    for (const child of children(body)) {
      visit(child);
    }
  }

  private variables(
    decl: t.VariableDeclaration,
    scope: string,
    local: boolean,
    modifiers: string[],
    statement: SourceRange = rangeOf(decl)
  ): void {
    for (const declarator of decl.declarations) {
      if (declarator.id.type !== 'Identifier') {
        continue;
      }

      const id = declarator.id;
      const init = declarator.init;
      // `const add = (a, b) => a + b` is a function, like a declaration.
      if (!local && isFunctionExpression(init)) {
        this.fn(
          'function',
          id.name,
          nameRangeOf(id),
          scope,
          init,
          rangeOf(declarator),
          [...modifiers, decl.kind]
        );
        continue;
      }

      const type = this.typeRef(id.typeAnnotation);
      this.add({
        kind: local ? 'local' : decl.kind === 'const' ? 'constant' : 'variable',
        name: id.name,
        scope,
        range: rangeOf(declarator),
        nameRange: nameRangeOf(id),
        ...(type ? { type } : {}),
        dataType: type
          ? typeFromAnnotation(id.typeAnnotation)
          : inferType(init),
        ...(init ? { defaultRange: rangeOf(init) } : {}),
        declarationRange: statement,
        modifiers: [...modifiers, decl.kind],
      });
    }
  }

  private classDecl(
    node: t.ClassDeclaration,
    range: SourceRange,
    modifiers: string[]
  ): void {
    if (!node.id) {
      return;
    }

    const name = node.id.name;
    const base = node.superClass ? rangeOf(node.superClass) : undefined;
    this.add({
      kind: 'class',
      name,
      scope: '',
      range,
      nameRange: nameRangeOf(node.id),
      dataType: name,
      modifiers: [...modifiers, ...(node.abstract ? ['abstract'] : [])],
      ...(base ? { extends: this.text.slice(base.start, base.end) } : {}),
      graphStart: node.start ?? 0,
    });

    for (const member of node.body.body) {
      const memberModifiers = [
        ...(member.type !== 'StaticBlock' &&
        member.type !== 'TSIndexSignature' &&
        'static' in member &&
        member.static
          ? ['static']
          : []),
        ...('accessibility' in member && member.accessibility
          ? [member.accessibility]
          : []),
        ...('readonly' in member && member.readonly ? ['readonly'] : []),
      ];
      if (
        (member.type === 'ClassMethod' ||
          member.type === 'ClassPrivateMethod') &&
        (member.key.type === 'Identifier' || member.key.type === 'PrivateName')
      ) {
        const key = member.key;
        const memberName =
          key.type === 'PrivateName' ? `#${key.id.name}` : key.name;
        this.fn(
          'method',
          member.kind === 'get' || member.kind === 'set'
            ? `${memberName}.${member.kind}`
            : memberName,
          nameRangeOf(key),
          name,
          member,
          rangeOf(member),
          [
            ...memberModifiers,
            ...(member.kind === 'get' || member.kind === 'set'
              ? [member.kind]
              : []),
          ]
        );
      } else if (
        (member.type === 'ClassProperty' ||
          member.type === 'ClassPrivateProperty') &&
        (member.key.type === 'Identifier' || member.key.type === 'PrivateName')
      ) {
        const key = member.key;
        const type = this.typeRef(member.typeAnnotation);
        this.add({
          kind: 'variable',
          name: key.type === 'PrivateName' ? `#${key.id.name}` : key.name,
          scope: name,
          range: rangeOf(member),
          nameRange: nameRangeOf(key),
          ...(type ? { type } : {}),
          dataType: type
            ? typeFromAnnotation(member.typeAnnotation)
            : inferType(member.value),
          ...(member.value ? { defaultRange: rangeOf(member.value) } : {}),
          modifiers: memberModifiers,
        });
      }
    }
  }

  /** `import a, { b as c, type D } from './x'`, `import * as ns from 'y'`. */
  imports(stmt: t.ImportDeclaration): void {
    for (const specifier of stmt.specifiers) {
      let imported: string;
      if (specifier.type === 'ImportDefaultSpecifier') {
        imported = 'default';
      } else if (specifier.type === 'ImportNamespaceSpecifier') {
        imported = '*';
      } else {
        imported =
          specifier.imported.type === 'Identifier'
            ? specifier.imported.name
            : specifier.imported.value;
      }

      const typeOnly =
        stmt.importKind === 'type' ||
        (specifier.type === 'ImportSpecifier' &&
          specifier.importKind === 'type');
      this.add({
        kind: 'import',
        name: specifier.local.name,
        scope: '',
        range: rangeOf(specifier),
        declarationRange: rangeOf(stmt),
        nameRange: nameRangeOf(specifier.local),
        dataType: 'any',
        modifiers: typeOnly ? ['type'] : [],
        module: stmt.source.value,
        imported,
      });
    }
  }

  statement(stmt: t.Statement): void {
    if (stmt.type === 'ImportDeclaration') {
      this.imports(stmt);
      return;
    }

    let node: t.Node = stmt;
    let range = rangeOf(stmt);
    const modifiers: string[] = [];
    if (
      (stmt.type === 'ExportNamedDeclaration' ||
        stmt.type === 'ExportDefaultDeclaration') &&
      stmt.declaration
    ) {
      node = stmt.declaration;
      modifiers.push(
        stmt.type === 'ExportDefaultDeclaration' ? 'export default' : 'export'
      );
    }

    if (modifiers.length === 0) {
      range = rangeOf(node);
    }

    switch (node.type) {
      case 'FunctionDeclaration':
      case 'TSDeclareFunction': {
        if (node.id) {
          this.fn(
            'function',
            node.id.name,
            nameRangeOf(node.id),
            '',
            node,
            range,
            [
              ...modifiers,
              ...(node.type === 'TSDeclareFunction' ? ['declare'] : []),
            ]
          );
        }

        break;
      }

      case 'VariableDeclaration': {
        this.variables(node, '', false, modifiers, range);
        break;
      }

      case 'ClassDeclaration': {
        this.classDecl(node, range, modifiers);
        break;
      }

      case 'TSInterfaceDeclaration':
      case 'TSTypeAliasDeclaration': {
        this.add({
          kind: 'type',
          name: node.id.name,
          scope: '',
          range,
          nameRange: nameRangeOf(node.id),
          dataType: node.id.name,
          modifiers: [
            ...modifiers,
            node.type === 'TSInterfaceDeclaration' ? 'interface' : 'type',
          ],
        });
        break;
      }

      case 'TSEnumDeclaration': {
        this.add({
          kind: 'enum',
          name: node.id.name,
          scope: '',
          range,
          nameRange: nameRangeOf(node.id),
          dataType: node.id.name,
          modifiers: [...modifiers, ...(node.const ? ['const'] : [])],
        });
        break;
      }

      default: {
        break;
      }
    }
  }
}

/** Declarations of a TypeScript / JavaScript program. */
export function typeScriptSymbols(
  program: t.Program,
  text: string
): ScriptSymbol[] {
  const collector = new SymbolCollector(text);
  for (const stmt of program.body) {
    collector.statement(stmt);
  }

  return collector.symbols;
}
