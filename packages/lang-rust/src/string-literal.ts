function unescapeRust(body: string): string {
  return body.replaceAll(
    /\\(x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]+\}|\n\s*|.)/gs,
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

        case 'x': {
          return String.fromCodePoint(Number.parseInt(c.slice(1), 16));
        }

        case 'u': {
          return String.fromCodePoint(
            Number.parseInt(c.slice(2, -1), 16) || 0xfffd
          );
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

/** Prefix (`b`, `r#`), quotes and value of a string or char literal. */
export function splitString(raw: string): {
  prefix: string;
  open: string;
  close: string;
  value: string;
  raw: boolean;
} {
  const rawMatch = raw.match(/^(b?r)(#*)"/);
  if (rawMatch) {
    const hashes = rawMatch[2] ?? '';
    const open = `${rawMatch[1] ?? 'r'}${hashes}"`;
    const close = `"${hashes}`;
    const body = raw.endsWith(close)
      ? raw.slice(open.length, -close.length)
      : raw.slice(open.length);
    return { prefix: rawMatch[1] ?? 'r', open, close, value: body, raw: true };
  }

  const prefix = raw.match(/^[bc]?/)?.[0] ?? '';
  const quote = raw[prefix.length] ?? '"';
  const body =
    raw.length > prefix.length + 1 && raw.endsWith(quote)
      ? raw.slice(prefix.length + 1, -1)
      : raw.slice(prefix.length + 1);
  return {
    prefix,
    open: `${prefix}${quote}`,
    close: quote,
    value: unescapeRust(body),
    raw: false,
  };
}
