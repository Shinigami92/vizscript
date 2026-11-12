import type {
  Annotation,
  Block,
  IfStmt,
  MatchBranch,
  Script,
  Span,
  Stmt,
  TypeRef,
} from './ast';
import { DeclarationParser } from './declaration-parser';
import { tokenize } from './lexer';
import type { ParseDiagnostic } from './parser-base';
import { ParseError } from './parser-base';
import { stringLiteral } from './string-literal';

const ASSIGNMENT_OPS = new Set([
  '=',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '**=',
  '<<=',
  '>>=',
  '&=',
  '|=',
  '^=',
]);

/** Parses the tokens of a GDScript file into its AST. */
class Parser extends DeclarationParser {
  // ------------------------------------------------------------ script

  public parseScript(): Script {
    const body = this.parseStatements(0, -1);
    const script: Script = { body };
    for (const stmt of body) {
      if (stmt.type === 'ClassName') {
        script.className = stmt.name;
      } else if (stmt.type === 'Extends') {
        script.extendsName = stmt.target;
      }
    }

    return script;
  }

  /** Statements of a block whose lines are indented by `indent`. */
  private parseStatements(indent: number, parentIndent: number): Stmt[] {
    const body: Stmt[] = [];
    for (;;) {
      const token = this.peek();
      if (token.type === 'eof' || token.indent <= parentIndent) {
        break;
      }

      if (!token.lineStart) {
        if (this.lambdas > 0) {
          break;
        }

        this.diagnostics.push({
          message: 'Unexpected code',
          start: token.start,
          end: token.end,
        });
        this.recover();
        continue;
      }

      if (token.indent > indent) {
        this.diagnostics.push({
          message: 'Unexpected indentation',
          start: token.start,
          end: token.end,
        });
      } else if (token.indent < indent) {
        break;
      }

      body.push(...this.parseLine());
    }

    return body;
  }

  /** One line: statements separated by `;`, with error recovery. */
  private parseLine(): Stmt[] {
    const result: Stmt[] = [];
    const start = this.peek();
    try {
      for (;;) {
        result.push(this.parseStatement());
        if (!this.isOp(';')) {
          break;
        }

        this.next();
        if (this.atBreak()) {
          break;
        }
      }
    } catch (error) {
      if (!(error instanceof ParseError)) {
        throw error;
      }

      this.diagnostics.push({
        message: error.message,
        start: error.start,
        end: error.end,
      });
      const from = this.pos;
      this.recover();
      // Make progress even if the error was at the last token.
      if (this.pos === from && this.peek().type !== 'eof') {
        this.next();
      }

      result.push({
        type: 'Error',
        message: error.message,
        start: start.start,
        end: Math.max(this.lastEnd, start.end),
      });
    }

    return result;
  }

  protected parseBlock(headerIndent: number): Block {
    const colon = this.expectOp(':');
    const first = this.peek();
    if (
      first.type === 'eof' ||
      (first.lineStart && first.indent <= headerIndent)
    ) {
      this.diagnostics.push({
        message: 'Expected an indented block',
        start: colon.start,
        end: colon.end,
      });
      return {
        body: [],
        inline: false,
        colonEnd: colon.end,
        start: colon.end,
        end: colon.end,
      };
    }

    if (!first.lineStart) {
      // `if x: return` — statements on the header line.
      const body: Stmt[] = [this.parseStatement()];
      while (this.isOp(';')) {
        this.next();
        if (this.atBreak() || this.endsLambdaBody()) {
          break;
        }

        body.push(this.parseStatement());
      }

      return {
        body,
        inline: true,
        colonEnd: colon.end,
        start: first.start,
        end: this.lastEnd,
      };
    }

    // Indented block; inside brackets (lambdas) newlines matter again.
    const saved = this.brackets;
    this.brackets = 0;
    try {
      const body = this.parseStatements(first.indent, headerIndent);
      return {
        body,
        inline: false,
        colonEnd: colon.end,
        start: first.start,
        end: body.at(-1)?.end ?? colon.end,
      };
    } finally {
      this.brackets = saved;
    }
  }

  // -------------------------------------------------------- statements

