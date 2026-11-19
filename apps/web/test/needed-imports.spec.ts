import type { ScriptSymbol } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import {
  referencedNames,
  withImports,
  writtenCode,
} from '../src/graph/needed-imports';
import { externalTypes, libraryTypes } from '../src/graph/project-index';

function symbol(
  name: string,
  kind: ScriptSymbol['kind'],
  modifiers: string[] = []
): ScriptSymbol {
  return {
    id: `${kind}:${name}`,
    name,
    kind,
    scope: '',
    modifiers,
    range: { start: 0, end: 0 },
    nameRange: { start: 0, end: 0 },
  } as ScriptSymbol;
}

/** Symbol `C` is a class, others are types. */
function isClass(id: string): boolean {
  return id === 'C';
}

describe('imports a written type or decorator needs', () => {
  it('finds the names code refers to', () => {
    expect(referencedNames('Map<Role, User[]> | null')).toEqual([
      'Map',
      'Role',
      'User',
      'null',
    ]);
    // Not members, keys, parameter names or strings.
    expect(
      referencedNames("@Injectable({ scope: Scope.REQUEST, id: 'User' })")
    ).toEqual(['Injectable', 'Scope']);
    expect(referencedNames('(repo: GitHubRepo) => RepoSummary')).toEqual([
      'GitHubRepo',
      'RepoSummary',
    ]);
    expect(referencedNames('{ login?: string }')).toEqual(['string']);
  });

  it('knows which ops write types and decorators', () => {
    expect(
      writtenCode({ type: 'setReturnType', symbol: 'f', typeText: 'User' })
    ).toEqual([{ text: 'User', asType: true }]);
    expect(
      writtenCode({ type: 'setDecorator', symbol: 'c', text: '@Get()' })
    ).toEqual([{ text: '@Get()', asType: false }]);
    expect(
      writtenCode({ type: 'setReturnType', symbol: 'f', typeText: null })
    ).toEqual([]);
    expect(writtenCode({ type: 'deleteSymbol', symbol: 'f' })).toEqual([]);
    // A base class is a value; what a class implements is a type.
    expect(
      writtenCode(
        { type: 'setHeritage', symbol: 'C', clause: 'extends', text: 'Base' },
        isClass
      )
    ).toEqual([{ text: 'Base', asType: false }]);
    expect(
      writtenCode(
        { type: 'setHeritage', symbol: 'C', clause: 'implements', text: 'I' },
        isClass
      )
    ).toEqual([{ text: 'I', asType: true }]);
    expect(
      writtenCode(
        { type: 'setHeritage', symbol: 'I', clause: 'extends', text: 'J' },
        isClass
      )
    ).toEqual([{ text: 'J', asType: true }]);
  });

  it('wraps the op in its imports, the first written first', () => {
    const op = { type: 'deleteSymbol' as const, symbol: 'f' };
    const a = { path: 'a.ts', from: 'm.ts', name: 'A', imported: 'A' };
    const b = { path: 'b.ts', from: 'm.ts', name: 'B', imported: 'B' };
    expect(withImports(op, [])).toBe(op);
    expect(withImports(op, [a, b])).toEqual({
      type: 'withImport',
      import: a,
      op: { type: 'withImport', import: b, op },
    });
  });
});

describe('types of other files and libraries', () => {
  it('offers exported types, imported as types in TypeScript', () => {
    const exports = new Map([
      [
        'src/api/types.ts',
        [
          symbol('RepoSummary', 'type'),
          symbol('load', 'function'),
          symbol('Client', 'class', ['export default']),
          symbol('Taken', 'type'),
        ],
      ],
    ]);
    const doc = {
      functions: [],
      symbols: [symbol('Taken', 'type')],
    } as never;
    expect(externalTypes(exports, doc, 'src/scm/github.ts', '')).toEqual([
      {
        name: 'Client',
        where: '../api/types.ts',
        request: {
          path: 'src/api/types.ts',
          from: 'src/scm/github.ts',
          name: 'Client',
          imported: 'default',
          root: '',
          typeOnly: true,
        },
      },
      {
        name: 'RepoSummary',
        where: '../api/types.ts',
        request: {
          path: 'src/api/types.ts',
          from: 'src/scm/github.ts',
          name: 'RepoSummary',
          imported: 'RepoSummary',
          root: '',
          typeOnly: true,
        },
      },
    ]);
    // Python imports classes like any name.
    expect(
      externalTypes(
        new Map([['pkg/models.py', [symbol('User', 'class')]]]),
        null,
        'pkg/app.py',
        ''
      )[0]?.request.typeOnly
    ).toBeUndefined();
  });

  it("offers a library's types", () => {
    expect(
      libraryTypes(
        '@octokit/rest',
        [symbol('Octokit', 'class'), symbol('paginate', 'function')],
        'src/a.ts'
      )
    ).toEqual([
      {
        name: 'Octokit',
        where: '@octokit/rest',
        request: {
          path: '',
          from: 'src/a.ts',
          name: 'Octokit',
          imported: 'Octokit',
          module: '@octokit/rest',
          typeOnly: true,
        },
      },
    ]);
  });
});
