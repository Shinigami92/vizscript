import { describe, expect, it } from 'vitest';
import { ModelScopes } from '../src/monaco/model-scopes';

describe('ModelScopes', () => {
  it('reuses a kept model only in its own branch or folder', () => {
    const scopes = new ModelScopes<string>();
    scopes.claim('src/a.ts', 'github/o/r@main');
    expect(scopes.owns('src/a.ts', 'github/o/r@main')).toBe(true);
    expect(scopes.owns('src/a.ts', 'github/o/r@dev')).toBe(false);
    expect(scopes.owns('src/a.ts', 'local/p1')).toBe(false);
  });

  it('restores the cursor only in the scope it was saved in', () => {
    const scopes = new ModelScopes<string>();
    scopes.claim('a.ts', 'main');
    scopes.saveView('a.ts', 'main', 'line 40');
    expect(scopes.viewOf('a.ts', 'main')).toBe('line 40');
    expect(scopes.viewOf('a.ts', 'dev')).toBeUndefined();
    // The same path opened in another branch starts at the top.
    scopes.claim('a.ts', 'dev');
    scopes.saveView('a.ts', 'main', 'late save of main');
    expect(scopes.viewOf('a.ts', 'dev')).toBeUndefined();
    expect(scopes.viewOf('a.ts', 'main')).toBeUndefined();
  });

  it('releases a model only for the scope that owns it', () => {
    const scopes = new ModelScopes<string>();
    scopes.claim('a.ts', 'dev');
    // Leaving `main` after `dev` already opened the path keeps dev's model.
    expect(scopes.release('a.ts', 'main')).toBe(false);
    expect(scopes.owns('a.ts', 'dev')).toBe(true);
    expect(scopes.release('a.ts', 'dev')).toBe(true);
    expect(scopes.owns('a.ts', 'dev')).toBe(false);
    // Unknown paths and calls without a scope release.
    expect(scopes.release('b.ts', 'main')).toBe(true);
    scopes.claim('c.ts', 'dev');
    expect(scopes.release('c.ts')).toBe(true);
  });
});
