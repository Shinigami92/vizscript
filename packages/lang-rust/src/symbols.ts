import type {
  DataType,
  ScriptSymbol,
  SourceRange,
  SymbolField,
  SymbolParam,
  TypeRef,
} from '@vizscript/core';
import { symbolId } from '@vizscript/core';
import type {
  Block,
  Expr,
  FunctionItem,
  Item,
  Param,
  Pattern,
  Span,
  Stmt,
} from './ast';
import { dataTypeOf } from './lower';

function spanRange(span: Span): SourceRange {
  return { start: span.start, end: span.end };
}

/** Type of a value without a declared type. */
function inferType(expr: Expr | undefined): DataType {
  switch (expr?.type) {
    case 'Literal': {
      switch (expr.kind) {
        case 'int':
        case 'float': {
          return 'number';
        }

        case 'bool': {
          return 'bool';
        }

        case 'unit': {
          return 'void';
        }

        default: {
          return 'string';
        }
      }
    }

    case 'Macro': {
      const name = expr.name.split('::').at(-1);
      return name === 'format' ? 'string' : name === 'vec' ? 'array' : 'any';
    }

    case 'Array': {
      return 'array';
    }

    case 'Closure': {
      return 'function';
    }

    case 'Struct': {
      return expr.name.split('::').at(-1) ?? 'any';
    }

    case 'Call': {
      // `Point::new(…)`, `String::from(…)`
      const callee = expr.callee.type === 'Name' ? expr.callee.name : '';
      const owner = callee.split('::').at(-2);
      if (owner === 'String') {
        return 'string';
      }

      return owner && /^[A-Z]/.test(owner) && owner !== 'Self' ? owner : 'any';
    }

    default: {
      return 'any';
    }
  }
}

class SymbolCollector {
  public readonly symbols: ScriptSymbol[] = [];

  public constructor(private readonly text: string) {}

  private slice(span: Span): string {
    return this.text.slice(span.start, span.end);
  }

  private typeRef(span: Span | undefined): TypeRef | undefined {
    return span
      ? { text: this.slice(span), range: spanRange(span) }
      : undefined;
  }

  private add(
    symbol: Omit<ScriptSymbol, 'id' | 'modifiers'> & { modifiers?: string[] }
  ): void {
    const id = symbolId(symbol.kind, symbol.scope, symbol.name);
    if (!this.symbols.some((s) => s.id === id)) {
      this.symbols.push({ ...symbol, id, modifiers: symbol.modifiers ?? [] });
    }
  }

  private param(param: Param, owner?: string): SymbolParam {
    const type = this.typeRef(param.type);
    return {
      name: param.name ?? this.slice(param.pattern),
      nameRange: spanRange(param.pattern),
      ...(type ? { type } : {}),
      dataType: type ? dataTypeOf(type.text, owner) : 'any',
    };
  }

  private fn(fn: FunctionItem, scope: string, owner?: string): void {
    const returns = this.typeRef(fn.returns);
    this.add({
      kind: owner === undefined ? 'function' : 'method',
      name: fn.name,
      scope,
      range: spanRange(fn),
      nameRange: spanRange(fn.nameSpan),
      dataType: 'function',
      modifiers: fn.modifiers,
      params: fn.params.map((p) => this.param(p, owner)),
      ...(returns
        ? { returns, returnType: dataTypeOf(returns.text, owner) }
        : {}),
      graphStart: fn.start,
    });

    if (fn.body) {
      const qualified = scope ? `${scope}.${fn.name}` : fn.name;
      const known = new Set(fn.params.flatMap((p) => (p.name ? [p.name] : [])));
      this.locals(fn.body, qualified, known, owner);
    }
  }

  private declare(
    pattern: Pattern,
    scope: string,
    known: Set<string>,
    decl: {
      range: SourceRange;
      type?: Span;
      value?: Expr;
      modifiers?: string[];
    },
    owner: string | undefined
  ): void {
    for (const binding of pattern.bindings) {
      if (known.has(binding.name) || binding.name === '_') {
        continue;
      }

      known.add(binding.name);
      const simple = pattern.simple === binding.name;
      const type = simple ? this.typeRef(decl.type) : undefined;
      this.add({
        kind: 'local',
        name: binding.name,
        scope,
        range: decl.range,
        nameRange: spanRange(binding),
        ...(type ? { type } : {}),
        dataType: type
          ? dataTypeOf(type.text, owner)
          : simple
            ? inferType(decl.value)
            : 'any',
        ...(simple && decl.value
          ? { defaultRange: spanRange(decl.value) }
          : {}),
        modifiers: decl.modifiers ?? [],
      });
    }
  }

