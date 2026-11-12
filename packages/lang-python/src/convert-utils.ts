import type { SyntaxNode } from '@lezer/common';

export interface PythonDiagnostic {
  message: string;
  start: number;
  end: number;
}

/** Node types that are never expressions on their own. */
const NOT_EXPRESSIONS = new Set([
  'AssignOp',
  'UpdateOp',
  'ArithOp',
  'CompareOp',
  'BitOp',
  'TypeDef',
  'ArgList',
  'ParamList',
  'Body',
  'Comment',
  'Decorator',
  'At',
  'MatchBody',
  'MatchClause',
  'FormatReplacement',
  'FormatSpec',
  'FormatConversion',
  'PropertyName',
]);

export function children(node: SyntaxNode): SyntaxNode[] {
  const result: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name !== 'Comment') {
      result.push(child);
    }
  }

  return result;
}

export function isExpression(node: SyntaxNode): boolean {
  return /^[A-Z]/.test(node.name) && !NOT_EXPRESSIONS.has(node.name);
}

function unescapePython(body: string): string {
  return body.replaceAll(
    /\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|.)/gs,
    (_, c: string) => {
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

        case '0': {
          return '\0';
        }

        case 'x':
        case 'u': {
          return c.length > 1
            ? String.fromCodePoint(Number.parseInt(c.slice(1), 16))
            : c;
        }

        case '\n': {
          return '';
        }

        default: {
          return c;
        }
      }
    }
  );
}

/** Prefix, quote and unescaped content of a Python string literal. */
export function splitString(raw: string): {
  prefix: string;
  quote: string;
  body: string;
  value: string;
} {
  const prefix = raw.match(/^[rRbBuUfF]*/)?.[0] ?? '';
  const rest = raw.slice(prefix.length);
  const quote = rest.startsWith('"""')
    ? '"""'
    : rest.startsWith("'''")
      ? "'''"
      : (rest[0] ?? '"');
  const body =
    rest.endsWith(quote) && rest.length >= quote.length * 2
      ? rest.slice(quote.length, -quote.length)
      : rest.slice(quote.length);
  const isRaw = /r/i.test(prefix);
  return { prefix, quote, body, value: isRaw ? body : unescapePython(body) };
}

/**
 * Lezer's Python grammar rejects a few valid constructs. Two of them leave
 * the tree intact and only add an error node, which is ignored:
 * - a bare `yield` (an empty error node where the value would be),
 * - star targets in comprehensions (`[a for a, *rest in xs]`).
 */
export function isKnownGap(node: SyntaxNode, text: string): boolean {
  const parent = node.parent?.name ?? '';
  if (parent === 'YieldStatement' && node.from === node.to) {
    return true;
  }

  return /Comprehension/.test(parent) && text.slice(node.from, node.to) === '*';
}

/**
 * Same-length rewrite of constructs the grammar cannot parse, so offsets
 * stay valid: `with x as (a, b):` becomes `with x as _a__b_:` (only for the
 * parser; names shown in the graph come from the original text).
 */
export function maskForParser(text: string): string {
  return text.replaceAll(
    /^([ \t]*(?:async[ \t]+)?with\b[^\n]*?\bas[ \t]+)\(([\w\s,*]*)\)/gm,
    (_, head: string, inner: string) =>
      `${head}_${inner.replaceAll(/[^\w]/g, '_')}_`
  );
}
