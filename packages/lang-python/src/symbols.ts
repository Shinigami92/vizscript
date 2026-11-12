import type {
  DataType,
  ScriptSymbol,
  SourceRange,
  SymbolParam,
  TypeRef,
} from '@vizscript/core';
import { symbolId } from '@vizscript/core';
import type {
  Block,
  ClassDef,
  Expr,
  FunctionDef,
  Param,
  Span,
  Stmt,
} from './ast';
import { dataTypeOf } from './lower';

const ENUM_BASES = /^(?:enum\.)?(?:Enum|IntEnum|StrEnum|Flag|IntFlag)$/;

type AssignStmt = Extract<Stmt, { type: 'Assign' }>;

/** What declares a name: its whole statement, value and annotation. */
interface Declaration {
  range: SourceRange;
  value?: Expr;
  annotation?: Span;
}

function inferType(expr: Expr | undefined): DataType {
  switch (expr?.type) {
    case 'Literal': {
      if (expr.kind === 'string' || expr.kind === 'bytes') {
        return 'string';
      }

      if (expr.kind === 'int' || expr.kind === 'float') {
        return 'number';
      }

      return expr.kind === 'bool' ? 'bool' : 'null';
    }

    case 'FString': {
      return 'string';
    }

    case 'Collection': {
      return 'array';
    }

    case 'Dict': {
      return 'object';
    }

    case 'Lambda': {
      return 'function';
    }

    case 'Call': {
      return expr.callee.type === 'Name' && /^[A-Z]/.test(expr.callee.name)
        ? expr.callee.name
        : 'any';
    }

    default: {
      return 'any';
    }
  }
}

function spanRange(span: Span): SourceRange {
  return { start: span.start, end: span.end };
}

class SymbolCollector {
  readonly symbols: ScriptSymbol[] = [];

  constructor(private readonly text: string) {}

  private slice(span: Span): string {
    return this.text.slice(span.start, span.end);
  }

  private typeRef(span: Span | undefined): TypeRef | undefined {
    return span
      ? { text: this.slice(span), range: spanRange(span) }
      : undefined;
  }

