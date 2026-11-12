import { parse } from '@babel/parser';
import type * as t from '@babel/types';
import type { ModuleReference } from '@vizscript/core';

const EXTENSIONS = [
  '.ts',
  '.tsx',
  '.d.ts',
  '.js',
  '.jsx',
  '.mts',
  '.mjs',
  '.cts',
  '.cjs',
  '.json',
  '.vue',
];

/** TypeScript's ESM convention: `./x.js` imports `./x.ts`. */
const SOURCE_FOR: Record<string, ReadonlyArray<string>> = {
  '.js': ['.ts', '.tsx', '.d.ts', '.jsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts', '.d.mts'],
  '.cjs': ['.cts', '.d.cts'],
};

/** Candidate files of a relative module specifier, most likely first. */
export function moduleCandidates(specifier: string): string[] {
  const path = specifier.replace(/[?#].*$/, '').replace(/\/$/, '');
  const candidates: string[] = [];
  const extension = path.match(/\.[a-z]+$/i)?.[0]?.toLowerCase();
  if (extension) {
    const base = path.slice(0, -extension.length);
    candidates.push(
      path,
      ...(SOURCE_FOR[extension] ?? []).map((ext) => base + ext)
    );
  }

  if (!specifier.endsWith('/')) {
    candidates.push(...EXTENSIONS.map((ext) => path + ext));
  }

  candidates.push(...EXTENSIONS.map((ext) => `${path}/index${ext}`));
  return [...new Set(candidates)];
}

function isRelative(specifier: string): boolean {
  return /^\.\.?(?:\/|$)/.test(specifier);
}

function isStringLiteral(node: unknown): node is t.StringLiteral {
  return (node as t.Node | null)?.type === 'StringLiteral';
}

function isImportMetaUrl(node: t.Node | undefined): boolean {
  return (
    node?.type === 'MemberExpression' &&
    node.object.type === 'MetaProperty' &&
    node.object.meta.name === 'import' &&
    node.property.type === 'Identifier' &&
    node.property.name === 'url'
  );
}

/** The module specifier a node refers to, if any. */
function specifierOf(node: t.Node): t.StringLiteral | undefined {
  switch (node.type) {
    case 'ImportDeclaration':
    case 'ExportAllDeclaration':
    case 'ExportNamedDeclaration': {
      return node.source ?? undefined;
    }

    case 'ImportExpression': {
      return isStringLiteral(node.source) ? node.source : undefined;
    }

    case 'CallExpression': {
      const [first] = node.arguments;
      const callee = node.callee;
      const isLoader =
        callee.type === 'Import' ||
        (callee.type === 'Identifier' && callee.name === 'require');
      return isLoader && isStringLiteral(first) ? first : undefined;
    }

    // `new URL('./worker.ts', import.meta.url)`
    case 'NewExpression': {
      const [first, second] = node.arguments;
      return node.callee.type === 'Identifier' &&
        node.callee.name === 'URL' &&
        isStringLiteral(first) &&
        isImportMetaUrl(second)
        ? first
        : undefined;
    }

    // `import x = require('./x')`
    case 'TSExternalModuleReference': {
      return node.expression;
    }

    // `import('./x').Type`
    case 'TSImportType': {
      return isStringLiteral(node.source) ? node.source : undefined;
    }

    default: {
      return undefined;
    }
  }
}

const SKIPPED_KEYS = new Set([
  'loc',
  'leadingComments',
  'trailingComments',
  'innerComments',
  'extra',
]);

type Visit = (node: t.Node, parent: t.Node | undefined, key: string) => void;

function walk(node: unknown, visit: Visit, parent?: t.Node, key = ''): void {
  if (Array.isArray(node)) {
    for (const child of node) {
      walk(child, visit, parent, key);
    }

    return;
  }

  if (!node || typeof node !== 'object' || !('type' in node)) {
    return;
  }

  const current = node as t.Node;
  visit(current, parent, key);
  for (const [childKey, value] of Object.entries(node)) {
    if (!SKIPPED_KEYS.has(childKey) && value && typeof value === 'object') {
      walk(value, visit, current, childKey);
    }
  }
}

function rangeOf(node: t.Node): { start: number; end: number } | undefined {
  return typeof node.start === 'number' && typeof node.end === 'number'
    ? { start: node.start, end: node.end }
    : undefined;
}

/** A name bound by an import (`import { a as b } from './x'`). */
interface Binding {
  specifier: string;
  /** Exported name in the module; `undefined` for default / namespace. */
  imported: string | undefined;
  namespace: boolean;
  typeOnly: boolean;
}

function importedName(specifier: t.ImportSpecifier): string {
  return specifier.imported.type === 'Identifier'
    ? specifier.imported.name
    : specifier.imported.value;
}

/** Whether an identifier is a name (property key, member) not a variable. */
function isNameOnly(parent: t.Node | undefined, key: string): boolean {
  if (!parent) {
    return false;
  }

  switch (parent.type) {
    case 'MemberExpression':
    case 'OptionalMemberExpression':
    case 'TSQualifiedName': {
      return (
        (key === 'property' || key === 'right') &&
        !('computed' in parent && parent.computed)
      );
    }

    case 'ObjectProperty':
    case 'ObjectMethod':
    case 'ClassMethod':
    case 'ClassProperty':
    case 'ClassPrivateProperty':
    case 'TSPropertySignature':
    case 'TSMethodSignature': {
      return key === 'key' && !('computed' in parent && parent.computed);
    }

    case 'ImportSpecifier':
    case 'ImportDefaultSpecifier':
    case 'ImportNamespaceSpecifier':
    case 'ExportSpecifier':
    case 'LabeledStatement':
    case 'BreakStatement':
    case 'ContinueStatement': {
      return true;
    }

    default: {
      return false;
    }
  }
}

/**
 * Relative module paths (imports, exports, `require`, …) of a file, and the
 * uses of names imported from them (pointing at their definitions).
 */
export function typeScriptReferences(
  text: string,
  fileName = 'file.ts'
): ModuleReference[] {
  const isJsLike = /\.[cm]?jsx?$/i.test(fileName);
  const isJsx = /\.[jt]sx$/i.test(fileName);
  let program: t.Program;
  try {
    program = parse(text, {
      sourceType: 'unambiguous',
      errorRecovery: true,
      plugins: [
        ...(isJsLike ? [] : [['typescript', {}] as ['typescript', object]]),
        ...(isJsx || isJsLike ? ['jsx' as const] : []),
      ],
    }).program;
  } catch {
    return [];
  }

  const references: ModuleReference[] = [];
  const bindings = new Map<string, Binding>();
  for (const statement of program.body) {
    if (
      statement.type !== 'ImportDeclaration' ||
      !isRelative(statement.source.value)
    ) {
      continue;
    }

    for (const specifier of statement.specifiers) {
      bindings.set(specifier.local.name, {
        specifier: statement.source.value,
        imported:
          specifier.type === 'ImportSpecifier'
            ? importedName(specifier)
            : undefined,
        namespace: specifier.type === 'ImportNamespaceSpecifier',
        typeOnly:
          statement.importKind === 'type' ||
          (specifier.type === 'ImportSpecifier' &&
            specifier.importKind === 'type'),
      });
    }
  }

  const use = (
    node: t.Node,
    binding: Binding,
    symbol: string | undefined
  ): void => {
    const range = rangeOf(node);
    if (range) {
      references.push({
        range,
        specifier: binding.specifier,
        candidates: moduleCandidates(binding.specifier),
        ...(symbol ? { symbol } : {}),
        ...(binding.typeOnly ? { typeOnly: true } : {}),
      });
    }
  };

  walk(program, (node, parent, key) => {
    // `import { name }`: the name points at its definition too.
    if (
      node.type === 'ImportSpecifier' &&
      parent?.type === 'ImportDeclaration'
    ) {
      const binding = bindings.get(node.local.name);
      if (binding) {
        use(node.imported, binding, binding.imported);
      }

      return;
    }

    if (node.type === 'Identifier' || node.type === 'JSXIdentifier') {
      const binding = bindings.get(node.name);
      if (
        binding &&
        !isNameOnly(parent, key) &&
        parent?.type !== 'JSXAttribute' &&
        parent?.type !== 'JSXMemberExpression'
      ) {
        use(node, binding, binding.imported);
      }

      return;
    }

    // `ns.fn` of `import * as ns from './x'` points at `fn`.
    if (
      (node.type === 'MemberExpression' || node.type === 'TSQualifiedName') &&
      !('computed' in node && node.computed)
    ) {
      const object = node.type === 'MemberExpression' ? node.object : node.left;
      const property =
        node.type === 'MemberExpression' ? node.property : node.right;
      const binding =
        object.type === 'Identifier' ? bindings.get(object.name) : undefined;
      if (binding?.namespace && property.type === 'Identifier') {
        use(property, binding, property.name);
      }

      return;
    }

    const literal = specifierOf(node);
    const range = literal ? rangeOf(literal) : undefined;
    if (!literal || !range || !isRelative(literal.value)) {
      return;
    }

    references.push({
      range: { start: range.start + 1, end: range.end - 1 },
      specifier: literal.value,
      candidates: moduleCandidates(literal.value),
    });
  });
  return references.toSorted((a, b) => a.range.start - b.range.start);
}