  /** `let` bindings and loop variables inside a function body. */
  private locals(
    block: Block,
    scope: string,
    known: Set<string>,
    owner: string | undefined
  ): void {
    const visitExpr = (expr: Expr | undefined): void => {
      if (expr?.type === 'If') {
        visit([expr.stmt]);
      } else if (expr?.type === 'Match') {
        visit([expr.stmt]);
      } else if (expr?.type === 'Block') {
        visit(expr.block.body);
      }
    };

    const visit = (stmts: ReadonlyArray<Stmt>): void => {
      for (const stmt of stmts) {
        switch (stmt.type) {
          case 'Let': {
            this.declare(
              stmt.pattern,
              scope,
              known,
              {
                range: spanRange(stmt),
                ...(stmt.valueType ? { type: stmt.valueType } : {}),
                ...(stmt.value ? { value: stmt.value } : {}),
                modifiers: stmt.mutable ? ['let', 'mut'] : ['let'],
              },
              owner
            );
            visitExpr(stmt.value);
            if (stmt.orelse) {
              visit(stmt.orelse.body);
            }

            break;
          }

          case 'For': {
            this.declare(
              stmt.pattern,
              scope,
              known,
              { range: spanRange(stmt) },
              owner
            );
            visit(stmt.body.body);
            break;
          }

          case 'While':
          case 'Loop': {
            visit(stmt.body.body);
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

          case 'Match': {
            for (const arm of stmt.arms) {
              if ('body' in arm.body && !('type' in arm.body)) {
                visit(arm.body.body);
              }
            }

            break;
          }

          case 'BlockStmt': {
            visit(stmt.block.body);
            break;
          }

          case 'Expr': {
            visitExpr(stmt.value);
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

  public items(items: ReadonlyArray<Item>, scope: string): void {
    for (const item of items) {
      switch (item.type) {
        case 'Function': {
          this.fn(item, scope);
          break;
        }

        case 'Struct': {
          const qualified = scope ? `${scope}.${item.name}` : item.name;
          const fields: SymbolField[] = item.fields.map((f) => {
            const type = this.typeRef(f.type);
            return {
              name: f.name,
              ...(type ? { type } : {}),
              dataType: dataTypeOf(type?.text, item.name),
            };
          });
          this.add({
            kind: 'class',
            name: item.name,
            scope,
            range: spanRange(item),
            nameRange: spanRange(item.nameSpan),
            dataType: item.name,
            modifiers: item.modifiers,
            ...(fields.length > 0 ? { fields } : {}),
          });
          for (const field of item.fields) {
            const type = this.typeRef(field.type);
            this.add({
              kind: 'variable',
              name: field.name,
              scope: qualified,
              range: spanRange(field),
              nameRange: spanRange(field.nameSpan),
              ...(type ? { type } : {}),
              dataType: dataTypeOf(type?.text, item.name),
              modifiers: field.modifiers,
            });
          }

          break;
        }

        case 'Enum': {
          this.add({
            kind: 'enum',
            name: item.name,
            scope,
            range: spanRange(item),
            nameRange: spanRange(item.nameSpan),
            dataType: item.name,
            modifiers: item.modifiers,
            members: item.variants,
          });
          break;
        }

        case 'Trait': {
          const fields: SymbolField[] = item.items.flatMap((member) =>
            member.type === 'Function'
              ? [{ name: member.name, dataType: 'function', method: true }]
              : []
          );
          this.add({
            kind: 'type',
            name: item.name,
            scope,
            range: spanRange(item),
            nameRange: spanRange(item.nameSpan),
            dataType: item.name,
            modifiers: [...item.modifiers, 'trait'],
            ...(fields.length > 0 ? { fields } : {}),
          });
          break;
        }

        case 'TypeAlias': {
          const value = this.typeRef(item.value);
          this.add({
            kind: 'type',
            name: item.name,
            scope,
            range: spanRange(item),
            nameRange: spanRange(item.nameSpan),
            ...(value ? { type: value } : {}),
            dataType: value ? dataTypeOf(value.text) : item.name,
            modifiers: item.modifiers,
          });
          break;
        }

        case 'Impl': {
          const owner = item.target;
          for (const member of item.items) {
            if (member.type === 'Function') {
              this.fn(member, scope ? `${scope}.${owner}` : owner, owner);
            }
          }

          break;
        }

        case 'Const':
        case 'Static': {
          const type = this.typeRef(item.valueType);
          const keyword = item.type === 'Const' ? 'const' : 'static';
          this.add({
            kind: item.type === 'Const' ? 'constant' : 'variable',
            name: item.name,
            scope,
            range: spanRange(item),
            nameRange: spanRange(item.nameSpan),
            ...(type ? { type } : {}),
            dataType: type ? dataTypeOf(type.text) : inferType(item.value),
            ...(item.value ? { defaultRange: spanRange(item.value) } : {}),
            modifiers: [
              ...item.modifiers,
              keyword,
              ...(item.mutable ? ['mut'] : []),
            ],
          });
          break;
        }

        case 'Mod': {
          if (item.items) {
            this.items(item.items, scope ? `${scope}.${item.name}` : item.name);
          }

          break;
        }

        default: {
          break;
        }
      }
    }
  }
}

/** Declarations of a Rust file. */
export function rustSymbols(
  items: ReadonlyArray<Item>,
  text: string
): ScriptSymbol[] {
  const collector = new SymbolCollector(text);
  collector.items(items, '');
  return collector.symbols;
}
