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

const KINDS = ['var', 'const'];

export const GDSCRIPT_TYPES: TypeSystemInfo = {
  primitives: [
    { name: 'bool', dataType: 'bool', defaultValue: 'false' },
    { name: 'int', dataType: 'number', defaultValue: '0' },
    { name: 'float', dataType: 'number', defaultValue: '0.0' },
    { name: 'String', dataType: 'string', defaultValue: '""' },
    { name: 'StringName', dataType: 'string', defaultValue: '&""' },
    { name: 'NodePath', dataType: 'string', defaultValue: '^""' },
    { name: 'Vector2', dataType: 'Vector2', defaultValue: 'Vector2.ZERO' },
    { name: 'Vector2i', dataType: 'Vector2i', defaultValue: 'Vector2i.ZERO' },
    { name: 'Vector3', dataType: 'Vector3', defaultValue: 'Vector3.ZERO' },
    { name: 'Vector3i', dataType: 'Vector3i', defaultValue: 'Vector3i.ZERO' },
    { name: 'Color', dataType: 'Color', defaultValue: 'Color.WHITE' },
    { name: 'Rect2', dataType: 'Rect2', defaultValue: 'Rect2()' },
    {
      name: 'Transform2D',
      dataType: 'Transform2D',
      defaultValue: 'Transform2D.IDENTITY',
    },
    { name: 'Dictionary', dataType: 'object', defaultValue: '{}' },
    { name: 'Node', dataType: 'Node', defaultValue: 'null' },
    { name: 'Resource', dataType: 'Resource', defaultValue: 'null' },
    { name: 'Variant', dataType: 'any', defaultValue: 'null' },
  ],
  array: 'Array[T]',
  map: 'Dictionary[K, V]',
  containerDefaults: { array: '[]', map: '{}' },
  modifiers: {
    variable: { keywords: KINDS, flags: ['@export', '@onready', 'static'] },
    constant: { keywords: KINDS },
    local: { keywords: KINDS },
    member: { keywords: KINDS },
  },
};

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
      return { ok: false, error: 'A const needs a value; set one first.' };
    }

    if (
      modifier === 'const' &&
      symbol.modifiers.some((m) => m.startsWith('@') || m === 'static')
    ) {
      return {
        ok: false,
        error: 'Remove @export, @onready and static before making it const.',
      };
    }

    return replaceKeyword(text, symbol, KINDS, modifier);
  }

  if (['@export', '@onready', 'static'].includes(modifier)) {
    if (symbol.kind === 'local' || symbol.scope !== '') {
      return {
        ok: false,
        error: `Only member variables of the script can be ${modifier}.`,
      };
    }

    if (!enabled) {
      return removeModifier(text, symbol, modifier);
    }

    if (symbol.modifiers.includes('const')) {
      return { ok: false, error: `A const cannot be ${modifier}.` };
    }

    // Annotations come first, `static` right before `var`.
    const head = text.slice(symbol.range.start, symbol.nameRange.start);
    const keyword = head.search(/\bvar\b/);
    const at =
      modifier === 'static' && keyword !== -1
        ? symbol.range.start + keyword
        : symbol.range.start;
    return { ok: true, edits: [{ start: at, end: at, text: `${modifier} ` }] };
  }

  return { ok: false, error: `Unknown modifier ${modifier}.` };
}

const DECLARATIONS: DeclarationSyntax = {
  typeSystem: GDSCRIPT_TYPES,
  validType: (type) =>
    /^[A-Za-z_][\w.]*(?:\[\s*[A-Za-z_][\w.]*\s*(?:,\s*[A-Za-z_][\w.]*\s*)?\])?$/.test(
      type
    )
      ? undefined
      : `"${type}" is not a valid GDScript type.`,
  string: (value) => JSON.stringify(value),
  booleans: { true: 'true', false: 'false' },
  valueRequired: (symbol) => symbol.modifiers.includes('const'),
  setModifier,
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