  private parseStatement(): Stmt {
    const token = this.peek();
    const indent = token.indent;

    if (token.type === 'annotation') {
      const annotations: Annotation[] = [];
      while (this.peek().type === 'annotation') {
        annotations.push(this.parseAnnotation());
      }

      const target = this.peek();
      const attaches =
        target.type === 'name' &&
        ['var', 'const', 'func', 'static', 'signal'].includes(target.value) &&
        (!target.lineStart || target.indent === indent);
      if (!attaches && !target.lineStart && target.type !== 'eof') {
        // `@abstract class_name X`: the statement follows on the same line.
        return this.parseStatement();
      }

      if (!attaches || annotations.length === 0) {
        const first = annotations[0] as Annotation;
        return {
          type: 'Annotation',
          annotation: first,
          start: first.start,
          end: first.end,
        };
      }

      const stmt = this.parseStatement();
      if (stmt.type === 'Var' || stmt.type === 'Func') {
        stmt.annotations.unshift(...annotations);
        stmt.start = token.start;
      }

      return stmt;
    }

    if (token.type === 'name') {
      switch (token.value) {
        case 'var':
        case 'const': {
          return this.parseVar(false);
        }

        case 'static': {
          this.next();
          if (this.isName('func')) {
            const fn = this.parseFunc(indent, true);
            fn.start = token.start;
            return fn;
          }

          const decl = this.parseVar(true);
          decl.start = token.start;
          return decl;
        }

        case 'func': {
          return this.parseFunc(indent, false);
        }

        case 'if': {
          return this.parseIf(indent);
        }

        case 'for': {
          this.next();
          const variable = this.expectName();
          let variableType: TypeRef | undefined;
          if (this.isOp(':')) {
            this.next();
            variableType = this.parseType();
          }

          if (!this.isName('in')) {
            this.fail('Expected "in"');
          }

          this.next();
          const iterable = this.parseExpression();
          const body = this.parseBlock(indent);
          return {
            type: 'For',
            variable: variable.value,
            variableSpan: { start: variable.start, end: variable.end },
            variableType,
            iterable,
            body,
            start: token.start,
            end: body.end,
          };
        }

        case 'while': {
          this.next();
          const test = this.parseExpression();
          const body = this.parseBlock(indent);
          return {
            type: 'While',
            test,
            body,
            start: token.start,
            end: body.end,
          };
        }

        case 'match': {
          return this.parseMatch(indent);
        }

        case 'return': {
          this.next();
          const value =
            this.atBreak() || this.isOp(';') || this.endsLambdaBody()
              ? undefined
              : this.parseExpression();
          this.endStatement();
          return {
            type: 'Return',
            value,
            start: token.start,
            end: this.lastEnd,
          };
        }

        case 'break':
        case 'continue':
        case 'pass':
        case 'breakpoint': {
          this.next();
          this.endStatement();
          const type =
            token.value === 'break'
              ? 'Break'
              : token.value === 'continue'
                ? 'Continue'
                : token.value === 'pass'
                  ? 'Pass'
                  : 'Breakpoint';
          return { type, start: token.start, end: token.end };
        }

        case 'signal': {
          this.next();
          const name = this.expectName();
          const params = this.isOp('(') ? this.parseParams() : [];
          this.endStatement();
          return {
            type: 'Signal',
            name: name.value,
            params,
            start: token.start,
            end: this.lastEnd,
          };
        }

        case 'enum': {
          this.next();
          const name = this.peek().type === 'name' ? this.next().value : null;
          this.expectOp('{');
          this.bracketed(() => {
            let depth = 1;
            while (depth > 0 && this.peek().type !== 'eof') {
              const t = this.next();
              if (t.type === 'op' && t.value === '{') {
                depth++;
              } else if (t.type === 'op' && t.value === '}') {
                depth--;
              }
            }
          });
          this.endStatement();
          return { type: 'Enum', name, start: token.start, end: this.lastEnd };
        }

        case 'extends': {
          this.next();
          const target = this.parseExtendsTarget();
          this.endStatement();
          return {
            type: 'Extends',
            target,
            start: token.start,
            end: this.lastEnd,
          };
        }

        case 'class_name': {
          this.next();
          const name = this.expectName();
          if (this.isName('extends') && !this.peek().lineStart) {
            // `class_name A extends B` on one line.
            this.next();
            this.parseExtendsTarget();
          }

          this.endStatement();
          return {
            type: 'ClassName',
            name: name.value,
            start: token.start,
            end: this.lastEnd,
          };
        }

        case 'class': {
          this.next();
          const name = this.expectName();
          let extendsName: string | undefined;
          if (this.isName('extends')) {
            this.next();
            extendsName = this.parseExtendsTarget();
          }

          const body = this.parseBlock(indent);
          return {
            type: 'Class',
            name: name.value,
            extends: extendsName,
            body,
            start: token.start,
            end: body.end,
          };
        }

        default: {
          break;
        }
      }
    }

    // Expression statement or assignment.
    const expr = this.parseExpression();
    const op = this.peek();
    if (op.type === 'op' && ASSIGNMENT_OPS.has(op.value) && !this.atBreak()) {
      this.next();
      const value = this.parseExpression();
      this.endStatement();
      return {
        type: 'Assign',
        target: expr,
        op: op.value,
        value,
        start: token.start,
        end: this.lastEnd,
      };
    }

    this.endStatement();
    return { type: 'Expr', expr, start: token.start, end: this.lastEnd };
  }

