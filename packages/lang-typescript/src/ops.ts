import type {
  DeclarationSyntax,
  GraphDocument,
  GraphOp,
  OpResult,
  ParseOptions,
  ScriptSymbol,
  StatementSyntax,
  TypeSystemInfo,
} from '@vizscript/core';
import { applyTextOp, removeModifier, replaceKeyword } from '@vizscript/core';
import { addTypeScriptImport } from './add-import';
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
  placeholder: 'undefined',
  expressions: [
    {
      label: '+ (add)',
      category: 'Math',
      template: '$1 + $2',
      keywords: 'add plus sum join concat',
    },
    {
      label: '- (subtract)',
      category: 'Math',
      template: '$1 - $2',
      result: 'number',
      keywords: 'subtract minus',
    },
    {
      label: '× (multiply)',
      category: 'Math',
      template: '$1 * $2',
      result: 'number',
      keywords: 'multiply times',
    },
    {
      label: '÷ (divide)',
      category: 'Math',
      template: '$1 / $2',
      result: 'number',
      keywords: 'divide',
    },
    {
      label: '% (remainder)',
      category: 'Math',
      template: '$1 % $2',
      result: 'number',
      keywords: 'modulo remainder',
    },
    {
      label: '** (power)',
      category: 'Math',
      template: '$1 ** $2',
      result: 'number',
      keywords: 'power exponent',
    },
    {
      label: '- (negate)',
      category: 'Math',
      template: '-$1',
      result: 'number',
      keywords: 'negate negative',
    },
    {
      label: '== (equal)',
      category: 'Comparison',
      template: '$1 === $2',
      result: 'bool',
      keywords: 'equal equals is',
    },
    {
      label: '!= (not equal)',
      category: 'Comparison',
      template: '$1 !== $2',
      result: 'bool',
      keywords: 'not equal',
    },
    {
      label: '< (less)',
      category: 'Comparison',
      template: '$1 < $2',
      result: 'bool',
      keywords: 'less smaller',
    },
    {
      label: '<= (less or equal)',
      category: 'Comparison',
      template: '$1 <= $2',
      result: 'bool',
      keywords: 'less equal',
    },
    {
      label: '> (greater)',
      category: 'Comparison',
      template: '$1 > $2',
      result: 'bool',
      keywords: 'greater bigger',
    },
    {
      label: '>= (greater or equal)',
      category: 'Comparison',
      template: '$1 >= $2',
      result: 'bool',
      keywords: 'greater equal',
    },
    {
      label: 'AND',
      category: 'Logic',
      template: '$1 && $2',
      result: 'bool',
      keywords: 'and both',
    },
    {
      label: 'OR',
      category: 'Logic',
      template: '$1 || $2',
      result: 'bool',
      keywords: 'or either',
    },
    {
      label: 'NOT',
      category: 'Logic',
      template: '!$1',
      result: 'bool',
      keywords: 'not negate invert',
    },
    {
      label: '?? (default if missing)',
      category: 'Logic',
      template: '$1 ?? $2',
      keywords: 'nullish default fallback',
    },
    {
      label: 'Select (a ? b : c)',
      category: 'Logic',
      template: '$1 ? $2 : $3',
      keywords: 'select ternary conditional if',
    },
    {
      label: 'Join text',
      category: 'Text',
      template: '`${$1}${$2}`',
      result: 'string',
      keywords: 'join concat append format template string',
    },
    {
      label: 'To text',
      category: 'Text',
      template: 'String($1)',
      result: 'string',
      keywords: 'string convert text',
    },
    {
      label: 'Text',
      category: 'Values',
      template: "''",
      result: 'string',
      keywords: 'string literal text',
    },
    {
      label: 'Number',
      category: 'Values',
      template: '0',
      result: 'number',
      keywords: 'number literal int float',
    },
    {
      label: 'Boolean',
      category: 'Values',
      template: 'false',
      result: 'bool',
      keywords: 'boolean literal true false',
    },
    {
      label: 'null',
      category: 'Values',
      template: 'null',
      result: 'null',
      keywords: 'null nothing',
    },
    {
      label: 'Make array',
      category: 'Values',
      template: '[]',
      result: 'array',
      keywords: 'array list',
    },
    {
      label: 'Make object',
      category: 'Values',
      template: '{}',
      result: 'object',
      keywords: 'object map record',
    },
  ],
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
  const syntax: DeclarationSyntax = {
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
    extract: {
      fn: (name, params, body, { method, isStatic, isAsync }) => {
        const list = params
          .map((p) => (p.type && !isJs ? `${p.name}: ${p.type}` : p.name))
          .join(', ');
        const head = method
          ? `${isStatic ? 'static ' : ''}${isAsync ? 'async ' : ''}${name}`
          : `${isAsync ? 'async ' : ''}function ${name}`;
        return `${head}(${list}) {\n${body}\n}`;
      },
      call: (callee, args, { isAsync, output }) => {
        const store = output
          ? `${output.declare ? `${output.declare} ` : ''}${output.name} = `
          : '';
        return `${store}${isAsync ? 'await ' : ''}${callee}(${args.join(', ')});`;
      },
      returnValue: (name) => `return ${name};`,
      method: (name, className, isStatic) =>
        isStatic ? `${className}.${name}` : `this.${name}`,
    },
    addImport: (source, doc, request) =>
      addTypeScriptImport(source, doc, request, syntax),
    rename: (source, doc, symbol, name) =>
      renameTypeScriptSymbol(
        parseFile(source, fileName).program,
        doc.symbols ?? [],
        symbol,
        name
      ),
  };
  return syntax;
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
    doc: 'block',
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
  fileName?: string,
  options?: ParseOptions
): OpResult {
  return applyTextOp(text, parseTypeScript(text, fileName, options), op, {
    ...TYPESCRIPT_SYNTAX,
    declarations: declarations(text, fileName),
  });
}
