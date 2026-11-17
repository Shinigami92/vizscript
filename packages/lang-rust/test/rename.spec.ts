import { applyTextEdits } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { applyRustOp, parseRustDocument } from '../src';

/** Renames the local `name` of function `scope` to `to`. */
function renameLocal(
  text: string,
  name: string,
  to: string,
  scope: string
): string {
  const symbol = parseRustDocument(text, 'a.rs').symbols?.find(
    (s) => s.name === name && s.kind === 'local' && s.scope === scope
  );
  const result = applyRustOp(
    text,
    { type: 'renameSymbol', symbol: symbol?.id ?? '', name: to },
    'a.rs'
  );
  if (!result.ok) {
    throw new Error(result.error);
  }

  return applyTextEdits(text, result.edits);
}

describe('rust local rename', () => {
  it('renames only the uses of that binding', () => {
    const text = [
      'fn f(o: Option<i32>) -> i32 {',
      '    let x = 1;',
      '    let g = |x: i32| x * 2;',
      '    { let x = 5; println!("{x}"); }',
      '    if let Some(x) = o { return x; }',
      '    for x in 0..3 { let _ = x; }',
      '    match o { Some(x) => x, None => x };',
      '    println!("{x} {}", x);',
      '    let x = x + 1;',
      '    x + g(x)',
      '}',
      '',
    ].join('\n');
    expect(renameLocal(text, 'x', 'count', 'f')).toBe(
      [
        'fn f(o: Option<i32>) -> i32 {',
        '    let count = 1;',
        '    let g = |x: i32| x * 2;',
        '    { let x = 5; println!("{x}"); }',
        '    if let Some(x) = o { return x; }',
        '    for x in 0..3 { let _ = x; }',
        '    match o { Some(x) => x, None => count };',
        '    println!("{count} {}", count);',
        '    let x = count + 1;',
        '    x + g(x)',
        '}',
        '',
      ].join('\n')
    );
  });

  it('follows a binding into closures and inner blocks that use it', () => {
    const text =
      'fn f() -> i32 {\n    let total = 2;\n    let g = |y: i32| y * total;\n    { let z = total; z }\n}\n';
    expect(renameLocal(text, 'total', 'sum', 'f')).toBe(
      'fn f() -> i32 {\n    let sum = 2;\n    let g = |y: i32| y * sum;\n    { let z = sum; z }\n}\n'
    );
  });
});