  /** Range of `name` after a keyword (`def name`, `class name`). */
  private nameAfter(keyword: string, name: string, from: Span): SourceRange {
    const match = this.slice(from).match(
      new RegExp(String.raw`\b${keyword}\s+${name}\b`)
    );
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

  /** Declared or inferred type of a declaration. */
  private typed(decl: Declaration): {
    type?: TypeRef;
    dataType: DataType;
    defaultRange?: SourceRange;
  } {
    const type = this.typeRef(decl.annotation);
    return {
      ...(type ? { type } : {}),
      dataType: type ? dataTypeOf(type.text) : inferType(decl.value),
      ...(decl.value ? { defaultRange: spanRange(decl.value) } : {}),
    };
  }

  private param(param: Param): SymbolParam {
    const stars = param.name.match(/^\*+/)?.[0] ?? '';
    const name = param.name.slice(stars.length);
    const start = param.start + stars.length;
    return {
      name,
      nameRange: { start, end: start + name.length },
      ...this.typed({
        range: spanRange(param),
        ...(param.defaultValue ? { value: param.defaultValue } : {}),
        ...(param.annotation ? { annotation: param.annotation } : {}),
      }),
      ...(stars ? { rest: true } : {}),
    };
  }

  private decorators(def: FunctionDef | ClassDef): string[] {
    return def.decorators.map((d) => this.slice(d).replaceAll(/\s+/g, ' '));
  }

  private fn(def: FunctionDef, scope: string, owner?: string): void {
    const decorators = this.decorators(def);
    const isStatic = decorators.includes('@staticmethod');
    // `self` / `cls` are implicit inputs, like UE's "Target" pin.
    const implicit = owner !== undefined && !isStatic;
    const params = def.params.slice(implicit ? 1 : 0).map((p) => this.param(p));
    const returns = this.typeRef(def.returns);
    this.add({
      kind: owner === undefined ? 'function' : 'method',
      name: def.name,
      scope,
      range: { start: def.decorators[0]?.start ?? def.start, end: def.end },
      nameRange: this.nameAfter('def', def.name, def),
      dataType: 'function',
      modifiers: [...(def.isAsync ? ['async'] : []), ...decorators],
      params,
      ...(returns ? { returns, returnType: dataTypeOf(returns.text) } : {}),
      graphStart: def.start,
    });

    const qualified = scope ? `${scope}.${def.name}` : def.name;
    const known = new Set(def.params.map((p) => p.name.replace(/^\*+/, '')));
    const self = implicit ? def.params[0]?.name : undefined;
    this.locals(def.body, qualified, known, owner, self);
  }

  /** Assignments inside a function body (and `self.x` for classes). */
  private locals(
    block: Block,
    scope: string,
    known: Set<string>,
    owner: string | undefined,
    self: string | undefined
  ): void {
    const declare = (target: Expr, decl: Declaration): void => {
      if (target.type === 'Name') {
        if (!known.has(target.name)) {
          known.add(target.name);
          this.add({
            kind: 'local',
            name: target.name,
            scope,
            range: decl.range,
            nameRange: spanRange(target),
            ...this.typed(decl),
          });
        }
      } else if (
        owner !== undefined &&
        self !== undefined &&
        target.type === 'Attribute' &&
        target.object.type === 'Name' &&
        target.object.name === self
      ) {
        // `self.x = …` declares an instance variable of the class.
        this.add({
          kind: 'variable',
          name: target.name,
          scope: owner,
          range: decl.range,
          nameRange: {
            start: target.end - target.name.length,
            end: target.end,
          },
          ...this.typed(decl),
          modifiers: [`${self}.`],
        });
      } else if (target.type === 'Collection' || target.type === 'Paren') {
        const items = target.type === 'Paren' ? [target.expr] : target.items;
        for (const item of items) {
          declare(item, { range: decl.range });
        }
      }
    };

    const visit = (stmts: ReadonlyArray<Stmt>): void => {
      for (const stmt of stmts) {
        switch (stmt.type) {
          case 'Assign': {
            for (const target of stmt.targets) {
              declare(target, {
                range: spanRange(stmt),
                ...(stmt.targets.length === 1 && stmt.value
                  ? { value: stmt.value }
                  : {}),
                ...(stmt.annotation ? { annotation: stmt.annotation } : {}),
              });
            }

            break;
          }

          case 'For': {
            declare(stmt.target, { range: spanRange(stmt) });
            visit(stmt.body.body);
            visit(stmt.orelse?.body ?? []);
            break;
          }

          case 'While': {
            visit(stmt.body.body);
            visit(stmt.orelse?.body ?? []);
            break;
          }

          case 'If': {
            visit(stmt.body.body);
            for (const elif of stmt.elifs) {
              visit(elif.body.body);
            }

            visit(stmt.orelse?.body ?? []);
            break;
          }

          case 'With': {
            for (const item of stmt.items) {
              if (item.target) {
                declare(item.target, { range: spanRange(stmt) });
              }
            }

            visit(stmt.body.body);
            break;
          }

          case 'Try': {
            visit(stmt.body.body);
            for (const handler of stmt.handlers) {
              visit(handler.body.body);
            }

            visit(stmt.orelse?.body ?? []);
            visit(stmt.finalbody?.body ?? []);
            break;
          }

          case 'Match': {
            for (const branch of stmt.cases) {
              visit(branch.body.body);
            }

            break;
          }

          default: {
            break;
          }
        }
      }
    };

    visit(block.body);
  }

  private classDef(def: ClassDef, scope: string): void {
    const bases = def.bases.map((b) => this.slice(b));
    const qualified = scope ? `${scope}.${def.name}` : def.name;
    this.add({
      kind: bases.some((b) => ENUM_BASES.test(b)) ? 'enum' : 'class',
      name: def.name,
      scope,
      range: { start: def.decorators[0]?.start ?? def.start, end: def.end },
      nameRange: this.nameAfter('class', def.name, def),
      dataType: def.name,
      modifiers: this.decorators(def),
      ...(bases.length > 0 ? { extends: bases.join(', ') } : {}),
      graphStart: def.start,
    });

    for (const stmt of def.body.body) {
      if (stmt.type === 'FunctionDef') {
        this.fn(stmt, qualified, qualified);
      } else if (stmt.type === 'ClassDef') {
        this.classDef(stmt, qualified);
      } else if (stmt.type === 'Assign') {
        this.assign(stmt, qualified);
      }
    }
  }

  /** Module or class level `name = value` / `name: type = value`. */
  private assign(stmt: AssignStmt, scope: string): void {
    for (const target of stmt.targets) {
      if (target.type !== 'Name') {
        continue;
      }

      const typed = this.typed({
        range: spanRange(stmt),
        ...(stmt.value ? { value: stmt.value } : {}),
        ...(stmt.annotation ? { annotation: stmt.annotation } : {}),
      });
      const constant =
        /^[A-Z][A-Z0-9_]*$/.test(target.name) ||
        /^(?:typing\.)?Final\b/.test(typed.type?.text ?? '');
      this.add({
        kind: constant ? 'constant' : 'variable',
        name: target.name,
        scope,
        range: spanRange(stmt),
        nameRange: spanRange(target),
        ...typed,
      });
    }
  }

  module(body: ReadonlyArray<Stmt>): void {
    for (const stmt of body) {
      if (stmt.type === 'FunctionDef') {
        this.fn(stmt, '');
      } else if (stmt.type === 'ClassDef') {
        this.classDef(stmt, '');
      } else if (stmt.type === 'Assign') {
        this.assign(stmt, '');
      }
    }
  }
}

/** Declarations of a Python module. */
export function pythonSymbols(
  body: ReadonlyArray<Stmt>,
  text: string
): ScriptSymbol[] {
  const collector = new SymbolCollector(text);
  collector.module(body);
  return collector.symbols;
}
