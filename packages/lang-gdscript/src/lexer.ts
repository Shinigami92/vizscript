/**
 * GDScript tokenizer.
 *
 * Instead of emitting INDENT/DEDENT tokens, every token records whether it
 * starts a line and the indentation of its line. The parser derives blocks
 * from that, which also works for multi-line lambdas inside brackets.
 */

export type TokenType =
  | 'name'
  | 'number'
  | 'string'
  | 'op'
  | 'annotation'
  | 'nodePath'
  | 'eof';

export interface Token {
  type: TokenType;
  /** Source text of the token (for strings: including quotes/prefix). */
  value: string;
  start: number;
  end: number;
  /** First token of its (logical) line. */
  lineStart: boolean;
  /** Indentation width (characters) of the line the token is on. */
  indent: number;
}

export interface LexError {
  message: string;
  start: number;
  end: number;
}

const OPERATORS = [
  '**=',
  '<<=',
  '>>=',
  '**',
  '<<',
  '>>',
  '==',
  '!=',
  '<=',
  '>=',
  '&&',
  '||',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '&=',
  '|=',
  '^=',
  '->',
  ':=',
  '+',
  '-',
  '*',
  '/',
  '%',
  '<',
  '>',
  '=',
  '!',
  '~',
  '&',
  '|',
  '^',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  ',',
  ':',
  '.',
  ';',
];

function isIdentStart(c: string): boolean {
  return /[\p{L}_]/u.test(c);
}

function isIdentPart(c: string): boolean {
  return /[\p{L}\p{N}_]/u.test(c);
}

function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= '0' && c <= '9';
}

export function tokenize(text: string): {
  tokens: Token[];
  errors: LexError[];
  /** Ranges of `#` comments. */
  comments: Array<{ start: number; end: number }>;
} {
  const tokens: Token[] = [];
  const errors: LexError[] = [];
  const comments: Array<{ start: number; end: number }> = [];
  const skipComment = (): void => {
    const start = i;
    while (i < text.length && text[i] !== '\n') {
      i++;
    }

    comments.push({ start, end: text[i - 1] === '\r' ? i - 1 : i });
  };
  let i = 0;
  let atLineStart = true;
  let indent = 0;

  const push = (type: TokenType, start: number, end: number): void => {
    tokens.push({
      type,
      value: text.slice(start, end),
      start,
      end,
      lineStart: atLineStart,
      indent,
    });
    atLineStart = false;
  };

  const readString = (start: number): number => {
    let j = start;
    while (j < text.length && 'r&^'.includes(text[j] ?? '')) {
      j++;
    }

    const raw = text.slice(start, j).includes('r');
    const quote = text[j] ?? '"';
    const triple = text.startsWith(quote.repeat(3), j);
    const delimiter = triple ? quote.repeat(3) : quote;
    j += delimiter.length;
    while (j < text.length) {
      if (!raw && text[j] === '\\') {
        j += 2;
        continue;
      }

      if (text.startsWith(delimiter, j)) {
        return j + delimiter.length;
      }

      if (!triple && text[j] === '\n') {
        break;
      }

      j++;
    }

    errors.push({ message: 'Unterminated string', start, end: j });
    return j;
  };

  while (i < text.length) {
    if (atLineStart) {
      // Measure indentation; blank and comment-only lines don't count.
      let j = i;
      while (text[j] === ' ' || text[j] === '\t') {
        j++;
      }

      indent = j - i;
      i = j;
      const next = text[i];
      if (
        next === '\n' ||
        next === '\r' ||
        next === '#' ||
        next === undefined
      ) {
        if (next === '#') {
          skipComment();
        }

        if (text[i] === '\r') {
          i++;
        }

        if (text[i] === '\n') {
          i++;
        }

        continue;
      }
    }

    const ch = text[i] ?? '';
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i++;
      continue;
    }

    if (ch === '\n') {
      i++;
      atLineStart = true;
      continue;
    }

    if (ch === '\\' && (text[i + 1] === '\n' || text[i + 1] === '\r')) {
      // Explicit line continuation.
      i += text[i + 1] === '\r' ? 3 : 2;
      continue;
    }

    if (ch === '#') {
      skipComment();
      continue;
    }

    const start = i;
    const next = text[i + 1] ?? '';

    if (
      ch === '"' ||
      ch === "'" ||
      ((ch === '&' || ch === '^' || ch === 'r') &&
        (next === '"' || next === "'"))
    ) {
      i = readString(i);
      push('string', start, i);
      continue;
    }

    if (isDigit(ch) || (ch === '.' && isDigit(next))) {
      if (
        ch === '0' &&
        (next === 'x' || next === 'X' || next === 'b' || next === 'B')
      ) {
        i += 2;
        while (/[\w]/.test(text[i] ?? '')) {
          i++;
        }
      } else {
        while (isDigit(text[i]) || text[i] === '_') {
          i++;
        }

        if (text[i] === '.' && text[i + 1] !== '.') {
          i++;
          while (isDigit(text[i]) || text[i] === '_') {
            i++;
          }
        }

        if (text[i] === 'e' || text[i] === 'E') {
          const sign = text[i + 1] === '+' || text[i + 1] === '-' ? 1 : 0;
          if (isDigit(text[i + 1 + sign])) {
            i += 1 + sign;
            while (isDigit(text[i]) || text[i] === '_') {
              i++;
            }
          }
        }
      }

      push('number', start, i);
      continue;
    }

    if (isIdentStart(ch)) {
      while (i < text.length && isIdentPart(text[i] ?? '')) {
        i++;
      }

      push('name', start, i);
      continue;
    }

    if (ch === '@' && isIdentStart(next)) {
      i++;
      while (i < text.length && isIdentPart(text[i] ?? '')) {
        i++;
      }

      push('annotation', start, i);
      continue;
    }

    if (ch === '$') {
      // `$Path/To/Node`, `$"Quoted/Path"` or `$%Unique`.
      i++;
      if (text[i] === '"' || text[i] === "'") {
        i = readString(i);
      } else {
        // A dot ends the path: `$Label.text` reads a property of the node.
        while (i < text.length && /[\p{L}\p{N}_/%]/u.test(text[i] ?? '')) {
          i++;
        }
      }

      push('nodePath', start, i);
      continue;
    }

    const op = OPERATORS.find((o) => text.startsWith(o, i));
    if (op) {
      i += op.length;
      push('op', start, i);
      continue;
    }

    errors.push({
      message: `Unexpected character ${JSON.stringify(ch)}`,
      start,
      end: start + 1,
    });
    i++;
  }

  tokens.push({
    type: 'eof',
    value: '',
    start: text.length,
    end: text.length,
    lineStart: true,
    indent: 0,
  });
  return { tokens, errors, comments };
}
