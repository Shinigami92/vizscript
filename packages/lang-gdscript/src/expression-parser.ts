import type { Expr, FuncDecl } from './ast';
import type { Token } from './lexer';
import { ParserBase } from './parser-base';
import { stringLiteral } from './string-literal';

/** Operator precedences (higher binds tighter), as in Godot's parser. */
const PRECEDENCE = {
  cast: 1,
  ternary: 2,
  or: 3,
  and: 4,
  not: 5,
  in: 6,
  comparison: 7,
  bitOr: 8,
  bitXor: 9,
  bitAnd: 10,
  shift: 11,
  additive: 12,
  multiplicative: 13,
  unary: 14,
  power: 15,
  is: 16,
  await: 17,
} as const;

const BINARY_PRECEDENCE = new Map<string, number>([
  ['||', PRECEDENCE.or],
  ['&&', PRECEDENCE.and],
  ['==', PRECEDENCE.comparison],
  ['!=', PRECEDENCE.comparison],
  ['<', PRECEDENCE.comparison],
  ['>', PRECEDENCE.comparison],
  ['<=', PRECEDENCE.comparison],
  ['>=', PRECEDENCE.comparison],
  ['|', PRECEDENCE.bitOr],
  ['^', PRECEDENCE.bitXor],
  ['&', PRECEDENCE.bitAnd],
  ['<<', PRECEDENCE.shift],
  ['>>', PRECEDENCE.shift],
  ['+', PRECEDENCE.additive],
  ['-', PRECEDENCE.additive],
  ['*', PRECEDENCE.multiplicative],
  ['/', PRECEDENCE.multiplicative],
  ['%', PRECEDENCE.multiplicative],
  ['**', PRECEDENCE.power],
]);

/** Expressions, with Godot's operator precedences. */
export abstract class ExpressionParser extends ParserBase {
  protected abstract parseFunc(indent: number, isStatic: boolean): FuncDecl;

  // ------------------------------------------------------- expressions

  /**
   * Pratt parser following Godot's precedences: after `x as T` (or any
   * operator) parsing continues with the operators that follow, so
   * `x as int + 1` is `(x as int) + 1` like in Godot.
   */
  public parseExpression(minPrecedence = 0): Expr {
    let left = this.parsePrefix();
    for (;;) {
      if (this.atBreak()) {
        return left;
      }

      const op = this.infixOperator();
      if (!op || op.precedence <= minPrecedence) {
        return left;
      }

      for (let i = 0; i < op.tokens; i++) {
        this.next();
      }

      switch (op.kind) {
        case 'as': {
          const target = this.parseType();
          left = {
            type: 'Cast',
            expr: left,
            target,
            start: left.start,
            end: this.lastEnd,
          };
          break;
        }

        case 'is': {
          const target = this.parseType();
          left = {
            type: 'Is',
            expr: left,
            target,
            negated: op.op === 'is not',
            start: left.start,
            end: this.lastEnd,
          };
          break;
        }

        case 'ternary': {
          const test = this.parseExpression(PRECEDENCE.ternary);
          if (!this.isName('else')) {
            this.fail('Expected "else"');
          }

          this.next();
          const alternate = this.parseExpression(PRECEDENCE.ternary - 1);
          left = {
            type: 'Ternary',
            test,
            consequent: left,
            alternate,
            start: left.start,
            end: alternate.end,
          };
          break;
        }

        case 'binary': {
          const right = this.parseExpression(
            op.op === '**' ? op.precedence - 1 : op.precedence
          );
          left = {
            type: 'Binary',
            op: op.op,
            left,
            right,
            start: left.start,
            end: right.end,
          };
          break;
        }
      }
    }
  }

  protected infixOperator():
    | {
        kind: 'as' | 'is' | 'ternary' | 'binary';
        op: string;
        precedence: number;
        tokens: number;
      }
    | undefined {
    const token = this.peek();
    if (token.type === 'name') {
      switch (token.value) {
        case 'as': {
          return {
            kind: 'as',
            op: 'as',
            precedence: PRECEDENCE.cast,
            tokens: 1,
          };
        }

        case 'if': {
          return {
            kind: 'ternary',
            op: 'if',
            precedence: PRECEDENCE.ternary,
            tokens: 1,
          };
        }

        case 'is': {
          const negated = this.isName('not', 1);
          return {
            kind: 'is',
            op: negated ? 'is not' : 'is',
            precedence: PRECEDENCE.is,
            tokens: negated ? 2 : 1,
          };
        }

        case 'or':
        case 'and':
        case 'in': {
          return {
            kind: 'binary',
            op: token.value,
            precedence: PRECEDENCE[token.value],
            tokens: 1,
          };
        }

        case 'not': {
          return this.isName('in', 1)
            ? {
                kind: 'binary',
                op: 'not in',
                precedence: PRECEDENCE.in,
                tokens: 2,
              }
            : undefined;
        }

        default: {
          return undefined;
        }
      }
    }

    if (token.type !== 'op') {
      return undefined;
    }

    const precedence = BINARY_PRECEDENCE.get(token.value);
    return precedence === undefined
      ? undefined
      : { kind: 'binary', op: token.value, precedence, tokens: 1 };
  }

  protected parsePrefix(): Expr {
    const token = this.peek();
    if (this.isName('not') || this.isOp('!')) {
      this.next();
      const argument = this.parseExpression(PRECEDENCE.not);
      return {
        type: 'Unary',
        op: token.value,
        argument,
        start: token.start,
        end: argument.end,
      };
    }

    if (this.isOp('-') || this.isOp('+') || this.isOp('~')) {
      this.next();
      const argument = this.parseExpression(PRECEDENCE.unary);
      return {
        type: 'Unary',
        op: token.value,
        argument,
        start: token.start,
        end: argument.end,
      };
    }

    if (this.isName('await')) {
      this.next();
      const argument = this.parseExpression(PRECEDENCE.await);
      return { type: 'Await', argument, start: token.start, end: argument.end };
    }

    return this.parsePostfix();
  }

