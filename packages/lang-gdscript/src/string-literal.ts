import type { LiteralKind } from './ast';

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
