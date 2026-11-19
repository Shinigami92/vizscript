import type { Conversion, Pin } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import type { WireEnd } from '../src/wire-rules';
import { connectProblem, conversionOf, moveProblem } from '../src/wire-rules';

function end(
  node: string,
  pin: Partial<Pin> & Pick<Pin, 'direction'>,
  fnId = 'f',
  floating = false
): WireEnd {
  return {
    ns: { fnId, node: { id: node }, full: { floating } },
    pg: {
      pin: { id: 'p', name: '', kind: 'data', type: 'any', ...pin },
    },
  };
}

const TO_STRING: Conversion = {
  from: 'number',
  to: 'string',
  template: 'String($value)',
};

describe('wire rules', () => {
  it('explains like UE why two pins cannot be wired', () => {
    const out = end('a', { direction: 'out', type: 'number' });
    expect(connectProblem(out, end('a', { direction: 'in' }))).toBe(
      'Both are on the same node.'
    );
    expect(connectProblem(out, end('b', { direction: 'in' }, 'g'))).toBe(
      'The pins are in different functions.'
    );
    expect(
      connectProblem(out, end('b', { direction: 'in' }, 'g', true))
    ).toBeNull();
    expect(
      connectProblem(out, end('b', { direction: 'in', kind: 'exec' }))
    ).toBe('number is not compatible with Exec.');
    expect(connectProblem(out, end('b', { direction: 'out' }))).toBe(
      'Directions are not compatible.'
    );
    expect(
      connectProblem(out, end('b', { direction: 'in', type: 'bool' }))
    ).toBe('number is not compatible with bool.');
    expect(
      connectProblem(out, end('b', { direction: 'in', type: 'number' }))
    ).toBeNull();
    // `String(repo)`: the argument shows `object`, but takes anything.
    expect(
      connectProblem(
        out,
        end('b', { direction: 'in', type: 'object', declared: 'any' })
      )
    ).toBeNull();
  });

  it('allows a wire a conversion makes fit', () => {
    const out = end('a', { direction: 'out', type: 'number' });
    const input = end('b', { direction: 'in', type: 'string' });
    expect(connectProblem(out, input)).toBe(
      'number is not compatible with string.'
    );
    expect(connectProblem(out, input, [TO_STRING])).toBeNull();
    expect(conversionOf(input, out, [TO_STRING])).toBe(TO_STRING);
  });

  it('moves wires only to the same kind of pin, without conversions', () => {
    const from = end('a', { direction: 'out', type: 'number' });
    const ends = [end('c', { direction: 'in', type: 'string' })];
    expect(
      moveProblem({ from, ends }, end('b', { direction: 'in', type: 'number' }))
    ).toBe('Move the wires to another output.');
    expect(
      moveProblem(
        { from, ends },
        end('b', { direction: 'out', type: 'number' })
      )
    ).toBe('string is not compatible with number.');
    expect(
      moveProblem(
        { from, ends },
        end('b', { direction: 'out', type: 'string' })
      )
    ).toBeNull();
  });
});
