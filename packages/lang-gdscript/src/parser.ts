import type {
  Annotation,
  Block,
  Expr,
  FuncDecl,
  IfStmt,
  LiteralKind,
  MatchBranch,
  Param,
  Script,
  Span,
  Stmt,
  TypeRef,
  VarDecl,
} from './ast';
import type { Token } from './lexer';
import { tokenize } from './lexer';

export interface ParseDiagnostic {
  message: string;
  start: number;
  end: number;
}

class ParseError extends Error {
  public constructor(
    message: string,
    public readonly start: number,
    public readonly end: number
  ) {
    super(message);
  }
}

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

const CLOSERS = new Set([')', ']', '}', ',']);

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

function unescape(body: string): string {
  return body.replaceAll(/\\(u[0-9a-fA-F]{4}|.)/g, (_, c: string) => {
    switch (c[0]) {
      case 'n': {
        return '\n';
      }

      case 't': {
        return '\t';
      }

      case 'r': {
        return '\r';
      }

      case 'u': {
        return c.length === 5
          ? String.fromCodePoint(Number.parseInt(c.slice(1), 16))
          : c;
      }

      default: {
        return c;
      }
    }
  });
}

/** Kind and unquoted value of a string token like `&"name"` or `"""doc"""`. */
export function stringLiteral(raw: string): {
  kind: LiteralKind;
  value: string;
} {
  let prefix = '';
  let i = 0;
  while ('r&^'.includes(raw[i] ?? '')) {
    prefix += raw[i];
    i++;
  }

  const quote = raw[i] ?? '"';
  const delimiter = raw.startsWith(quote.repeat(3), i)
    ? quote.repeat(3)
    : quote;
  const end =
    raw.endsWith(delimiter) && raw.length - delimiter.length > i
      ? raw.length - delimiter.length
      : raw.length;
  const body = raw.slice(i + delimiter.length, end);
  return {
    kind: prefix.includes('&')
      ? 'stringName'
      : prefix.includes('^')
        ? 'nodePath'
        : 'string',
    value: prefix.includes('r') ? body : unescape(body),
  };
}

class Parser {
  private pos = 0;
  /** Open brackets: newlines inside them don't end statements. */
  private brackets = 0;
  /** Nesting of lambda bodies: their statements may end at `)` or `,`. */
  private lambdas = 0;
  private lastEnd = 0;
  public readonly diagnostics: ParseDiagnostic[] = [];

  public constructor(private readonly tokens: Token[]) {}

  // ------------------------------------------------------------ tokens

  private peek(offset = 0): Token {
    return (
      this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)] ??
      (this.tokens.at(-1) as Token)
    );
  }

  private next(): Token {
    const token = this.peek();
    if (token.type !== 'eof') {
      this.pos++;
      this.lastEnd = token.end;
    }

    return token;
  }

  private isOp(value: string, offset = 0): boolean {
    const token = this.peek(offset);
    return token.type === 'op' && token.value === value;
  }

  private isName(value: string, offset = 0): boolean {
    const token = this.peek(offset);
    return token.type === 'name' && token.value === value;
  }

  /** The next token starts a new statement (outside of brackets). */
  private atBreak(): boolean {
    const token = this.peek();
    return token.type === 'eof' || (token.lineStart && this.brackets === 0);
  }

  private fail(message: string, token = this.peek()): never {
    throw new ParseError(
      message,
      token.start,
      Math.max(token.end, token.start + 1)
    );
  }

  private expectOp(value: string): Token {
    if (!this.isOp(value)) {
      this.fail(`Expected "${value}"`);
    }

    return this.next();
  }

  private expectName(): Token {
    if (this.peek().type !== 'name') {
      this.fail('Expected a name');
    }

    return this.next();
  }

  private bracketed<T>(fn: () => T): T {
    this.brackets++;
    try {
      return fn();
    } finally {
      this.brackets--;
    }
  }

  private endStatement(): void {
    if (this.isOp(';') || this.atBreak()) {
      return;
    }

    const token = this.peek();
    if (this.lambdas > 0 && token.type === 'op' && CLOSERS.has(token.value)) {
      return;
    }

    this.fail('Expected the end of the statement');
  }

  /** Skips to the start of the next line after an error. */
  private recover(): void {
    while (this.peek().type !== 'eof') {
      this.next();
      if (this.peek().lineStart) {
        return;
      }
    }
  }

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

  private parseBlock(headerIndent: number): Block {
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

  private endsLambdaBody(): boolean {
    const token = this.peek();
    return this.lambdas > 0 && token.type === 'op' && CLOSERS.has(token.value);
  }

  // -------------------------------------------------------- statements

  private parseAnnotation(): Annotation {
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

  private parseType(): TypeRef {
    const first = this.expectName();
    while (this.isOp('.') && !this.atBreak()) {
      this.next();
      this.expectName();
    }

    if (this.isOp('[') && !this.atBreak()) {
      this.next();
      this.bracketed(() => {
        this.parseType();
        while (this.isOp(',')) {
          this.next();
          this.parseType();
        }
      });
      this.expectOp(']');
    }

    return {
      name: this.sourceOf(first.start, this.lastEnd),
      start: first.start,
      end: this.lastEnd,
    };
  }

  private sourceText = '';

  public withSource(text: string): this {
    this.sourceText = text;
    return this;
  }

  private sourceOf(start: number, end: number): string {
    return this.sourceText.slice(start, end);
  }

  private parseVar(isStatic: boolean): VarDecl {
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
  private parseAccessors(decl: VarDecl, indent: number): void {
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

  private parseParams(): Param[] {
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

  private parseFunc(indent: number, isStatic: boolean): FuncDecl {
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

  private infixOperator():
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

  private parsePrefix(): Expr {
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

  private parsePostfix(): Expr {
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

  private expectClose(value: string): void {
    if (!this.isOp(value)) {
      this.fail(`Expected "${value}"`);
    }

    this.next();
  }

  /** Comma separated expressions up to (not including) `close`. */
  private parseList(close: string): Expr[] {
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

  private parsePrimary(): Expr {
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

  private parseNamePrimary(token: Token): Expr {
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

  private parseOpPrimary(token: Token): Expr {
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
