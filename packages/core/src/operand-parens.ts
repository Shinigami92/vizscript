import type { GraphNode, Pin } from './ir';

/**
 * How tightly an expression binds, low to high. Shared by all languages and
 * conservative: where they disagree (bitwise against comparison, `not`), a
 * value gets parentheses rather than a new meaning.
 */
const COMMA = 0;
const LAMBDA = 1;
const TERNARY = 2;
const RANGE = 3;
const OR = 4;
const AND = 5;
const NOT = 6;
const COMPARE = 7;
const BIT_OR = 8;
const BIT_XOR = 9;
const BIT_AND = 10;
const SHIFT = 11;
const ADD = 12;
const MUL = 13;
const POW = 14;
const UNARY = 15;
const ATOM = 99;

const BINARY: ReadonlyMap<string, number> = new Map([
  ['??', OR],
  ['||', OR],
  ['or', OR],
  ['&&', AND],
  ['and', AND],
  ['==', COMPARE],
  ['!=', COMPARE],
  ['===', COMPARE],
  ['!==', COMPARE],
  ['<', COMPARE],
  ['>', COMPARE],
  ['<=', COMPARE],
  ['>=', COMPARE],
  ['in', COMPARE],
  ['not in', COMPARE],
  ['is', COMPARE],
  ['is not', COMPARE],
  ['instanceof', COMPARE],
  ['as', COMPARE],
  ['|', BIT_OR],
  ['^', BIT_XOR],
  ['&', BIT_AND],
  ['<<', SHIFT],
  ['>>', SHIFT],
  ['>>>', SHIFT],
  ['+', ADD],
  ['-', ADD],
  ['*', MUL],
  ['/', MUL],
  ['//', MUL],
  ['%', MUL],
  ['@', MUL],
  ['**', POW],
]);

/** Prefix words: `not` binds loosely, the others like `-x`. */
const PREFIX_WORDS: ReadonlyMap<string, number> = new Map([
  ['not', NOT],
  ['await', UNARY],
  ['typeof', UNARY],
  ['void', UNARY],
  ['delete', UNARY],
  ['new', UNARY],
  ['lambda', LAMBDA],
  ['yield', LAMBDA],
]);

/** Words between two operands. */
const INFIX_WORDS: ReadonlyMap<string, number> = new Map([
  ['and', AND],
  ['or', OR],
  ['in', COMPARE],
  ['is', COMPARE],
  ['not', COMPARE],
  ['instanceof', COMPARE],
  ['as', COMPARE],
  ['if', TERNARY],
  ['else', TERNARY],
]);

/** Punctuation, longest first. */
const SYMBOLS = [
  '>>>',
  '===',
  '!==',
  '...',
  '..=',
  '=>',
  '**',
  '??',
  '?.',
  '..',
  '::',
  '==',
  '!=',
  '<=',
  '>=',
  '&&',
  '||',
  '<<',
  '>>',
  '//',
  ':=',
  '->',
];

interface Scan {
  /** The loosest binding at the top level ({@link ATOM} for none). */
  level: number;
  /** Operators at the top level. */
  operators: Set<string>;
}

function isWordStart(char: string): boolean {
  return /[A-Za-z_$]/.test(char);
}

function isWordChar(char: string): boolean {
  return /[\w$]/.test(char);
}

/** End of a quoted string starting at `start` (escapes, `${…}` in `` ` ``). */
function stringEnd(text: string, start: number): number {
  const quote = text[start];
  let i = start + 1;
  let depth = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === '\\') {
      i += 2;
      continue;
    }

    if (quote === '`' && char === '$' && text[i + 1] === '{') {
      depth++;
      i += 2;
      continue;
    }

    if (depth > 0 && char === '}') {
      depth--;
    } else if (depth === 0 && char === quote) {
      return i + 1;
    }

    i++;
  }

  return i;
}

/** `?` of Rust's `x?` (nothing that could start an operand follows). */
function isPostfixQuestion(text: string, at: number): boolean {
  const rest = text.slice(at + 1).trimStart();
  return rest === '' || /^[.)\];,?+\-*/%<>=!&|^]/.test(rest);
}

