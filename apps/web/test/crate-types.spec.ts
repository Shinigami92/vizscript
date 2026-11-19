import { describe, expect, it } from 'vitest';
import { crateModule, moduleFiles, usePath } from '../src/graph/crate-types';

describe('crateModule', () => {
  it('splits a use path into the crate and the module inside it', () => {
    expect(crateModule('nom::bytes::complete')).toEqual({
      crate: 'nom',
      path: 'bytes::complete',
    });
    expect(crateModule('serde_json')).toEqual({
      crate: 'serde_json',
      path: '',
    });
  });

  it('leaves out Rust itself and the crate being written', () => {
    for (const module of [
      'std::io',
      'core::fmt',
      'crate::parser',
      'super::x',
    ]) {
      expect(crateModule(module)).toBeUndefined();
    }
  });
});

describe('usePath', () => {
  const uses = [
    { name: 'overrides', module: 'ignore', imported: 'overrides' },
    { name: 'json', module: 'serde_json', imported: '*' },
    { name: 'Value', module: 'serde_json', imported: 'Value' },
  ];

  it('resolves the first segment through the file’s uses', () => {
    expect(usePath('overrides::OverrideBuilder', uses)).toBe(
      'ignore::overrides::OverrideBuilder'
    );
    expect(usePath('json::to_string', uses)).toBe('serde_json::to_string');
  });

  it('keeps paths whose head is no use', () => {
    expect(usePath('serde_json::Value', uses)).toBe('serde_json::Value');
    expect(usePath('overrides', uses)).toBe('overrides');
  });
});

describe('moduleFiles', () => {
  it('finds a module next to the crate root', () => {
    expect(moduleFiles('src/lib.rs', 'parser::tag')).toEqual([
      'src/parser/tag.rs',
      'src/parser/tag/mod.rs',
    ]);
    expect(moduleFiles('src/lib.rs', '')).toEqual(['src/lib.rs']);
  });
});
