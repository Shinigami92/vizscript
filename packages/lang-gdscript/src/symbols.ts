import type {
  DataType,
  ScriptSymbol,
  SourceRange,
  SymbolParam,
} from '@vizscript/core';
import { symbolId } from '@vizscript/core';
import type {
  Annotation,
  Expr,
  FuncDecl,
  Param,
  Span,
  Stmt,
  TypeRef,
  VarDecl,
} from './ast';
import { dataTypeOf } from './lower';

function spanRange(span: Span): SourceRange {
  return { start: span.start, end: span.end };
}

function inferType(expr: Expr | undefined): DataType {
  switch (expr?.type) {
    case 'Literal': {
      switch (expr.kind) {
        case 'string':
        case 'stringName':
        case 'nodePath': {
          return 'string';
        }

        case 'int':
        case 'float': {
          return 'number';
        }

        case 'bool': {
          return 'bool';
        }

        default: {
          return 'null';
        }
      }
    }

    case 'Array': {
      return 'array';
    }

    case 'Dictionary': {
      return 'object';
    }

    case 'Lambda': {
      return 'function';
    }

    case 'Call': {
      // `Vector2(1, 2)`, `Timer.new()`
      const callee = expr.callee;
      if (callee.type === 'Identifier' && /^[A-Z]/.test(callee.name)) {
        return callee.name;
      }

      if (
        callee.type === 'Attribute' &&
        callee.name === 'new' &&
        callee.object.type === 'Identifier'
      ) {
        return callee.object.name;
      }

      return 'any';
    }

    default: {
      return 'any';
    }
  }
}

const LOADERS = new Set(['preload', 'load']);

class SymbolCollector {
  readonly symbols: ScriptSymbol[] = [];

  constructor(private readonly text: string) {}

  private typeRef(ref: TypeRef | undefined): ScriptSymbol['type'] {
    return ref ? { text: ref.name, range: spanRange(ref) } : undefined;
  }

  /** Range of `name` after a keyword (`func name`, `signal name`). */
  private nameAfter(keyword: string, name: string, from: Span): SourceRange {
    const match = this.text
      .slice(from.start, from.end)
      .match(new RegExp(String.raw`\b${keyword}\s+${name}\b`));
    const start =
      from.start +
      (match?.index === undefined
        ? 0
        : match.index + match[0].length - name.length);
    return { start, end: start + name.length };
  }

  private add(
    symbol: Omit<ScriptSymbol, 'id' | 'modifiers'> & { modifiers?: string[] }
  ): void {
    const id = symbolId(symbol.kind, symbol.scope, symbol.name);
    if (!this.symbols.some((s) => s.id === id)) {
      this.symbols.push({ ...symbol, id, modifiers: symbol.modifiers ?? [] });
    }
  }

  private annotations(list: ReadonlyArray<Annotation>): string[] {
    return list.map((a) => `@${a.name}`);
  }

  private param(param: Param): SymbolParam {
    const type = this.typeRef(param.type);
    return {
      name: param.name,
      nameRange: { start: param.start, end: param.start + param.name.length },
      ...(type ? { type } : {}),
      dataType: type ? dataTypeOf(param.type) : inferType(param.defaultValue),
      ...(param.defaultValue
        ? { defaultRange: spanRange(param.defaultValue) }
        : {}),
    };
  }

  private variable(decl: VarDecl, scope: string, local: boolean): void {
    // `const Bullet = preload("res://bullet.gd")` imports a script.
    const loader = decl.value?.type === 'Call' ? decl.value : undefined;
    const path = loader?.args[0];
    if (
      !local &&
      scope === '' &&
      decl.kind === 'const' &&
      loader?.callee.type === 'Identifier' &&
      LOADERS.has(loader.callee.name) &&
      path?.type === 'Literal' &&
      path.kind === 'string'
    ) {
      this.add({
        kind: 'import',
        name: decl.name,
        scope,
        range: spanRange(decl),
        nameRange: spanRange(decl.nameSpan),
        dataType: 'any',
        defaultRange: spanRange(loader),
        modifiers: [loader.callee.name],
        module: path.value,
        imported: '*',
      });
      return;
    }

    const type = this.typeRef(decl.typeRef);
    this.add({
      kind: local ? 'local' : decl.kind === 'const' ? 'constant' : 'variable',
      name: decl.name,
      scope,
      range: spanRange(decl),
      nameRange: spanRange(decl.nameSpan),
      ...(type ? { type } : {}),
      dataType: type ? dataTypeOf(decl.typeRef) : inferType(decl.value),
      ...(decl.value ? { defaultRange: spanRange(decl.value) } : {}),
      modifiers: [
        ...this.annotations(decl.annotations),
        ...(decl.isStatic ? ['static'] : []),
        decl.kind,
        ...(decl.setter || decl.getter ? ['property'] : []),
      ],
    });
  }

