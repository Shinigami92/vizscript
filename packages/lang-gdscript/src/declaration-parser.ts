import type {
  Annotation,
  Block,
  Expr,
  FuncDecl,
  Param,
  TypeRef,
  VarDecl,
} from './ast';
import { ExpressionParser } from './expression-parser';

/** Annotations, variables (with accessors), parameters and functions. */
export abstract class DeclarationParser extends ExpressionParser {
  protected abstract parseBlock(headerIndent: number): Block;

  // ------------------------------------------------------- declarations

  protected parseAnnotation(): Annotation {
    const token = this.next();
    const args: Expr[] = [];
    if (this.isOp('(') && !this.peek().lineStart) {
      this.next();
      this.bracketed(() => {
        while (!this.isOp(')')) {
          args.push(this.parseExpression());
          if (!this.isOp(',')) {
            break;
          }

          this.next();
        }
      });
      this.expectOp(')');
    }

    return {
      name: token.value.slice(1),
      args,
      start: token.start,
      end: this.lastEnd,
    };
  }

  protected parseVar(isStatic: boolean): VarDecl {
    const keyword = this.next();
    const indent = keyword.indent;
    const name = this.expectName();
    const decl: VarDecl = {
      type: 'Var',
      kind: keyword.value === 'const' ? 'const' : 'var',
      name: name.value,
      nameSpan: { start: name.start, end: name.end },
      inferred: false,
      isStatic,
      annotations: [],
      start: keyword.start,
      end: name.end,
    };

    if (this.isOp(':') && !this.atBreak() && !this.peek(1).lineStart) {
      this.next();
      decl.typeRef = this.parseType();
    }

    if (this.isOp(':=') && !this.atBreak()) {
      this.next();
      decl.inferred = true;
      decl.value = this.parseExpression();
    } else if (this.isOp('=') && !this.atBreak()) {
      this.next();
      decl.value = this.parseExpression();
    }

    decl.end = this.lastEnd;
    if (this.isOp(':') && !this.atBreak()) {
      this.parseAccessors(decl, indent);
      decl.end = this.lastEnd;
      return decl;
    }

    this.endStatement();
    return decl;
  }

  /** `set(value): ...` / `get: ...` blocks or `set = fn, get = fn`. */
  protected parseAccessors(decl: VarDecl, indent: number): void {
    this.next(); // ':'
    const first = this.peek();
    if (!first.lineStart) {
      // Inline `set = _set_x, get = _get_x`.
      while (!this.atBreak()) {
        this.next();
      }

      return;
    }

    if (first.indent <= indent) {
      this.fail('Expected property accessors');
    }

    const accessorIndent = first.indent;
    while (
      this.peek().type !== 'eof' &&
      this.peek().lineStart &&
      this.peek().indent === accessorIndent
    ) {
      const token = this.peek();
      if (!this.isName('set') && !this.isName('get')) {
        break;
      }

      this.next();
      if (this.isOp('=')) {
        this.next();
        this.expectName();
        if (this.isOp(',')) {
          this.next();
        }

        continue;
      }

      const params =
        token.value === 'set' || this.isOp('(') ? this.parseParams() : [];
      const body = this.parseBlock(accessorIndent);
      const fn: FuncDecl = {
        type: 'Func',
        name: `${decl.name}.${token.value}`,
        params,
        body,
        isStatic: decl.isStatic,
        annotations: [],
        start: token.start,
        end: body.end,
      };
      if (token.value === 'set') {
        decl.setter = fn;
      } else {
        decl.getter = fn;
      }
    }
  }

  protected parseParams(): Param[] {
    this.expectOp('(');
    const params: Param[] = this.bracketed(() => {
      const list: Param[] = [];
      while (!this.isOp(')') && this.peek().type !== 'eof') {
        const name = this.expectName();
        const param: Param = {
          name: name.value,
          inferred: false,
          start: name.start,
          end: name.end,
        };
        if (this.isOp(':')) {
          this.next();
          param.type = this.parseType();
        }

        if (this.isOp(':=')) {
          this.next();
          param.inferred = true;
          param.defaultValue = this.parseExpression();
        } else if (this.isOp('=')) {
          this.next();
          param.defaultValue = this.parseExpression();
        }

        param.end = this.lastEnd;
        list.push(param);
        if (!this.isOp(',')) {
          break;
        }

        this.next();
      }

      return list;
    });
    this.expectOp(')');
    return params;
  }

  protected parseFunc(indent: number, isStatic: boolean): FuncDecl {
    const keyword = this.next();
    const name = this.peek().type === 'name' ? this.next().value : null;
    const params = this.parseParams();
    let returnType: TypeRef | undefined;
    if (this.isOp('->')) {
      this.next();
      returnType = this.parseType();
    }

    // `@abstract func f() -> T` has no body.
    const body: Block =
      !this.isOp(':') && (this.atBreak() || this.isOp(';'))
        ? {
            body: [],
            inline: false,
            colonEnd: this.lastEnd,
            start: this.lastEnd,
            end: this.lastEnd,
          }
        : this.parseBlock(indent);
    return {
      type: 'Func',
      name,
      params,
      returnType,
      body,
      isStatic,
      annotations: [],
      start: keyword.start,
      end: body.end,
    };
  }
}
