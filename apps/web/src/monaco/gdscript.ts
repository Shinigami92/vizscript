import type * as Monaco from 'monaco-editor';

/** Monaco has no built-in GDScript support: a Monarch grammar for it. */

const KEYWORDS = [
  'and',
  'as',
  'assert',
  'await',
  'break',
  'breakpoint',
  'class',
  'class_name',
  'const',
  'continue',
  'elif',
  'else',
  'enum',
  'extends',
  'for',
  'func',
  'if',
  'in',
  'is',
  'match',
  'not',
  'or',
  'pass',
  'preload',
  'return',
  'self',
  'signal',
  'static',
  'super',
  'var',
  'void',
  'when',
  'while',
  'yield',
];

const CONSTANTS = ['true', 'false', 'null', 'PI', 'TAU', 'INF', 'NAN'];

const BUILTIN_TYPES = [
  'bool',
  'int',
  'float',
  'String',
  'StringName',
  'NodePath',
  'Array',
  'Dictionary',
  'Callable',
  'Signal',
  'Variant',
  'Object',
  'Vector2',
  'Vector2i',
  'Vector3',
  'Vector3i',
  'Vector4',
  'Color',
  'Rect2',
  'Transform2D',
  'Transform3D',
  'Basis',
  'Quaternion',
  'Plane',
  'AABB',
  'RID',
];

export const GDSCRIPT_LANGUAGE: Monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  tokenPostfix: '.gd',
  keywords: KEYWORDS,
  constants: CONSTANTS,
  types: BUILTIN_TYPES,
  brackets: [
    { open: '(', close: ')', token: 'delimiter.parenthesis' },
    { open: '[', close: ']', token: 'delimiter.square' },
    { open: '{', close: '}', token: 'delimiter.curly' },
  ],
  tokenizer: {
    root: [
      [/##.*$/, 'comment.doc'],
      [/#.*$/, 'comment'],
      [/@[A-Za-z_]\w*/, 'annotation'],
      [/\$"[^"]*"|\$[A-Za-z_%][\w/%]*/, 'variable.predefined'],
      [/%[A-Za-z_]\w*/, 'variable.predefined'],
      [/(func)(\s+)([A-Za-z_]\w*)/, ['keyword', '', 'entity.name.function']],
      [
        /[A-Za-z_]\w*/,
        {
          cases: {
            '@keywords': 'keyword',
            '@constants': 'constant',
            '@types': 'type',
            '[A-Z][A-Z0-9_]*': 'constant',
            '[A-Z]\\w*': 'type',
            '@default': 'identifier',
          },
        },
      ],
      [/0[xX][0-9a-fA-F_]+|0[bB][01_]+/, 'number.hex'],
      [
        /\d[\d_]*\.[\d_]*([eE][-+]?\d+)?|\.\d[\d_]*([eE][-+]?\d+)?/,
        'number.float',
      ],
      [/\d[\d_]*([eE][-+]?\d+)?/, 'number'],
      [/[&^]?r?"""/, 'string', '@tripleDouble'],
      [/[&^]?r?'''/, 'string', '@tripleSingle'],
      [/[&^]?r?"/, 'string', '@double'],
      [/[&^]?r?'/, 'string', '@single'],
      [/[{}()[\]]/, '@brackets'],
      [/->|:=|[-+*/%=<>!&|^~]=?|\*\*|<<|>>/, 'operator'],
      [/[;,.:]/, 'delimiter'],
    ],
    double: [
      [/[^\\"]+/, 'string'],
      [/\\./, 'string.escape'],
      [/"/, 'string', '@pop'],
    ],
    single: [
      [/[^\\']+/, 'string'],
      [/\\./, 'string.escape'],
      [/'/, 'string', '@pop'],
    ],
    tripleDouble: [
      [/[^"\\]+/, 'string'],
      [/\\./, 'string.escape'],
      [/"""/, 'string', '@pop'],
      [/"/, 'string'],
    ],
    tripleSingle: [
      [/[^'\\]+/, 'string'],
      [/\\./, 'string.escape'],
      [/'''/, 'string', '@pop'],
      [/'/, 'string'],
    ],
  },
};

export const GDSCRIPT_CONFIGURATION: Monaco.languages.LanguageConfiguration = {
  comments: { lineComment: '#' },
  brackets: [
    ['(', ')'],
    ['[', ']'],
    ['{', '}'],
  ],
  autoClosingPairs: [
    { open: '(', close: ')' },
    { open: '[', close: ']' },
    { open: '{', close: '}' },
    { open: '"', close: '"', notIn: ['string'] },
    { open: "'", close: "'", notIn: ['string'] },
  ],
  surroundingPairs: [
    { open: '(', close: ')' },
    { open: '[', close: ']' },
    { open: '{', close: '}' },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
  indentationRules: {
    increaseIndentPattern: /^\s*.*:\s*(#.*)?$/,
    decreaseIndentPattern: /^\s*(elif|else)\b.*:/,
  },
  folding: { offSide: true },
};

export function registerGDScript(monaco: typeof Monaco): void {
  if (monaco.languages.getLanguages().some((l) => l.id === 'gdscript')) {
    return;
  }

  monaco.languages.register({
    id: 'gdscript',
    extensions: ['.gd'],
    aliases: ['GDScript', 'gdscript'],
  });
  monaco.languages.setMonarchTokensProvider('gdscript', GDSCRIPT_LANGUAGE);
  monaco.languages.setLanguageConfiguration('gdscript', GDSCRIPT_CONFIGURATION);
}
