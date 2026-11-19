import { typescriptBackend } from '@vizscript/lang-typescript';
import { describe, expect, it } from 'vitest';
import { newFunctionAnchor } from '../src/graph/symbols';

const CODE = `const LIMIT = 3;

function first(): void {
  const inner = () => 1;
}

class Cart {
  add(): void {}
  remove(): void {}
}

function last(): void {}
`;

describe('newFunctionAnchor', () => {
  const doc = typescriptBackend.parse(CODE, 'cart.ts');
  const anchor = (
    scope: string,
    selected: string | null,
    current: string | null = null
  ): string | undefined => newFunctionAnchor(doc, scope, selected, current);

  it('goes after the selected function', () => {
    expect(anchor('', 'function:first')).toBe('function:first');
  });

  it('goes after the top-level declaration around the selection', () => {
    // A method selected: a new module function goes after its class.
    expect(anchor('', 'method:Cart.add')).toBe('class:Cart');
    expect(anchor('Cart', 'method:Cart.add')).toBe('method:Cart.add');
  });

  it('uses the function shown in the graph without a selection', () => {
    expect(anchor('', null, 'last')).toBe('function:last');
    expect(anchor('Cart', null, 'Cart.remove')).toBe('method:Cart.remove');
  });

  it('keeps the default place for variables and other scopes', () => {
    expect(anchor('', 'variable:LIMIT')).toBeUndefined();
    expect(anchor('Cart', 'function:first')).toBeUndefined();
    expect(anchor('', null, null)).toBeUndefined();
  });
});
