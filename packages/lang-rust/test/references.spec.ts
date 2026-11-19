import { describe, expect, it } from 'vitest';
import { rustReferences } from '../src';

describe('references of crate paths in the code', () => {
  const text = `use crate::parser;
use serde_json::Value;

fn run(text: &str) {
    let a = crate::lexer::tokens(text);
    let b = parser::Parser::new(text);
    let c = super::helper();
    let d = serde_json::to_string(&a);
}
`;
  const modules = rustReferences(text, 'src/cli/run.rs')
    .filter((r) => !r.symbol && r.range.start > text.indexOf('fn run'))
    .map((r) => ({
      code: text.slice(r.range.start, r.range.end),
      specifier: r.specifier,
      candidates: r.candidates,
    }));

  it('points the module of an item at its files', () => {
    expect(modules).toEqual([
      {
        code: 'crate::lexer',
        specifier: 'crate::lexer',
        candidates: ['/src/lexer.rs', '/src/lexer/mod.rs'],
      },
      // Through `use crate::parser;`.
      {
        code: 'parser',
        specifier: 'parser',
        candidates: ['/src/parser.rs', '/src/parser/mod.rs'],
      },
      {
        code: 'super',
        specifier: 'super',
        candidates: ['./mod.rs', '../cli.rs'],
      },
    ]);
  });
});
