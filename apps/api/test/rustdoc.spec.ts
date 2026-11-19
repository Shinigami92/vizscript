import { describe, expect, it } from 'vitest';
import { rustdocStubs, typeText } from '../src/types/rustdoc';
import { RUSTDOC } from './rustdoc-fixture';

describe('rustdocStubs', () => {
  it('writes the public API as Rust declarations per module', () => {
    const stubs = rustdocStubs(RUSTDOC, 'minicrate', '1.2.3');
    expect(stubs?.modules['']).toBe(
      [
        'pub fn parse(input: &str) -> Result<Value> {}',
        'pub enum Value {',
        '    Null,',
        '    Text(String),',
        '}',
        'impl Value {',
        '    pub fn as_str(&self) -> Option<&str> {}',
        '}',
        'pub type Result<T> = core::result::Result<T, Error>;',
        'pub const MAX: usize = 8;',
        'pub struct Point {',
        '    pub x: f64,',
        '}',
      ].join('\n')
    );
    // A re-export under another name, in its own module.
    expect(stubs?.modules.nested).toBe(
      'pub fn run(input: &str) -> Result<Value> {}'
    );
  });

  it('is undefined for anything but rustdoc JSON', () => {
    expect(rustdocStubs({ hello: 1 }, 'x', '1.0.0')).toBeUndefined();
  });
});

describe('typeText', () => {
  it('writes closures, references, tuples and impl Trait', () => {
    expect(
      typeText({
        impl_trait: [
          {
            trait_bound: {
              trait: {
                path: 'Fn',
                args: {
                  parenthesized: {
                    inputs: [{ generic: 'I' }],
                    output: { generic: 'O' },
                  },
                },
              },
            },
          },
        ],
      })
    ).toBe('impl Fn(I) -> O');
    expect(
      typeText({
        borrowed_ref: {
          is_mutable: true,
          type: { slice: { primitive: 'u8' } },
        },
      })
    ).toBe('&mut [u8]');
    expect(typeText({ tuple: [] })).toBe('()');
    expect(typeText({ tuple: [{ primitive: 'u8' }] })).toBe('(u8,)');
  });
});
