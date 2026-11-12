import type {
  DeclarationSyntax,
  GraphDocument,
  GraphOp,
  OpResult,
  ParseOptions,
  ScriptSymbol,
  StatementSyntax,
  SymbolParam,
  TypeSystemInfo,
} from '@vizscript/core';
import {
  applyTextOp,
  removeListItem,
  removeModifier,
  replaceKeyword,
} from '@vizscript/core';
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
const ACCESS = ['public', 'protected', 'private'];

export const TYPESCRIPT_TYPES: TypeSystemInfo = {
  keywords: [...KEYWORDS],
  globals: [
    'console.log',
    'console.info',
    'console.warn',
    'console.error',
    'Math.abs',
    'Math.ceil',
    'Math.floor',
    'Math.max',
    'Math.min',
    'Math.random',
    'Math.round',
    'Math.sqrt',
    'JSON.parse',
    'JSON.stringify',
    'Number',
    'String',
    'Boolean',
    'parseInt',
    'parseFloat',
    'isNaN',
    'Array.isArray',
    'Array.from',
    'Object.keys',
    'Object.values',
    'Object.entries',
    'Object.assign',
    'Promise.all',
    'Promise.resolve',
    'setTimeout',
    'clearTimeout',
    'setInterval',
    'clearInterval',
    'fetch',
    'structuredClone',
    'encodeURIComponent',
    'decodeURIComponent',
  ],
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
  exposeOnSpawn: true,
  flow: [
    'forEach',
    'forRange',
    'while',
    'switch',
    'try',
    'throw',
    'break',
    'continue',
  ],
  modifiers: {
    variable: { keywords: KINDS, flags: ['export'] },
    constant: { keywords: KINDS, flags: ['export'] },
    local: { keywords: KINDS },
    member: { access: ACCESS, flags: ['static', 'readonly'] },
    function: { flags: ['export', 'async'] },
    method: { access: ACCESS, flags: ['static', 'async'] },
  },
};

