import type {
  DeclarationSyntax,
  GraphOp,
  OpResult,
  PinLiteral,
  StatementSyntax,
  TypeSystemInfo,
} from '@vizscript/core';
import { applyTextOp } from '@vizscript/core';
import { parsePython, splitString } from './convert';
import { parsePythonDocument } from './lower';
import { pythonCallSites, renamePythonSymbol } from './rename';

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

const KEYWORDS = new Set(
  (
    'False None True and as assert async await break class continue def ' +
    'del elif else except finally for from global if import in is lambda ' +
    'nonlocal not or pass raise return try while with yield'
  ).split(' ')
);

export const PYTHON_TYPES: TypeSystemInfo = {
  primitives: [
    { name: 'str', dataType: 'string', defaultValue: '""' },
    { name: 'int', dataType: 'number', defaultValue: '0' },
    { name: 'float', dataType: 'number', defaultValue: '0.0' },
    { name: 'bool', dataType: 'bool', defaultValue: 'False' },
    { name: 'bytes', dataType: 'string', defaultValue: 'b""' },
    { name: 'object', dataType: 'any', defaultValue: 'None' },
  ],
  array: 'list[T]',
  map: 'dict[K, V]',
  set: 'set[T]',
  optional: 'T | None',
  containerDefaults: { array: '[]', map: '{}', set: 'set()' },
  // Python has no declaration keywords; constants are UPPER_CASE names.
  modifiers: {},
};

const DECLARATIONS: DeclarationSyntax = {
  typeSystem: PYTHON_TYPES,
  validType: (type) => {
    const { body, diagnostics } = parsePython(`x: ${type} = None\n`);
    const [stmt] = body;
    return diagnostics.length > 0 ||
      body.length !== 1 ||
      stmt?.type !== 'Assign' ||
      !stmt.annotation
      ? `"${type}" is not a valid Python type.`
      : undefined;
  },
  string: (value) => JSON.stringify(value),
  booleans: { true: 'True', false: 'False' },
  returnArrow: ' -> ',
  callSites: (text, doc, symbol) =>
    pythonCallSites(parsePython(text).body, text, doc.symbols ?? [], symbol),
  // `x = 1` needs its value; `x: int` alone is a declaration (not `self.x`).
  valueRequired: (symbol, typed) =>
    !typed || symbol.modifiers.some((m) => m.endsWith('.')),
  setModifier: () => ({
    ok: false,
    error: 'Python has no declaration modifiers; constants are UPPER_CASE.',
  }),
  identifier: /^[A-Za-z_]\w*$/,
  keywords: KEYWORDS,
  defaultIndent: '    ',
  blankLines: 2,
  bracedClasses: false,
  header: /^(?:import\b|from\s+\S+\s+import\b|#!|#.*coding[:=])/,
  fn: (name, unit, method) =>
    `def ${name}(${method ? 'self' : ''}):\n${unit}pass`,
  variable: (name) => `${name} = None`,
  rename: (text, doc, symbol, name) =>
    renamePythonSymbol(
      parsePython(text).body,
      text,
      doc.symbols ?? [],
      symbol,
      name
    ),
};

export const PYTHON_SYNTAX: StatementSyntax = {
  placeholder: 'None',
  emptyBody: 'pass',
  bindingName: (hint) =>
    `${hint.replaceAll(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()}_result`,
  declare: (name, expr) => `${name} = ${expr}`,
  declarePrefix: (name) => `${name} = `,
  quote,
  appendToFile: true,
  declarations: DECLARATIONS,
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
