import type { GraphOp, OpResult, StatementSyntax } from '@vizscript/core';
import { applyTextOp } from '@vizscript/core';
import { parseGDScriptDocument } from './lower';

const IDENTIFIER = /^[A-Za-z_]\w*$/;

/** Re-quotes a string literal, keeping its `&`/`^` prefix and quote style. */
function quote(value: string, raw: string): string {
  let prefix = '';
  let i = 0;
  while ('&^'.includes(raw[i] ?? '')) {
    prefix += raw[i];
    i++;
  }

  const q = raw[i] === "'" ? "'" : '"';
  const escaped = value
    .replaceAll('\\', '\\\\')
    .replaceAll(q, `\\${q}`)
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\t', '\\t');
  return `${prefix}${q}${escaped}${q}`;
}

export const GDSCRIPT_SYNTAX: StatementSyntax = {
  placeholder: 'null',
  emptyBody: 'pass',
  bindingName: (hint) =>
    `${hint.replaceAll(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()}_result`,
  declare: (name, expr) => `var ${name} = ${expr}`,
  declarePrefix: (name) => `var ${name} = `,
  quote: (value, literal) => quote(value, literal.raw),
  appendToFile: false,
  comment: {
    line: '#',
    region: (title) => (title ? `#region ${title}` : '#region'),
    endRegion: '#endregion',
  },
  template: (template, indent, unit) => {
    switch (template.type) {
      case 'call': {
        const callee = template.callee.trim();
        return /^[\w.$%/]+$/.test(callee)
          ? `${callee}(${(template.args ?? []).join(', ')})`
          : undefined;
      }

      case 'setVar': {
        const name = template.name.trim();
        if (template.declaration === 'none') {
          return /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/.test(name)
            ? `${name} = null`
            : undefined;
        }

        return IDENTIFIER.test(name) ? `var ${name} = null` : undefined;
      }

      case 'branch': {
        return `if true:\n${indent}${unit}pass`;
      }

      case 'return': {
        return 'return';
      }
    }
  },
};

export function applyGDScriptOp(
  text: string,
  op: GraphOp,
  fileName?: string
): OpResult {
  return applyTextOp(
    text,
    parseGDScriptDocument(text, fileName),
    op,
    GDSCRIPT_SYNTAX
  );
}
