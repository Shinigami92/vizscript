import type {
  DeclarationSyntax,
  GraphOp,
  OpResult,
  StatementSyntax,
} from '@vizscript/core';
import { applyTextOp } from '@vizscript/core';
import { parseGDScriptDocument } from './lower';
import { parseGDScript } from './parser';
import { renameGDScriptSymbol } from './rename';

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

const KEYWORDS = new Set(
  (
    'if elif else for while match break continue pass return class ' +
    'class_name extends is in as self signal func static const enum var ' +
    'breakpoint preload await yield assert void true false null not and ' +
    'or PI TAU INF NAN super'
  ).split(' ')
);

const DECLARATIONS: DeclarationSyntax = {
  identifier: /^[A-Za-z_]\w*$/,
  keywords: KEYWORDS,
  defaultIndent: '\t',
  blankLines: 2,
  bracedClasses: false,
  header: /^(?:@tool\b|@icon\b|@static_unload\b|class_name\b|extends\b)/,
  fn: (name, unit) => `func ${name}() -> void:\n${unit}pass`,
  variable: (name, { constant }) =>
    constant ? `const ${name} = null` : `var ${name}`,
  signal: (name) => `signal ${name}`,
  rename: (text, doc, symbol, name) =>
    renameGDScriptSymbol(
      parseGDScript(text).script.body,
      doc.symbols ?? [],
      symbol,
      name
    ),
};

export const GDSCRIPT_SYNTAX: StatementSyntax = {
  placeholder: 'null',
  emptyBody: 'pass',
  bindingName: (hint) =>
    `${hint.replaceAll(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()}_result`,
  declare: (name, expr) => `var ${name} = ${expr}`,
  declarePrefix: (name) => `var ${name} = `,
  quote: (value, literal) => quote(value, literal.raw),
  appendToFile: false,
  declarations: DECLARATIONS,
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
