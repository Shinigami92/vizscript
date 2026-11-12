import type {
  GraphOp,
  OpResult,
  PinLiteral,
  StatementSyntax,
} from '@vizscript/core';
import { applyTextOp } from '@vizscript/core';
import { splitString } from './convert';
import { parsePythonDocument } from './lower';

const IDENTIFIER = /^[A-Za-z_]\w*$/;

/** Re-quotes a string literal, keeping its prefix and quote style. */
function quote(value: string, literal: PinLiteral): string {
  const { prefix, quote: q } = splitString(literal.raw);
  const isRaw = /r/i.test(prefix);
  const single = q.length === 1;
  const mark = q[0] ?? '"';
  let escaped = isRaw ? value : value.replaceAll('\\', '\\\\');
  if (!isRaw) {
    escaped = single
      ? escaped
          .replaceAll(mark, `\\${mark}`)
          .replaceAll('\n', '\\n')
          .replaceAll('\r', '\\r')
      : escaped.replaceAll(q, `\\${q}`);
  }

  // Raw strings cannot contain their own quote: switch to the other one.
  const quoteChar =
    isRaw && single && value.includes(mark) ? (mark === '"' ? "'" : '"') : q;
  return `${prefix}${quoteChar}${escaped}${quoteChar}`;
}

export const PYTHON_SYNTAX: StatementSyntax = {
  placeholder: 'None',
  emptyBody: 'pass',
  bindingName: (hint) =>
    `${hint.replaceAll(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()}_result`,
  declare: (name, expr) => `${name} = ${expr}`,
  declarePrefix: (name) => `${name} = `,
  quote,
  appendToFile: true,
  comment: {
    line: '#',
    region: (title) => (title ? `# region ${title}` : '# region'),
    endRegion: '# endregion',
  },
  booleans: { true: 'True', false: 'False' },
  template: (template, indent, unit) => {
    switch (template.type) {
      case 'call': {
        const callee = template.callee.trim();
        return /^[A-Za-z_][\w.]*$/.test(callee)
          ? `${callee}(${(template.args ?? []).join(', ')})`
          : undefined;
      }

      case 'setVar': {
        const name = template.name.trim();
        return IDENTIFIER.test(name) ||
          (template.declaration === 'none' &&
            /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)+$/.test(name))
          ? `${name} = None`
          : undefined;
      }

      case 'branch': {
        return `if True:\n${indent}${unit}pass`;
      }

      case 'return': {
        return 'return';
      }
    }
  },
};

export function applyPythonOp(
  text: string,
  op: GraphOp,
  fileName?: string
): OpResult {
  return applyTextOp(
    text,
    parsePythonDocument(text, fileName),
    op,
    PYTHON_SYNTAX
  );
}
