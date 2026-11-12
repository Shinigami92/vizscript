import type {
  DeclarationSyntax,
  GraphOp,
  OpResult,
  StatementSyntax,
} from '@vizscript/core';
import { applyTextOp } from '@vizscript/core';
import { parseFile, parseTypeScript } from './lower';
import { renameTypeScriptSymbol } from './rename';

const KEYWORDS = new Set(
  (
    'break case catch class const continue debugger default delete do else ' +
    'enum export extends false finally for function if import in instanceof ' +
    'new null return super switch this throw true try typeof var void while ' +
    'with let static yield await implements interface package private ' +
    'protected public'
  ).split(' ')
);

/** Declarations of "My Script"; renames parse the file again. */
function declarations(fileName?: string): DeclarationSyntax {
  return {
    identifier: /^[A-Za-z_$][\w$]*$/,
    keywords: KEYWORDS,
    defaultIndent: '  ',
    blankLines: 1,
    bracedClasses: true,
    header: /^(?:import\b|['"]use strict['"]|#!)/,
    fn: (name, _unit, method) =>
      method ? `${name}() {\n}` : `function ${name}() {\n}`,
    variable: (name, { constant, member }) => {
      if (member) {
        return `${name} = undefined;`;
      }

      return constant ? `const ${name} = undefined;` : `let ${name};`;
    },
    rename: (text, doc, symbol, name) =>
      renameTypeScriptSymbol(
        parseFile(text, fileName).program,
        doc.symbols ?? [],
        symbol,
        name
      ),
  };
}

function quoteString(value: string, quote: string): string {
  let escaped = value.replaceAll('\\', '\\\\');
  if (quote === '`') {
    escaped = escaped.replaceAll('`', '\\`').replaceAll('${', '\\${');
    return `\`${escaped}\``;
  }

  escaped = escaped
    .replaceAll(quote, `\\${quote}`)
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r');
  return `${quote}${escaped}${quote}`;
}

export const TYPESCRIPT_SYNTAX: StatementSyntax = {
  placeholder: 'undefined',
  emptyBody: '{}',
  bindingName: (hint) => `${hint}Result`,
  declare: (name, expr) => `const ${name} = ${expr};`,
  declarePrefix: (name) => `const ${name} = `,
  quote: (value, literal) =>
    quoteString(
      value,
      literal.kind === 'template' ? '`' : (literal.raw[0] ?? "'")
    ),
  appendToFile: true,
  statementEnd: ';',
  // `{ a: 1 }` or `function () {}` at the start of a statement would be a
  // block or a declaration.
  expressionStatement: (expression) =>
    /^(?:\{|function\b|class\b|let\s*\[)/.test(expression)
      ? `(${expression});`
      : `${expression};`,
  comment: {
    line: '//',
    region: (title) => (title ? `// #region ${title}` : '// #region'),
    endRegion: '// #endregion',
  },
  template: (template, indent) => {
    switch (template.type) {
      case 'call': {
        const callee = template.callee.trim();
        return /^[\w$.]+$/.test(callee)
          ? `${callee}(${(template.args ?? []).join(', ')});`
          : undefined;
      }

      case 'setVar': {
        const name = template.name.trim();
        if (!/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(name)) {
          return undefined;
        }

        return template.declaration === 'none'
          ? `${name} = undefined;`
          : `${template.declaration} ${name} = undefined;`;
      }

      case 'branch': {
        return `if (true) {\n${indent}}`;
      }

      case 'return': {
        return 'return;';
      }
    }
  },
};

export function applyTypeScriptOp(
  text: string,
  op: GraphOp,
  fileName?: string
): OpResult {
  return applyTextOp(text, parseTypeScript(text, fileName), op, {
    ...TYPESCRIPT_SYNTAX,
    declarations: declarations(fileName),
  });
}
