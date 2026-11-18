import { describe, expect, it } from 'vitest';
import { applyTextEdits } from '../src';
import { deleteNodes } from '../src/delete-ops';
import type { GraphDocument, GraphNode, Pin } from '../src/ir';
import { inputEdit } from '../src/text-op-helpers';
import type { StatementSyntax } from '../src/text-ops';
import { disconnect } from '../src/wire-ops';

const TEXT = 'ok = x not in items\n';
const WHOLE = { start: TEXT.indexOf('x not'), end: TEXT.indexOf('\n') };
const SYNTAX = { placeholder: 'None' } as StatementSyntax;

function dataIn(id: string, range: { start: number; end: number }): Pin {
  return { id, name: '', direction: 'in', kind: 'data', type: 'any', range };
}

function value(): Pin {
  return {
    id: 'value',
    name: '',
    direction: 'out',
    kind: 'data',
    type: 'bool',
  };
}

/** `x not in items` drawn as CONTAINS wired into NOT, both over it all. */
function pair(): GraphDocument {
  const contains: GraphNode = {
    id: 'contains',
    kind: 'operator',
    category: 'pure',
    purity: 'pure',
    title: 'in',
    range: WHOLE,
    path: 'f.a',
    pins: [
      dataIn('a', { start: 5, end: 6 }),
      dataIn('b', { start: TEXT.indexOf('items'), end: WHOLE.end }),
      value(),
    ],
  };
  const not: GraphNode = {
    id: 'not',
    kind: 'operator',
    category: 'pure',
    purity: 'pure',
    title: 'not',
    range: WHOLE,
    path: 'f',
    pins: [{ ...dataIn('a', WHOLE), meta: { wrap: 'not $value' } }, value()],
  };
  return {
    language: 'test',
    diagnostics: [],
    functions: [
      {
        id: 'f',
        name: 'f',
        range: { start: 0, end: TEXT.length },
        nodes: [contains, not],
        edges: [
          {
            id: 'e',
            kind: 'data',
            from: { node: 'contains', pin: 'value' },
            to: { node: 'not', pin: 'a' },
          },
        ],
      },
    ],
  };
}

describe('input pins with a wrap', () => {
  it('write the value inside the wrap', () => {
    const pin = { ...dataIn('a', WHOLE), meta: { wrap: 'not $value' } };
    expect(inputEdit(pin, WHOLE, 'flag')).toEqual({
      ...WHOLE,
      text: 'not flag',
    });
    expect(inputEdit(dataIn('a', WHOLE), WHOLE, 'flag')).toEqual({
      ...WHOLE,
      text: 'flag',
    });
  });

  it('keep the wrap when the wire into them breaks', () => {
    const result = disconnect(TEXT, pair(), { node: 'not', pin: 'a' }, SYNTAX);
    expect(result.ok && applyTextEdits(TEXT, result.edits)).toBe(
      'ok = not None\n'
    );
  });

  it('keep the wrap when the node feeding them is deleted', () => {
    const result = deleteNodes(TEXT, pair(), ['contains'], SYNTAX);
    expect(result.ok && applyTextEdits(TEXT, result.edits)).toBe(
      'ok = not None\n'
    );
  });

  it('go with their node', () => {
    const result = deleteNodes(TEXT, pair(), ['not'], SYNTAX);
    expect(result.ok && applyTextEdits(TEXT, result.edits)).toBe('ok = None\n');
  });
});
