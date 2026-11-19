import type { TreeEntry } from '@vizscript/api-contract';
import { describe, expect, it } from 'vitest';
import type { TreeChanges } from '../src/graph/tree-changes';
import {
  changedTree,
  createFile,
  createFolder,
  currentFiles,
  NO_TREE_CHANGES,
  parseTreeChanges,
  pathError,
  removePath,
  renamePath,
  restorePath,
  sourceOf,
} from '../src/graph/tree-changes';

const BASE: TreeEntry[] = [
  { path: 'src', type: 'dir' },
  { path: 'src/a.ts', type: 'file' },
  { path: 'src/b.ts', type: 'file' },
  { path: 'README.md', type: 'file' },
];

function files(changes: TreeChanges): Set<string> {
  return currentFiles(BASE, changes);
}

describe('tree changes of a repository', () => {
  it('creates files and folders', () => {
    let c = createFolder(NO_TREE_CHANGES, 'lib/util');
    expect(changedTree(BASE, c).entries.map((e) => e.path)).toContain(
      'lib/util'
    );
    c = createFile(c, 'lib/util/x.ts');
    // The folder holds a file now.
    expect(c.folders).toEqual([]);
    expect(sourceOf(c, 'lib/util/x.ts')).toBe('');
    const tree = changedTree(BASE, c);
    expect(tree.entries.map((e) => e.path)).toEqual(
      expect.arrayContaining(['lib', 'lib/util', 'lib/util/x.ts'])
    );
    expect(tree.status.get('lib/util/x.ts')).toBe('added');
  });

  it('renames files, also back to their place', () => {
    let c = renamePath(
      NO_TREE_CHANGES,
      files(NO_TREE_CHANGES),
      'src/a.ts',
      'src/c.ts'
    );
    expect(c).toEqual({
      added: { 'src/c.ts': 'src/a.ts' },
      deleted: ['src/a.ts'],
      folders: [],
    });
    c = renamePath(c, files(c), 'src/c.ts', 'src/d.ts');
    expect(c.added).toEqual({ 'src/d.ts': 'src/a.ts' });
    c = renamePath(c, files(c), 'src/d.ts', 'src/a.ts');
    expect(c).toEqual(NO_TREE_CHANGES);
  });

  it('renames folders with every file in them', () => {
    const c = renamePath(NO_TREE_CHANGES, files(NO_TREE_CHANGES), 'src', 'lib');
    expect(c.added).toEqual({ 'lib/a.ts': 'src/a.ts', 'lib/b.ts': 'src/b.ts' });
    expect(files(c)).toEqual(new Set(['README.md', 'lib/a.ts', 'lib/b.ts']));
  });

  it('deletes and restores', () => {
    let c = createFile(NO_TREE_CHANGES, 'src/new.ts');
    c = removePath(c, files(c), 'src');
    // The new file is gone, the repository's are deleted.
    expect(c).toEqual({
      added: {},
      deleted: ['src/a.ts', 'src/b.ts'],
      folders: [],
    });
    expect(changedTree(BASE, c).status.get('src/a.ts')).toBe('deleted');
    c = restorePath(c, 'src/b.ts');
    expect(c.deleted).toEqual(['src/a.ts']);
    c = restorePath(c, 'src');
    expect(c).toEqual(NO_TREE_CHANGES);
  });

  it('reads stored changes', () => {
    expect(
      parseTreeChanges({ added: { a: 'b', c: 1 }, deleted: ['x', 2] })
    ).toEqual({ added: { a: 'b' }, deleted: ['x'], folders: [] });
    expect(parseTreeChanges('nope')).toBeNull();
  });

  it('checks new names', () => {
    const taken = new Set(['src', 'src/a.ts']);
    expect(pathError(taken, 'src/a.ts')).toBe('a.ts already exists here.');
    expect(pathError(taken, 'src/')).toBe('Give it a name.');
    expect(pathError(taken, 'src/../x')).toBe('Names can’t be . or ..');
    expect(pathError(taken, 'src/x:y')).toMatch(/can’t hold/);
    expect(pathError(taken, 'src/b/c.ts')).toBeUndefined();
  });
});