  private fn(decl: FuncDecl, scope: string): void {
    if (!decl.name) {
      return;
    }

    const returns = this.typeRef(decl.returnType);
    this.add({
      kind: 'function',
      name: decl.name,
      scope,
      range: spanRange(decl),
      nameRange: this.nameAfter('func', decl.name, decl),
      dataType: 'function',
      modifiers: [
        ...this.annotations(decl.annotations),
        ...(decl.isStatic ? ['static'] : []),
      ],
      params: decl.params.map((p) => this.param(p)),
      ...(returns ? { returns, returnType: dataTypeOf(decl.returnType) } : {}),
      graphStart: decl.start,
    });
    this.locals(decl.body.body, scope ? `${scope}.${decl.name}` : decl.name);
  }

  /** `var` / `const` and loop variables inside a function body. */
  private locals(stmts: ReadonlyArray<Stmt>, scope: string): void {
    for (const stmt of stmts) {
      switch (stmt.type) {
        case 'Var': {
          this.variable(stmt, scope, true);
          break;
        }

        case 'For': {
          const type = this.typeRef(stmt.variableType);
          this.add({
            kind: 'local',
            name: stmt.variable,
            scope,
            range: spanRange(stmt),
            nameRange: spanRange(stmt.variableSpan),
            ...(type ? { type } : {}),
            dataType: type ? dataTypeOf(stmt.variableType) : 'any',
          });
          this.locals(stmt.body.body, scope);
          break;
        }

        case 'If': {
          this.locals(stmt.body.body, scope);
          for (const elif of stmt.elifs) {
            this.locals(elif.body.body, scope);
          }

          this.locals(stmt.orelse?.body ?? [], scope);
          break;
        }

        case 'While': {
          this.locals(stmt.body.body, scope);
          break;
        }

        case 'Match': {
          for (const branch of stmt.branches) {
            this.locals(branch.body.body, scope);
          }

          break;
        }

        default: {
          break;
        }
      }
    }
  }

  /** Members of the script (scope `''`) or of an inner class. */
  members(body: ReadonlyArray<Stmt>, scope: string): void {
    for (const stmt of body) {
      switch (stmt.type) {
        case 'Var': {
          this.variable(stmt, scope, false);
          break;
        }

        case 'Func': {
          this.fn(stmt, scope);
          break;
        }

        case 'Signal': {
          this.add({
            kind: 'signal',
            name: stmt.name,
            scope,
            range: spanRange(stmt),
            nameRange: this.nameAfter('signal', stmt.name, stmt),
            dataType: 'any',
            params: stmt.params.map((p) => this.param(p)),
          });
          break;
        }

        case 'Enum': {
          if (stmt.name) {
            this.add({
              kind: 'enum',
              name: stmt.name,
              scope,
              range: spanRange(stmt),
              nameRange: this.nameAfter('enum', stmt.name, stmt),
              dataType: stmt.name,
              // `enum State { IDLE, RUN = 2 }`: names before `=` / `,`.
              members: [
                ...(this.text
                  .slice(stmt.start, stmt.end)
                  .match(/\{([\s\S]*)\}/)?.[1]
                  ?.replaceAll(/#.*$/gm, '')
                  .matchAll(/([A-Za-z_]\w*)\s*(?:=[^,]*)?(?:,|$)/g) ?? []),
              ].map((m) => m[1] ?? ''),
            });
          }

          break;
        }

        case 'Class': {
          const qualified = scope ? `${scope}.${stmt.name}` : stmt.name;
          this.add({
            kind: 'class',
            name: stmt.name,
            scope,
            range: spanRange(stmt),
            nameRange: this.nameAfter('class', stmt.name, stmt),
            dataType: stmt.name,
            ...(stmt.extends ? { extends: stmt.extends } : {}),
            graphStart: stmt.start,
          });
          this.members(stmt.body.body, qualified);
          break;
        }

        default: {
          break;
        }
      }
    }
  }
}

/**
 * Declarations of a GDScript file. The file is a class, so its members have
 * the module scope `''`, like the members of a Blueprint.
 */
export function gdscriptSymbols(
  body: ReadonlyArray<Stmt>,
  text: string
): ScriptSymbol[] {
  const collector = new SymbolCollector(text);
  collector.members(body, '');
  return collector.symbols;
}