/** Quote most strings of the file use. */
function quoteOf(text: string): string {
  const single = text.match(/'/g)?.length ?? 0;
  const double = text.match(/"/g)?.length ?? 0;
  return single > double ? "'" : '"';
}

/**
 * UE's "Expose on Spawn": a field becomes a parameter property of the
 * constructor (`constructor(public speed = 10)`), set when the class is
 * created, and back.
 */
function setConstructorParameter(
  text: string,
  doc: GraphDocument,
  symbol: ScriptSymbol,
  enabled: boolean
): OpResult {
  if (symbol.kind !== 'variable' || symbol.scope === '') {
    return {
      ok: false,
      error: 'Only fields of a class can be set when created.',
    };
  }

  const ctor = doc.symbols?.find(
    (s) =>
      s.kind === 'method' &&
      s.scope === symbol.scope &&
      s.name === 'constructor'
  );
  const access = symbol.modifiers.find((m) => ACCESS.includes(m));
  const readonly = symbol.modifiers.includes('readonly');
  const type = symbol.type ? `: ${symbol.type.text}` : '';
  const value = symbol.defaultRange
    ? ` = ${text.slice(symbol.defaultRange.start, symbol.defaultRange.end)}`
    : '';

  if (!enabled) {
    // Back to a field above the constructor.
    if (!ctor) {
      return { ok: false, error: 'Cannot find the constructor.' };
    }

    const removed = removeListItem(text, symbol.range, true);
    const lineStart = text.lastIndexOf('\n', ctor.range.start - 1) + 1;
    const indent =
      text.slice(lineStart, ctor.range.start).match(/^\s*/)?.[0] ?? '';
    const prefix = [
      ...(access && access !== 'public' ? [access] : []),
      ...(readonly ? ['readonly'] : []),
    ].join(' ');
    const field = `${indent}${prefix ? `${prefix} ` : ''}${symbol.name}${type}${value};\n`;
    return {
      ok: true,
      edits: [removed, { start: lineStart, end: lineStart, text: field }],
    };
  }

  if (symbol.modifiers.includes('static') || symbol.name.startsWith('#')) {
    return {
      ok: false,
      error: 'Static and #private fields cannot be constructor parameters.',
    };
  }

  const param = `${access ?? 'public'} ${readonly ? 'readonly ' : ''}${symbol.name}${type}${value}`;
  const fieldStart = text.lastIndexOf('\n', symbol.range.start - 1) + 1;
  const fieldEnd = text.indexOf('\n', symbol.range.end);
  const field = {
    start: fieldStart,
    end: fieldEnd === -1 ? text.length : fieldEnd + 1,
  };
  if (!ctor) {
    const cls = doc.symbols?.find(
      (s) => s.kind === 'class' && s.name === symbol.scope
    );
    if (cls?.extends) {
      return {
        ok: false,
        error: `${symbol.scope} extends ${cls.extends}: add a constructor that calls super() first.`,
      };
    }

    // The field's line becomes the constructor.
    const indent = text.slice(fieldStart, symbol.range.start);
    return {
      ok: true,
      edits: [{ ...field, text: `${indent}constructor(${param}) {}\n` }],
    };
  }

  // After the last parameter, or inside `()`.
  const params = ctor.params ?? [];
  const last = params.at(-1);
  const open = text.indexOf('(', ctor.nameRange.end);
  const insert = last
    ? { start: paramEnd(text, last), text: `, ${param}` }
    : { start: open + 1, text: param };
  return {
    ok: true,
    edits: [
      { start: field.start, end: field.end, text: '' },
      { start: insert.start, end: insert.start, text: insert.text },
    ],
  };
}

/** End of a parameter in the code (with its type and default value). */
function paramEnd(text: string, param: SymbolParam): number {
  return Math.max(
    param.nameRange.end,
    param.type?.range.end ?? 0,
    param.defaultRange?.end ?? 0
  );
}

function setModifier(
  text: string,
  doc: GraphDocument,
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

  if (modifier === 'constructor') {
    return setConstructorParameter(text, doc, symbol, enabled);
  }

  if (ACCESS.includes(modifier)) {
    if (!enabled) {
      return { ok: true, edits: [] };
    }

    if (symbol.scope === '' || symbol.kind === 'local') {
      return { ok: false, error: 'Only class members have an access level.' };
    }

    const current = symbol.modifiers.find((m) => ACCESS.includes(m));
    if (modifier === 'public') {
      // Public is the default: no keyword.
      return current && current !== 'public'
        ? removeModifier(text, symbol, current)
        : { ok: true, edits: [] };
    }

    if (current) {
      return replaceKeyword(text, symbol, ACCESS, modifier);
    }

    // The access level comes first (`private static readonly`).
    const at = (symbol.declarationRange ?? symbol.range).start;
    return { ok: true, edits: [{ start: at, end: at, text: `${modifier} ` }] };
  }

  if (modifier === 'async') {
    if (!enabled) {
      return removeModifier(text, symbol, 'async');
    }

    const start = (symbol.declarationRange ?? symbol.range).start;
    const head = text.slice(start, symbol.nameRange.start);
    const fn = head.search(/\bfunction\b/);
    if (symbol.kind === 'method') {
      // Before the name (or the `*` of a generator).
      const star = head.trimEnd().endsWith('*')
        ? start + head.trimEnd().length - 1
        : symbol.nameRange.start;
      return { ok: true, edits: [{ start: star, end: star, text: 'async ' }] };
    }

    if (fn === -1) {
      return { ok: false, error: 'Change async in the code of this function.' };
    }

    return {
      ok: true,
      edits: [{ start: start + fn, end: start + fn, text: 'async ' }],
    };
  }

  if (modifier === 'export') {
    if (symbol.scope !== '' || symbol.kind === 'local') {
      return { ok: false, error: 'Only module declarations can be exported.' };
    }

    if (!enabled) {
      return removeModifier(
        text,
        symbol,
        symbol.modifiers.includes('export default')
          ? 'export default'
          : 'export'
      );
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

    // `private static async name()`, `static readonly name`: static goes
    // before readonly, async, get and set; readonly right before the name.
    const lineStart = text.lastIndexOf('\n', symbol.nameRange.start - 1) + 1;
    const head = text.slice(lineStart, symbol.nameRange.start);
    const later = head.search(/\b(?:readonly|async|get|set)\b|\*/);
    const at =
      modifier === 'static' && later !== -1
        ? lineStart + later
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
  template: (template, indent, unit) => {
    switch (template.type) {
      case 'flow': {
        return {
          forEach: `for (const item of []) {\n${indent}}`,
          forRange: `for (let i = 0; i < 10; i++) {\n${indent}}`,
          while: `while (false) {\n${indent}}`,
          switch: `switch (undefined) {\n${indent}${unit}case 0:\n${indent}${unit}${unit}break;\n${indent}${unit}default:\n${indent}${unit}${unit}break;\n${indent}}`,
          try: `try {\n${indent}} catch (error) {\n${indent}}`,
          throw: 'throw new Error();',
          break: 'break;',
          continue: 'continue;',
        }[template.flow];
      }

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

        // `let x;` needs no value (its value pin inserts one); `const` does.
        return template.declaration === 'none'
          ? `${name} = undefined;`
          : template.declaration === 'let'
            ? `let ${name};`
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

/** The empty text default (`''`) in the file's quotes. */
function withQuotes(text: string, op: GraphOp): GraphOp {
  if (op.type === 'withImport') {
    return { ...op, op: withQuotes(text, op.op) };
  }

  return op.type === 'setSymbolType' && op.defaultValue === "''"
    ? { ...op, defaultValue: quoteOf(text).repeat(2) }
    : op;
}

export function applyTypeScriptOp(
  text: string,
  op: GraphOp,
  fileName?: string,
  options?: ParseOptions
): OpResult {
  return applyTextOp(
    text,
    parseTypeScript(text, fileName, options),
    withQuotes(text, op),
    {
      ...TYPESCRIPT_SYNTAX,
      declarations: declarations(text, fileName),
    }
  );
}
