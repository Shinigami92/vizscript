import { describe, expect, it } from 'vitest';
import { crateModule } from '../src/graph/crate-types';

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