/** Finds the loosest operator at the top level of an expression. */
function scan(text: string): Scan {
  const result: Scan = { level: ATOM, operators: new Set() };
  const found = (level: number, operator: string): void => {
    result.level = Math.min(result.level, level);
    result.operators.add(operator);
  };

  let depth = 0;
  let afterOperand = false;
  let i = 0;
  while (i < text.length) {
    const char = text[i] ?? '';
    if (/\s/.test(char)) {
      i++;
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      i = stringEnd(text, i);
      afterOperand = true;
      continue;
    }

    if ('([{'.includes(char)) {
      depth++;
      i++;
      afterOperand = false;
      continue;
    }

    if (')]}'.includes(char)) {
      depth = Math.max(0, depth - 1);
      i++;
      afterOperand = true;
      continue;
    }

    if (isWordStart(char) || /\d/.test(char)) {
      let end = i + 1;
      while (end < text.length && isWordChar(text[end] ?? '')) {
        end++;
      }

      // Numbers like `1.5` and `1e-3` stay one operand.
      if (/\d/.test(char)) {
        while (end < text.length && /[\w.]/.test(text[end] ?? '')) {
          end++;
        }
      }

      const word = text.slice(i, end);
      i = end;
      if (depth > 0) {
        afterOperand = true;
        continue;
      }

      const infix = afterOperand ? INFIX_WORDS.get(word) : undefined;
      const prefix = afterOperand ? undefined : PREFIX_WORDS.get(word);
      if (infix !== undefined) {
        found(infix, word);
        afterOperand = false;
      } else if (prefix !== undefined) {
        found(prefix, word);
        afterOperand = false;
      } else {
        afterOperand = true;
      }

      continue;
    }

    const symbol =
      SYMBOLS.find((s) => text.startsWith(s, i)) ?? (char === '.' ? '.' : char);
    i += symbol.length;
    if (depth > 0) {
      afterOperand = false;
      continue;
    }

    if (symbol === '.' || symbol === '?.' || symbol === '::') {
      afterOperand = false;
      continue;
    }

    if (symbol === ',') {
      found(COMMA, ',');
    } else if (symbol === '=>' || symbol === '=' || symbol === ':=') {
      found(LAMBDA, symbol);
    } else if (symbol === '?' && afterOperand) {
      if (isPostfixQuestion(text, i - 1)) {
        continue;
      }

      found(TERNARY, '?');
    } else if (symbol === ':') {
      found(TERNARY, ':');
    } else if (symbol === '..' || symbol === '..=' || symbol === '...') {
      found(RANGE, symbol);
    } else if (symbol === '!' && afterOperand) {
      // `x!` (TypeScript) and `name!(…)` (Rust macros).
      continue;
    } else if (!afterOperand) {
      // A prefix: `-x`, `!x`, `*ptr`, `&x`, `|x| x` (a Rust closure).
      found(symbol === '|' || symbol === '||' ? LAMBDA : UNARY, symbol);
    } else {
      const level = BINARY.get(symbol);
      if (level !== undefined) {
        found(level, symbol);
      }
    }

    afterOperand = false;
  }

  return result;
}

const BITWISE = new Set([BIT_OR, BIT_XOR, BIT_AND]);

/** Whether `value` needs parentheses as an operand of `operator`. */
function binaryNeedsParens(
  operator: string,
  left: boolean,
  value: Scan
): boolean {
  const level = BINARY.get(operator);
  if (value.level === ATOM) {
    return false;
  }

  if (level === undefined || value.level < level) {
    return true;
  }

  // JavaScript forbids `??` next to `||` / `&&` without parentheses.
  const coalesce = operator === '??' || value.operators.has('??');
  const logical =
    ['||', '&&'].includes(operator) ||
    value.operators.has('||') ||
    value.operators.has('&&');
  if (coalesce && logical) {
    return true;
  }

  // Bitwise operators bind looser than `==` in JavaScript, tighter in Python.
  if (
    (level === COMPARE && BITWISE.has(value.level)) ||
    (BITWISE.has(level) && value.level === COMPARE)
  ) {
    return true;
  }

  if (value.level > level) {
    return false;
  }

  // Same level: left-associative, except comparisons and `**`.
  return !left || level === COMPARE || level === POW;
}

function unaryNeedsParens(
  operator: string,
  value: Scan,
  text: string
): boolean {
  if (operator === 'not') {
    return value.level <= NOT;
  }

  // `- -x` must not become `--x`.
  if (/^[+-]/.test(operator) && /^[+-]/.test(text.trimStart())) {
    return true;
  }

  return value.level < UNARY;
}

/**
 * The text for `value` written into `pin` of `node`: with parentheses where
 * the node's operator (or member access) would bind it differently, so
 * `a * b` with `x + y` wired into `b` becomes `a * (x + y)`.
 */
export function operandText(node: GraphNode, pin: Pin, value: string): string {
  const text = value.trim();
  const inputs = node.pins.filter(
    (p) => p.direction === 'in' && p.kind === 'data'
  );
  let wrap = false;
  if (
    pin.id === 'target' &&
    (node.kind === 'call' || node.kind === 'getProperty')
  ) {
    wrap = scan(text).level < ATOM;
  } else if (node.kind === 'await') {
    wrap = scan(text).level < UNARY;
  } else if (node.kind === 'operator') {
    wrap =
      inputs.length === 1
        ? unaryNeedsParens(node.title, scan(text), text)
        : binaryNeedsParens(node.title, inputs[0]?.id === pin.id, scan(text));
  }

  return wrap ? `(${text})` : value;
}

/**
 * Puts `value` into an expression template at `$value`, with parentheses
 * where the template's operator would bind it differently.
 */
export function substituteValue(template: string, value: string): string {
  const at = template.indexOf('$value');
  if (at === -1) {
    return template;
  }

  const before = template.slice(0, at);
  const after = template.slice(at + '$value'.length).trimStart();
  const inside = scan(`${before}0`);
  const nested =
    before.split('').filter((c) => '([{'.includes(c)).length >
    before.split('').filter((c) => ')]}'.includes(c)).length;
  const own = scan(value);
  let wrap = false;
  if (nested) {
    wrap = own.level === COMMA;
  } else if (/^(\.|\?\.|\[|\()/.test(after)) {
    wrap = own.level < ATOM;
  } else {
    const outer = scan(template.replaceAll('$value', '0'));
    const operator = [...outer.operators].find(
      (o) => BINARY.get(o) === outer.level
    );
    if (operator !== undefined) {
      wrap = binaryNeedsParens(operator, before.trim() === '', own);
    } else if (inside.level < ATOM) {
      const prefix = before.trim();
      wrap = unaryNeedsParens(prefix, own, value);
    }
  }

  return template.replaceAll('$value', wrap ? `(${value.trim()})` : value);
}
