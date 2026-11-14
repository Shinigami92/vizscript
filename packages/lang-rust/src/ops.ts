import type {
  DataType,
  DeclarationSyntax,
  GraphDocument,
  GraphOp,
  OpResult,
  ParseOptions,
  PinLiteral,
  ScriptSymbol,
  StatementSyntax,
  TextEdit,
  TypeSystemInfo,
} from '@vizscript/core';
import {
  applyTextOp,
  checkName,
  classOf,
  deleteSymbol,
  lineIndent,
  removeModifier,
  replaceKeyword,
} from '@vizscript/core';
import type { ImplItem, Item, StructItem } from './ast';
import { CONVERSIONS } from './conversions';
import { parseRust } from './convert';
import { addRustImport } from './imports';
import { parseRustDocument } from './lower';
import { renameRustSymbol, rustCallSites } from './rename';
import { splitString } from './string-literal';

const IDENTIFIER = /^(?:r#)?[A-Za-z_]\w*$/;

const KEYWORDS = new Set(
  (
    'as async await break const continue crate dyn else enum extern false ' +
    'fn for if impl in let loop match mod move mut pub ref return self Self ' +
    'static struct super trait true type unsafe use where while abstract ' +
    'become box do final macro override priv typeof unsized virtual yield try gen'
  ).split(' ')
);

/** Qualifiers of a function, in the order Rust wants them. */
const FN_QUALIFIERS = ['const', 'async', 'unsafe'];

function escape(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\t', '\\t');
}

/** Quotes a string or char literal, keeping its prefix and raw style. */
function quote(value: string, literal: PinLiteral): string {
  const parts = splitString(literal.raw);
  if (parts.raw) {
    // Raw strings need more `#` when the value contains `"#…`.
    let hashes = parts.close.slice(1);
    while (value.includes(`"${hashes}`)) {
      hashes += '#';
    }

    return `${parts.prefix}${hashes}"${value}"${hashes}`;
  }

  if (parts.close === "'") {
    const char = value === "'" ? "\\'" : value.replaceAll('\\', '\\\\');
    return `${parts.prefix}'${char}'`;
  }

  return `${parts.prefix}"${escape(value)}"`;
}

export const RUST_TYPES: TypeSystemInfo = {
  callback: '|| {}',
  conversions: CONVERSIONS,
  keywords: [...KEYWORDS],
  globals: [
    'println!',
    'print!',
    'eprintln!',
    'format!',
    'vec!',
    'panic!',
    'assert!',
    'assert_eq!',
    'dbg!',
    'todo!',
    'String::new',
    'String::from',
    'Vec::new',
    'Vec::with_capacity',
    'Box::new',
    'Some',
    'Ok',
    'Err',
    'Default::default',
    'std::mem::swap',
    'std::mem::take',
  ],
  primitives: [
    { name: 'i32', dataType: 'number', defaultValue: '0' },
    { name: 'i64', dataType: 'number', defaultValue: '0' },
    { name: 'u32', dataType: 'number', defaultValue: '0' },
    { name: 'u64', dataType: 'number', defaultValue: '0' },
    { name: 'usize', dataType: 'number', defaultValue: '0' },
    { name: 'f32', dataType: 'number', defaultValue: '0.0' },
    { name: 'f64', dataType: 'number', defaultValue: '0.0' },
    { name: 'bool', dataType: 'bool', defaultValue: 'false' },
    { name: 'char', dataType: 'string', defaultValue: "' '" },
    { name: 'String', dataType: 'string', defaultValue: 'String::new()' },
    { name: '&str', dataType: 'string', defaultValue: '""' },
  ],
  array: 'Vec<T>',
  map: 'HashMap<K, V>',
  set: 'HashSet<T>',
  optional: 'Option<T>',
  containerDefaults: {
    array: 'Vec::new()',
    map: 'HashMap::new()',
    set: 'HashSet::new()',
  },
  placeholder: 'todo!()',
  expressions: [
    {
      label: '+ (add)',
      category: 'Math',
      template: '$1 + $2',
      keywords: 'add plus sum',
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
      label: '- (negate)',
      category: 'Math',
      template: '-$1',
      result: 'number',
      keywords: 'negate negative',
    },
    {
      label: '== (equal)',
      category: 'Comparison',
      template: '$1 == $2',
      result: 'bool',
      keywords: 'equal equals',
    },
    {
      label: '!= (not equal)',
      category: 'Comparison',
      template: '$1 != $2',
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
      label: 'is_some',
      category: 'Comparison',
      template: '$1.is_some()',
      result: 'bool',
      keywords: 'option some none present',
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
      label: 'Select (if a { b } else { c })',
      category: 'Logic',
      template: 'if $1 { $2 } else { $3 }',
      keywords: 'select ternary conditional if',
    },
    {
      label: 'Join text',
      category: 'Text',
      template: 'format!("{}{}", $1, $2)',
      result: 'string',
      keywords: 'join concat append format',
    },
    {
      label: 'To text',
      category: 'Text',
      template: '$1.to_string()',
      result: 'string',
      keywords: 'string convert text',
    },
    {
      label: 'Clone',
      category: 'Values',
      template: '$1.clone()',
      keywords: 'clone copy',
    },
    {
      label: 'Text',
      category: 'Values',
      template: '""',
      result: 'string',
      keywords: 'string literal text str',
    },
    {
      label: 'Number',
      category: 'Values',
      template: '0',
      result: 'number',
      keywords: 'number literal integer',
    },
    {
      label: 'Boolean',
      category: 'Values',
      template: 'false',
      result: 'bool',
      keywords: 'boolean literal true false',
    },
    {
      label: 'None',
      category: 'Values',
      template: 'None',
      keywords: 'none null nothing option',
    },
    {
      label: 'Make Vec',
      category: 'Values',
      template: 'vec![]',
      result: 'array',
      keywords: 'vec list array',
    },
  ],
  noParameterDefaults: true,
  noFieldValues: true,
  requiredType: 'i32',
  flow: ['forEach', 'forRange', 'while', 'switch', 'break', 'continue'],
  modifiers: {
    variable: { keywords: ['static', 'const'], flags: ['pub'] },
    constant: { keywords: ['const', 'static'], flags: ['pub'] },
    member: { flags: ['pub'] },
    local: { flags: ['mut'] },
    function: { flags: ['pub', 'async', 'const', 'unsafe'] },
    method: { flags: ['pub', 'async', 'const', 'unsafe'] },
  },
};

/** Start of a declaration's line (after attributes), where `pub` goes. */
function headOf(text: string, symbol: ScriptSymbol): number {
  const lineStart = text.lastIndexOf('\n', symbol.nameRange.start - 1) + 1;
  const indent = lineIndent(text, lineStart);
  return Math.max(lineStart + indent.length, symbol.range.start);
}

function setModifier(
  text: string,
  _doc: GraphDocument,
  symbol: ScriptSymbol,
  modifier: string,
  enabled: boolean
): OpResult {
  if (
    modifier === 'static' ||
    (modifier === 'const' &&
      symbol.kind !== 'function' &&
      symbol.kind !== 'method')
  ) {
    if (!enabled) {
      return { ok: true, edits: [] };
    }

    if (symbol.scope !== '') {
      return {
        ok: false,
        error: 'Only items of the module are const or static.',
      };
    }

    if (!symbol.type) {
      return { ok: false, error: `A ${modifier} needs a type; set one first.` };
    }

    return replaceKeyword(text, symbol, ['const', 'static'], modifier);
  }

  if (modifier === 'pub') {
    if (symbol.kind === 'local') {
      return { ok: false, error: 'Local variables cannot be pub.' };
    }

    if (!enabled) {
      return removeModifier(text, symbol, 'pub');
    }

    if (symbol.modifiers.some((m) => m.startsWith('pub'))) {
      return { ok: true, edits: [] };
    }

    const at = headOf(text, symbol);
    return { ok: true, edits: [{ start: at, end: at, text: 'pub ' }] };
  }

  if (modifier === 'mut') {
    if (symbol.kind !== 'local') {
      return {
        ok: false,
        error: 'Only local variables are switched to mut here.',
      };
    }

    if (!enabled) {
      return removeModifier(text, symbol, 'mut');
    }

    const at = symbol.nameRange.start;
    return { ok: true, edits: [{ start: at, end: at, text: 'mut ' }] };
  }

  if (FN_QUALIFIERS.includes(modifier)) {
    if (symbol.kind !== 'function' && symbol.kind !== 'method') {
      return { ok: false, error: `Only functions can be ${modifier}.` };
    }

    // `pub const async unsafe fn`: rewrite the qualifiers in their order.
    const start = headOf(text, symbol);
    const head = text.slice(start, symbol.nameRange.start);
    const fn = head.search(/\bfn\b/);
    if (fn === -1) {
      return { ok: false, error: `Cannot find the fn of ${symbol.name}.` };
    }

    const before = head.slice(0, fn);
    const words = before.trim().split(/\s+/).filter(Boolean);
    const vis = words.filter((w) => w.startsWith('pub'));
    const rest = words.filter(
      (w) => !w.startsWith('pub') && !FN_QUALIFIERS.includes(w)
    );
    const qualifiers = FN_QUALIFIERS.filter((q) =>
      q === modifier ? enabled : words.includes(q)
    );
    const next = [...vis, ...qualifiers, ...rest].join(' ');
    return {
      ok: true,
      edits: [
        {
          start,
          end: start + fn,
          text: next ? `${next} ` : '',
        },
      ],
    };
  }

  return { ok: false, error: `Unknown modifier ${modifier}.` };
}

const DECLARATIONS: DeclarationSyntax = {
  typeSystem: RUST_TYPES,
  validType: (type) => {
    const { diagnostics, items } = parseRust(`type X = ${type};`);
    return diagnostics.length > 0 ||
      items.length !== 1 ||
      items[0]?.type !== 'TypeAlias'
      ? `"${type}" is not a valid Rust type.`
      : undefined;
  },
  string: (value) => `"${escape(value)}"`,
  booleans: { true: 'true', false: 'false' },
  // `const` and `static` always need a value; `let x;` doesn't.
  valueRequired: (symbol) =>
    symbol.kind === 'constant' ||
    (symbol.kind === 'variable' && symbol.scope === ''),
  returnArrow: ' -> ',
  callSites: (text, doc, symbol) =>
    rustCallSites(text, doc.symbols ?? [], symbol),
  setModifier,
  identifier: IDENTIFIER,
  keywords: KEYWORDS,
  defaultIndent: '    ',
  blankLines: 1,
  bracedClasses: true,
  header:
    /^(?:(?:pub(?:\([^)]*\))?\s+)?use\b|(?:pub\s+)?mod\s+\w+\s*;|extern\s+crate\b|#!\[|\/\/!)/,
  typeDeclaration: (name) => `struct ${name} {\n}`,
  fn: (name, _unit, method) =>
    method ? `fn ${name}(&self) {\n}` : `fn ${name}() {\n}`,
  variable: (name, { constant, member }) => {
    if (member) {
      return `${name}: i32,`;
    }

    return constant ? `const ${name}: i32 = 0;` : `static ${name}: i32 = 0;`;
  },
  extract: {
    fn: (name, params, body, { method, isStatic, isAsync, returns }) => {
      const list = [
        ...(method && !isStatic ? ['&self'] : []),
        ...params.map((p) => `${p.name}: ${p.type ?? '_'}`),
      ].join(', ');
      const result = returns
        ? ` -> ${returns.type ?? rustTypeOf(returns.dataType)}`
        : '';
      return `${isAsync ? 'async ' : ''}fn ${name}(${list})${result} {\n${body}\n}`;
    },
    call: (callee, args, { isAsync, output }) => {
      const store = output
        ? `${output.declare ? 'let ' : ''}${output.name} = `
        : '';
      return `${store}${callee}(${args.join(', ')})${isAsync ? '.await' : ''};`;
    },
    // The last expression of a block is its value.
    returnValue: (name) => name,
    method: (name, className, isStatic) =>
      isStatic ? `${className}::${name}` : `self.${name}`,
  },
  addImport: (text, doc, request) =>
    addRustImport(text, doc, request, DECLARATIONS),
  rename: (text, doc, symbol, name) =>
    renameRustSymbol(text, doc.symbols ?? [], symbol, name),
};

export const RUST_SYNTAX: StatementSyntax = {
  placeholder: 'todo!()',
  emptyBody: '{}',
  bindingName: (hint) =>
    `${hint
      .replaceAll(/([a-z0-9])([A-Z])/g, '$1_$2')
      .toLowerCase()
      .replaceAll(/\W/g, '')}_result`,
  declare: (name, expr) => `let ${name} = ${expr};`,
  declarePrefix: (name) => `let ${name} = `,
  quote,
  // `2` where `1.0` was: an integer literal does not fit a float.
  number: (value, previous) =>
    /^-?\d[\d_]*$/.test(value) && /^-?\d[\d_]*(?:\.\d|[eE])/.test(previous)
      ? `${value}.0`
      : value,
  // Statements only live in functions; the file holds items.
  appendToFile: false,
  statementEnd: ';',
  declarations: DECLARATIONS,
  comment: {
    line: '//',
    region: (title) => (title ? `// region: ${title}` : '// region'),
    endRegion: '// endregion',
    doc: '///',
  },
  template: (template, indent, unit) => {
    switch (template.type) {
      case 'flow': {
        const flows: Partial<Record<string, string>> = {
          forEach: `for item in [0; 0] {\n${indent}}`,
          forRange: `for i in 0..10 {\n${indent}}`,
          while: `while false {\n${indent}}`,
          switch: `match () {\n${indent}${unit}_ => {}\n${indent}}`,
          break: 'break;',
          continue: 'continue;',
        };
        return flows[template.flow];
      }

      case 'call': {
        const callee = template.callee.trim();
        if (!/^[\w:.]+!?$/.test(callee)) {
          return undefined;
        }

        return `${callee}(${(template.args ?? []).join(', ')});`;
      }

      case 'setVar': {
        const name = template.name.trim();
        if (template.declaration === 'none') {
          return /^(?:self\.)?[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(name)
            ? `${name} = ${template.value?.trim() || 'todo!()'};`
            : undefined;
        }

        // `let x;` needs no value (its value pin inserts one).
        return IDENTIFIER.test(name) ? `let ${name};` : undefined;
      }

      case 'branch': {
        return `if true {\n${indent}}`;
      }

      case 'return': {
        // `return;` does not compile in a function with a result.
        return template.value ? 'return todo!();' : 'return;';
      }

      case 'value': {
        const expression = template.expression.trim();
        return expression ? `${expression};` : undefined;
      }

      default: {
        return undefined;
      }
    }
  },
};

/**
 * Rust type of a pin type, where it is clear: `Item[]` → `Vec<Item>`.
 * Numbers have several types; unclear ones become `_`, which the compiler
 * asks to replace.
 */
function rustTypeOf(dataType: DataType): string {
  if (dataType.endsWith('[]')) {
    const inner = rustTypeOf(dataType.slice(0, -2));
    return inner === '_' ? '_' : `Vec<${inner}>`;
  }

  if (dataType === 'string') {
    return 'String';
  }

  if (dataType === 'bool') {
    return 'bool';
  }

  return /^[A-Z]\w*$/.test(dataType) ? dataType : '_';
}

/**
 * A type cannot outlive its `impl` blocks: deleting a struct, enum or trait
 * also deletes `impl Name`, `impl Trait for Name` and `impl Name for T`.
 */
function withImpls(
  text: string,
  doc: GraphDocument,
  id: string,
  result: Extract<OpResult, { ok: true }>
): OpResult {
  const symbol = doc.symbols?.find((s) => s.id === id);
  if (
    !symbol ||
    symbol.scope !== '' ||
    !['class', 'enum', 'type'].includes(symbol.kind)
  ) {
    return result;
  }

  const impls = parseRust(text).items.filter(
    (item): item is ImplItem =>
      item.type === 'Impl' &&
      (item.target === symbol.name ||
        item.trait?.split('::').at(-1) === symbol.name)
  );
  const edits = [...result.edits];
  for (const impl of impls) {
    const block: ScriptSymbol = {
      id: 'impl:block',
      kind: 'type',
      name: 'impl',
      scope: '',
      range: { start: impl.start, end: impl.end },
      nameRange: { start: impl.start, end: impl.start },
      dataType: 'any',
      modifiers: [],
    };
    const removed = deleteSymbol(
      text,
      { ...doc, symbols: [block] },
      block.id,
      RUST_SYNTAX.comment,
      RUST_SYNTAX.emptyBody
    );
    if (removed.ok) {
      edits.push(
        ...removed.edits.filter((e) =>
          edits.every((o) => e.end <= o.start || e.start >= o.end)
        )
      );
    }
  }

  return { ok: true, edits };
}

/** The inherent impl (`impl Point { … }`, not a trait impl) of a type. */
function inherentImpl(
  items: ReadonlyArray<Item>,
  type: string
): ImplItem | undefined {
  for (const item of items) {
    if (item.type === 'Impl' && item.target === type && !item.trait) {
      return item;
    }

    if (item.type === 'Mod' && item.items) {
      const nested = inherentImpl(item.items, type);
      if (nested) {
        return nested;
      }
    }
  }

  return undefined;
}

function findStruct(
  items: ReadonlyArray<Item>,
  name: string
): StructItem | undefined {
  for (const item of items) {
    if (item.type === 'Struct' && item.name === name) {
      return item;
    }

    if (item.type === 'Mod' && item.items) {
      const nested = findStruct(item.items, name);
      if (nested) {
        return nested;
      }
    }
  }

  return undefined;
}

function detectUnit(text: string): string {
  const match = text.match(/^( +|\t)\S/m);
  return match?.[1] === '\t' ? '\t' : '    ';
}

/** A method goes into the type's `impl` block (a new one after the type). */
function addMethod(
  text: string,
  doc: GraphDocument,
  type: string,
  name: string
): OpResult {
  const error = checkName(doc, DECLARATIONS, type, name);
  if (error) {
    return { ok: false, error };
  }

  const cls = classOf(doc, type);
  if (!cls) {
    return { ok: false, error: `There is no struct ${type}.` };
  }

  const { items } = parseRust(text);
  const unit = detectUnit(text);
  const impl = inherentImpl(items, cls.name);
  if (impl) {
    const typeIndent = lineIndent(text, impl.start);
    const indent = `${typeIndent}${unit}`;
    const method = `fn ${name}(&self) {\n${indent}}`;
    const body = text.slice(impl.open, impl.close);
    if (body.trim() === '') {
      return {
        ok: true,
        edits: [
          {
            start: impl.open,
            end: impl.close,
            text: `\n${indent}${method}\n${typeIndent}`,
          },
        ],
      };
    }

    const lineStart = text.lastIndexOf('\n', impl.close - 1) + 1;
    const ownLine = text.slice(lineStart, impl.close).trim() === '';
    const edit: TextEdit = ownLine
      ? { start: lineStart, end: lineStart, text: `\n${indent}${method}\n` }
      : {
          start: impl.close,
          end: impl.close,
          text: `\n${indent}${method}\n${typeIndent}`,
        };
    return { ok: true, edits: [edit] };
  }

  const indent = lineIndent(text, cls.range.start);
  const block = `\n\n${indent}impl ${cls.name} {\n${indent}${unit}fn ${name}(&self) {\n${indent}${unit}}\n${indent}}`;
  return {
    ok: true,
    edits: [{ start: cls.range.end, end: cls.range.end, text: block }],
  };
}

/** A field goes at the end of the struct's `{ … }`, after a comma. */
function addField(
  text: string,
  doc: GraphDocument,
  type: string,
  name: string
): OpResult {
  const error = checkName(doc, DECLARATIONS, type, name);
  if (error) {
    return { ok: false, error };
  }

  const cls = classOf(doc, type);
  const { items } = parseRust(text);
  const struct = cls ? findStruct(items, cls.name) : undefined;
  if (!struct || struct.open === undefined || struct.close === undefined) {
    return {
      ok: false,
      error: `${type} has no { fields } (tuple and unit structs are changed in the code).`,
    };
  }

  const unit = detectUnit(text);
  const typeIndent = lineIndent(text, struct.start);
  const last = struct.fields.at(-1);
  const indent = last ? lineIndent(text, last.start) : `${typeIndent}${unit}`;
  const field = `${name}: i32,`;
  if (!last) {
    return {
      ok: true,
      edits: [
        {
          start: struct.open,
          end: struct.close,
          text: `\n${indent}${field}\n${typeIndent}`,
        },
      ],
    };
  }

  const after = text.slice(last.end, struct.close);
  const comma = after.match(/^\s*,/);
  const at = comma ? last.end + comma[0].length : last.end;
  return {
    ok: true,
    edits: [
      { start: at, end: at, text: `${comma ? '' : ','}\n${indent}${field}` },
    ],
  };
}

export function applyRustOp(
  text: string,
  op: GraphOp,
  fileName?: string,
  options?: ParseOptions
): OpResult {
  const doc = parseRustDocument(text, fileName, options);
  if (op.type === 'addFunction' && op.scope !== '') {
    return addMethod(text, doc, op.scope, op.name);
  }

  if (op.type === 'addVariable' && op.scope !== '' && !op.local) {
    return addField(text, doc, op.scope, op.name);
  }

  const result = applyTextOp(text, doc, op, RUST_SYNTAX);
  return op.type === 'deleteSymbol' && result.ok
    ? withImpls(text, doc, op.symbol, result)
    : result;
}
