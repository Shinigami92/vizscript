import type { TypeRef } from './ast';
import type { Token } from './lexer';

export interface ParseDiagnostic {
  message: string;
  start: number;
  end: number;
}

export class ParseError extends Error {
  public constructor(
    message: string,
    public readonly start: number,
    public readonly end: number
  ) {
    super(message);
  }
}

const CLOSERS = new Set([')', ']', '}', ',']);

/**
 * The base of the GDScript `Parser`: tokens, brackets, errors and types.
 * Expressions, declarations and statements build on it, one layer per file.
 */
export abstract class ParserBase {
  protected pos = 0;
  /** Open brackets: newlines inside them don't end statements. */
  protected brackets = 0;
  /** Nesting of lambda bodies: their statements may end at `)` or `,`. */
  protected lambdas = 0;
  protected lastEnd = 0;
  public readonly diagnostics: ParseDiagnostic[] = [];

  protected sourceText = '';

  public constructor(private readonly tokens: Token[]) {}

  public withSource(text: string): this {
    this.sourceText = text;
    return this;
  }

  protected sourceOf(start: number, end: number): string {
    return this.sourceText.slice(start, end);
  }

  // ------------------------------------------------------------ tokens

  protected peek(offset = 0): Token {
    return (
      this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)] ??
      (this.tokens.at(-1) as Token)
    );
  }

  protected next(): Token {
    const token = this.peek();
    if (token.type !== 'eof') {
      this.pos++;
      this.lastEnd = token.end;
    }

    return token;
  }

  protected isOp(value: string, offset = 0): boolean {
    const token = this.peek(offset);
    return token.type === 'op' && token.value === value;
  }

  protected isName(value: string, offset = 0): boolean {
    const token = this.peek(offset);
    return token.type === 'name' && token.value === value;
  }

  /** The next token starts a new statement (outside of brackets). */
  protected atBreak(): boolean {
    const token = this.peek();
    return token.type === 'eof' || (token.lineStart && this.brackets === 0);
  }

  protected fail(message: string, token = this.peek()): never {
    throw new ParseError(
      message,
      token.start,
      Math.max(token.end, token.start + 1)
    );
  }

  protected expectOp(value: string): Token {
    if (!this.isOp(value)) {
      this.fail(`Expected "${value}"`);
    }

    return this.next();
  }

  protected expectName(): Token {
    if (this.peek().type !== 'name') {
      this.fail('Expected a name');
    }

    return this.next();
  }

  protected bracketed<T>(fn: () => T): T {
    this.brackets++;
    try {
      return fn();
    } finally {
      this.brackets--;
    }
  }

  protected endStatement(): void {
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
  protected recover(): void {
    while (this.peek().type !== 'eof') {
      this.next();
      if (this.peek().lineStart) {
        return;
      }
    }
  }

  protected endsLambdaBody(): boolean {
    const token = this.peek();
    return this.lambdas > 0 && token.type === 'op' && CLOSERS.has(token.value);
  }

  protected parseType(): TypeRef {
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
}
