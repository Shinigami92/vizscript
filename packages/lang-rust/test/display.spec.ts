import { isOperatorGlyph, withImplicitSelf } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { parseRustDocument } from '../src';

const text = [
  'struct Cart {',
  '    price: f64,',
  '}',
  '',
  'impl Cart {',
  '    fn total(&self) -> f64 {',
  '        self.save();',
  '        self.price * 2.0',
  '    }',
  '',
  '    fn save(&self) {}',
  '}',
  '',
].join('\n');

describe('withImplicitSelf', () => {
  const doc = parseRustDocument(text, 'main.rs');
  const total = doc.functions.find((f) => f.name === 'Cart::total');
  if (!total) {
    throw new Error('no total');
  }

  const drawn = withImplicitSelf(total);

  it('shows `self` on a call target instead of a wire', () => {
    const save = drawn.nodes.find((n) => n.kind === 'call');
    const target = save?.pins.find((p) => p.id === 'target');
    expect(target?.literal).toMatchObject({ value: 'self', editable: false });
    expect(
      drawn.edges.some((e) => e.to.node === save?.id && e.to.pin === 'target')
    ).toBe(false);
  });

  it('drops the target pin of member getters', () => {
    const price = drawn.nodes.find((n) => n.title === '.price');
    expect(price?.pins.map((p) => p.id)).toEqual(['value']);
  });

  it('keeps the real graph unchanged', () => {
    expect(total.edges.filter((e) => e.to.pin === 'target')).toHaveLength(2);
  });

  it('draws symbol operators as glyphs', () => {
    const times = total.nodes.find((n) => n.title === '*');
    expect(times && isOperatorGlyph(times)).toBe(true);
  });
});
