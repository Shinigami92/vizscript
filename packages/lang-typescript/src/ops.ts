import type {
  DeclarationSyntax,
  GraphDocument,
  GraphOp,
  OpResult,
  ScriptSymbol,
  StatementSyntax,
  TypeSystemInfo,
} from '@vizscript/core';
import { applyTextOp, removeModifier, replaceKeyword } from '@vizscript/core';
import { parseFile, parseTypeScript } from './lower';
import { renameTypeScriptSymbol, typeScriptCallSites } from './rename';

const KEYWORDS = new Set(
  (
    'break case catch class const continue debugger default delete do else ' +
    'enum export extends false finally for function if import in instanceof ' +
    'new null return super switch this throw true try typeof var void while ' +
    'with let static yield await implements interface package private ' +
    'protected public'
  ).split(' ')
);

const KINDS = ['const', 'let', 'var'];

export const TYPESCRIPT_TYPES: TypeSystemInfo = {
  primitives: [
    { name: 'string', dataType: 'string', defaultValue: "''" },
    { name: 'number', dataType: 'number', defaultValue: '0' },
    { name: 'boolean', dataType: 'bool', defaultValue: 'false' },
    { name: 'bigint', dataType: 'bigint', defaultValue: '0n' },
    { name: 'object', dataType: 'object', defaultValue: '{}' },
    { name: 'Date', dataType: 'Date', defaultValue: 'new Date()' },
    { name: 'RegExp', dataType: 'regexp', defaultValue: '/(?:)/' },
    { name: 'unknown', dataType: 'any', defaultValue: 'undefined' },
  ],
  array: 'T[]',
  map: 'Map<K, V>',
  set: 'Set<T>',
  optional: 'T | null',
  containerDefaults: { array: '[]', map: 'new Map()', set: 'new Set()' },
  modifiers: {
    variable: { keywords: KINDS, flags: ['export'] },
    constant: { keywords: KINDS, flags: ['export'] },
    local: { keywords: KINDS },
    member: { flags: ['static', 'readonly'] },
  },
};

/** Quote most strings of the file use. */
function quoteOf(text: string): string {
  const single = text.match(/'/g)?.length ?? 0;
  const double = text.match(/"/g)?.length ?? 0;
  return single > double ? "'" : '"';
}

function setModifier(
  text: string,
  _doc: GraphDocument,
  symbol: ScriptSymbol,
  modifier: string,
  enabled: boolean
): OpResult {
  if (KINDS.includes(modifier)) {
    if (!enabled) {
      return { ok: true, edits: [] };
    }

    if (modifier === 'const' && !symbol.defaultRange) {
      return { ok: false, error: `A const needs a value; set one first.` };
    }

    return replaceKeyword(text, symbol, KINDS, modifier);
  }

  if (modifier === 'export') {
    if (symbol.scope !== '' || symbol.kind === 'local') {
      return { ok: false, error: 'Only module declarations can be exported.' };
    }

    if (!enabled) {
      return removeModifier(text, symbol, 'export');
    }

    const at = (symbol.declarationRange ?? symbol.range).start;
    return { ok: true, edits: [{ start: at, end: at, text: 'export ' }] };
  }

  if (modifier === 'static' || modifier === 'readonly') {
    if (symbol.scope === '' || symbol.kind === 'local') {
      return { ok: false, error: `Only class members can be ${modifier}.` };
    }

    if (!enabled) {
      return removeModifier(text, symbol, modifier);
    }

    // `private static readonly name`: static before readonly.
    const lineStart = text.lastIndexOf('\n', symbol.nameRange.start - 1) + 1;
    const head = text.slice(lineStart, symbol.nameRange.start);
    const readonly = head.search(/\breadonly\b/);
    const at =
      modifier === 'static' && readonly !== -1
        ? lineStart + readonly
        : symbol.nameRange.start;
    return { ok: true, edits: [{ start: at, end: at, text: `${modifier} ` }] };
  }

  return { ok: false, error: `Unknown modifier ${modifier}.` };
}

/** Declarations of "My Script"; renames parse the file again. */
function declarations(text: string, fileName?: string): DeclarationSyntax {
  const isJs = /\.[cm]?jsx?$/i.test(fileName ?? '');
  return {
    typeSystem: TYPESCRIPT_TYPES,
    validType: (type) => {
      if (isJs) {
        return 'JavaScript has no type annotations.';
      }

      try {
        const parsed = parseFile(`let x: ${type};`, 'type.ts');
        const body = parsed.program.body;
        return (parsed.errors?.length ?? 0) > 0 || body.length !== 1
          ? `"${type}" is not a valid TypeScript type.`
          : undefined;
      } catch {
        return `"${type}" is not a valid TypeScript type.`;
      }
    },
    string: (value) => quoteString(value, quoteOf(text)),
    booleans: { true: 'true', false: 'false' },
    valueRequired: (symbol) => symbol.modifiers.includes('const'),
    returnArrow: ': ',
    callSites: (source, doc, symbol) =>
      typeScriptCallSites(
        parseFile(source, fileName).program,
        source,
        doc.symbols ?? [],
        symbol
      ),
    setModifier,
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
    rename: (source, doc, symbol, name) =>
      renameTypeScriptSymbol(
        parseFile(source, fileName).program,
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

/**
 * An expression as a statement: `{ a: 1 }` or `function () {}` at the
 * start of a statement would be a block or a declaration.
 */
function expressionStatement(expression: string): string {
  return /^(?:\{|function\b|class\b|let\s*\[)/.test(expression)
    ? `(${expression});`
    : `${expression};`;
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
  expressionStatement,
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

      case 'value': {
        const expression = template.expression.trim();
        return expression ? expressionStatement(expression) : undefined;
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
    declarations: declarations(text, fileName),
  });
}