  protected parsePostfix(): Expr {
    let expr = this.parsePrimary();
    for (;;) {
      if (this.atBreak()) {
        return expr;
      }

      if (this.isOp('.')) {
        this.next();
        const name = this.peek();
        if (name.type !== 'name') {
          this.fail('Expected a property name');
        }

        this.next();
        expr = {
          type: 'Attribute',
          object: expr,
          name: name.value,
          nameSpan: { start: name.start, end: name.end },
          start: expr.start,
          end: name.end,
        };
      } else if (this.isOp('(')) {
        this.next();
        const args = this.bracketed(() => this.parseList(')'));
        this.expectClose(')');
        expr = {
          type: 'Call',
          callee: expr,
          args,
          start: expr.start,
          end: this.lastEnd,
        };
      } else if (this.isOp('[')) {
        this.next();
        const index = this.bracketed(() => this.parseExpression());
        this.expectClose(']');
        expr = {
          type: 'Subscript',
          object: expr,
          index,
          start: expr.start,
          end: this.lastEnd,
        };
      } else {
        return expr;
      }
    }
  }

  protected expectClose(value: string): void {
    if (!this.isOp(value)) {
      this.fail(`Expected "${value}"`);
    }

    this.next();
  }

  /** Comma separated expressions up to (not including) `close`. */
  protected parseList(close: string): Expr[] {
    const items: Expr[] = [];
    while (!this.isOp(close) && this.peek().type !== 'eof') {
      items.push(this.parseExpression());
      if (!this.isOp(',')) {
        break;
      }

      this.next();
    }

    return items;
  }

  protected parsePrimary(): Expr {
    const token = this.peek();
    switch (token.type) {
      case 'number': {
        this.next();
        const isFloat =
          !/^0[xXbB]/.test(token.value) && /[.eE]/.test(token.value);
        return {
          type: 'Literal',
          kind: isFloat ? 'float' : 'int',
          value: token.value,
          start: token.start,
          end: token.end,
        };
      }

      case 'string': {
        this.next();
        const { kind, value } = stringLiteral(token.value);
        return {
          type: 'Literal',
          kind,
          value,
          start: token.start,
          end: token.end,
        };
      }

      case 'nodePath': {
        this.next();
        const raw = token.value.slice(1);
        const path =
          raw.startsWith('"') || raw.startsWith("'")
            ? stringLiteral(raw).value
            : raw;
        return {
          type: 'NodePath',
          path,
          unique: path.startsWith('%'),
          start: token.start,
          end: token.end,
        };
      }

      case 'name': {
        return this.parseNamePrimary(token);
      }

      case 'op': {
        return this.parseOpPrimary(token);
      }

      default: {
        this.fail(
          token.type === 'eof' ? 'Unexpected end of file' : 'Expected a value'
        );
      }
    }
  }

  protected parseNamePrimary(token: Token): Expr {
    switch (token.value) {
      case 'true':
      case 'false': {
        this.next();
        return {
          type: 'Literal',
          kind: 'bool',
          value: token.value,
          start: token.start,
          end: token.end,
        };
      }

      case 'null': {
        this.next();
        return {
          type: 'Literal',
          kind: 'null',
          value: 'null',
          start: token.start,
          end: token.end,
        };
      }

      case 'self': {
        this.next();
        return { type: 'Self', start: token.start, end: token.end };
      }

      case 'super': {
        this.next();
        return { type: 'Super', start: token.start, end: token.end };
      }

      case 'func': {
        this.lambdas++;
        try {
          const fn = this.parseFunc(token.indent, false);
          return { type: 'Lambda', fn, start: fn.start, end: fn.end };
        } finally {
          this.lambdas--;
        }
      }

      default: {
        this.next();
        return {
          type: 'Identifier',
          name: token.value,
          start: token.start,
          end: token.end,
        };
      }
    }
  }

  protected parseOpPrimary(token: Token): Expr {
    switch (token.value) {
      case '(': {
        this.next();
        const expr = this.bracketed(() => this.parseExpression());
        this.expectClose(')');
        return { type: 'Paren', expr, start: token.start, end: this.lastEnd };
      }

      case '[': {
        this.next();
        const elements = this.bracketed(() => this.parseList(']'));
        this.expectClose(']');
        return {
          type: 'Array',
          elements,
          start: token.start,
          end: this.lastEnd,
        };
      }

      case '{': {
        this.next();
        const entries = this.bracketed(() => {
          const list: Array<{ key: Expr; value: Expr; luaStyle: boolean }> = [];
          while (!this.isOp('}') && this.peek().type !== 'eof') {
            const key = this.parseExpression();
            let luaStyle = false;
            if (this.isOp('=')) {
              luaStyle = true;
              this.next();
            } else {
              this.expectClose(':');
            }

            list.push({ key, value: this.parseExpression(), luaStyle });
            if (!this.isOp(',')) {
              break;
            }

            this.next();
          }

          return list;
        });
        this.expectClose('}');
        return {
          type: 'Dictionary',
          entries,
          start: token.start,
          end: this.lastEnd,
        };
      }

      case '%': {
        // `%UniqueNode` (scene unique name).
        const name = this.peek(1);
        if (name.type === 'name' && name.start === token.end) {
          this.next();
          this.next();
          return {
            type: 'NodePath',
            path: `%${name.value}`,
            unique: true,
            start: token.start,
            end: name.end,
          };
        }

        break;
      }

      default: {
        break;
      }
    }

    this.fail(`Unexpected "${token.value}"`);
  }
}
