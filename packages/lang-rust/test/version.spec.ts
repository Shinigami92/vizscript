import { describe, expect, it } from 'vitest';
import { rustVersion } from '../src';

describe('rustVersion', () => {
  it('reads the edition and rust-version of the crate', () => {
    const text =
      '[package]\nname = "demo"\nedition = "2021"\nrust-version = "1.80"';
    expect(rustVersion([{ path: 'Cargo.toml', text }])).toEqual({
      text: '1.80 · 2021 edition',
      detail: 'edition 2021, Rust 1.80',
      path: 'Cargo.toml',
    });
  });

  it('inherits the edition from the workspace', () => {
    expect(
      rustVersion([
        {
          path: 'crates/a/Cargo.toml',
          text: '[package]\nname = "a"\nedition.workspace = true',
        },
        {
          path: 'Cargo.toml',
          text: '[workspace]\nmembers = ["crates/*"]\n[workspace.package]\nedition = "2024"',
        },
        {
          path: 'rust-toolchain.toml',
          text: '[toolchain]\nchannel = "1.85.0"',
        },
      ])?.text
    ).toBe('1.85.0 · 2024 edition');
  });

  it("uses Cargo's default edition", () => {
    expect(
      rustVersion([{ path: 'Cargo.toml', text: '[package]\nname = "old"' }])
    ).toEqual({
      text: '2015 edition',
      detail: 'no edition (Cargo uses 2015)',
      path: 'Cargo.toml',
    });
  });
});