  private parseExtendsTarget(): string {
    const token = this.peek();
    if (token.type === 'string') {
      this.next();
      return stringLiteral(token.value).value;
    }

    const parts = [this.expectName().value];
    while (this.isOp('.') && !this.atBreak()) {
      this.next();
      parts.push(this.expectName().value);
    }

    return parts.join('.');
  }

  private parseIf(indent: number): IfStmt {
    const keyword = this.next();
    const test = this.parseExpression();
    const body = this.parseBlock(indent);
    const stmt: IfStmt = {
      type: 'If',
      test,
      body,
      elifs: [],
      start: keyword.start,
      end: body.end,
    };

    const continues = (word: string): boolean =>
      this.isName(word) &&
      this.peek().lineStart &&
      this.peek().indent === indent;
    while (continues('elif')) {
      const elif = this.next();
      const elifTest = this.parseExpression();
      const elifBody = this.parseBlock(indent);
      stmt.elifs.push({
        test: elifTest,
        body: elifBody,
        start: elif.start,
        end: elifBody.end,
      });
      stmt.end = elifBody.end;
    }

    if (continues('else')) {
      this.next();
      stmt.orelse = this.parseBlock(indent);
      stmt.end = stmt.orelse.end;
    }

    return stmt;
  }

  private parseMatch(indent: number): Stmt {
    const keyword = this.next();
    const subject = this.parseExpression();
    const colon = this.expectOp(':');
    const branches: MatchBranch[] = [];
    const first = this.peek();
    if (!first.lineStart || first.indent <= indent) {
      this.fail('Expected match branches');
    }

    const saved = this.brackets;
    this.brackets = 0;
    try {
      const branchIndent = first.indent;
      while (
        this.peek().type !== 'eof' &&
        this.peek().lineStart &&
        this.peek().indent === branchIndent
      ) {
        const start = this.peek().start;
        try {
          // Patterns (and an optional `when` guard) up to the `:`.
          let depth = 0;
          while (this.peek().type !== 'eof') {
            const t = this.peek();
            if (t.type === 'op' && depth === 0 && t.value === ':') {
              break;
            }

            if (t.type === 'op' && '([{'.includes(t.value)) {
              depth++;
            } else if (t.type === 'op' && ')]}'.includes(t.value)) {
              depth--;
            }

            this.next();
          }

          const patterns: Span = { start, end: this.lastEnd };
          const body = this.parseBlock(branchIndent);
          branches.push({ patterns, body, start, end: body.end });
        } catch (error) {
          if (!(error instanceof ParseError)) {
            throw error;
          }

          this.diagnostics.push({
            message: error.message,
            start: error.start,
            end: error.end,
          });
          this.recover();
        }
      }
    } finally {
      this.brackets = saved;
    }

    return {
      type: 'Match',
      subject,
      branches,
      start: keyword.start,
      end: branches.at(-1)?.end ?? colon.end,
    };
  }
}

export interface ParseResult {
  script: Script;
  diagnostics: ParseDiagnostic[];
  /** Ranges of all comments. */
  comments: Array<{ start: number; end: number }>;
}

export function parseGDScript(text: string): ParseResult {
  const { tokens, errors, comments } = tokenize(text);
  const parser = new Parser(tokens).withSource(text);
  const script = parser.parseScript();
  return {
    script,
    diagnostics: [...errors, ...parser.diagnostics],
    comments,
  };
}
