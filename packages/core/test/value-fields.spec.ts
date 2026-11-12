import { describe, expect, it } from 'vitest';
import type { ScriptSymbol, TypeSystemInfo } from '../src';
import { colorCode, fieldValue, vectorCode } from '../src';

const GD: TypeSystemInfo = {
  primitives: [],
  modifiers: {},
  valueEditors: {
    vectors: { Vector2: ['x', 'y'], Vector3: ['x', 'y', 'z'] },
    color: 'Color',
  },
};

function symbol(partial: Partial<ScriptSymbol>): ScriptSymbol {
  return {
    id: 'x',
    kind: 'variable',
    name: 'x',
    scope: '',
    range: { start: 0, end: 0 },
    nameRange: { start: 0, end: 0 },
    dataType: 'any',
    modifiers: [],
    ...partial,
  };
}

describe('value fields', () => {
  it('reads vectors, also constants and empty values of the type', () => {
    expect(fieldValue('Vector2(1, -2.5)', 'Vector2', GD, [], '')).toEqual({
      type: 'vector',
      name: 'Vector2',
      fields: ['x', 'y'],
      values: ['1', '-2.5'],
    });
    expect(fieldValue('Vector3.ONE', 'any', GD, [], '')).toMatchObject({
      values: ['1', '1', '1'],
    });
    expect(fieldValue('', 'Vector2', GD, [], '')).toMatchObject({
      values: ['', ''],
    });
    expect(fieldValue('Vector2(a, b)', 'Vector2', GD, [], '')).toBeUndefined();
    expect(vectorCode('Vector2', ['3', ''])).toBe('Vector2(3, 0)');
  });

  it('reads colors in their written form', () => {
    expect(fieldValue('Color(1, 0.5, 0)', 'Color', GD, [], '')).toMatchObject({
      rgba: [1, 0.5, 0, 1],
      html: false,
      hasAlpha: false,
    });
    expect(fieldValue('Color("#ff8000")', 'Color', GD, [], '')).toMatchObject({
      html: true,
    });
    expect(fieldValue('Color.RED', 'Color', GD, [], '')).toMatchObject({
      rgba: [1, 0, 0, 1],
    });
    expect(colorCode('Color', [1, 0.5, 0, 1], false, false)).toBe(
      'Color(1, 0.5, 0)'
    );
    expect(colorCode('Color', [1, 0.5, 0, 0.5], true, false)).toBe(
      'Color("#ff800080")'
    );
  });

  it('offers enum members and literal unions', () => {
    const symbols = [
      symbol({ kind: 'enum', name: 'State', members: ['IDLE', 'RUN'] }),
      // Python: members are constants of the enum class.
      symbol({ kind: 'enum', name: 'Color' }),
      symbol({ kind: 'constant', name: 'RED', scope: 'Color' }),
      symbol({ kind: 'type', name: 'Size', range: { start: 0, end: 30 } }),
    ];
    const text = "type Size = 'small' | 'big';";
    expect(fieldValue('State.IDLE', 'any', null, symbols, text)).toMatchObject({
      choices: [{ code: 'State.IDLE' }, { code: 'State.RUN' }],
    });
    expect(fieldValue('Color.RED', 'Color', null, symbols, text)).toMatchObject(
      {
        choices: [{ code: 'Color.RED' }],
      }
    );
    expect(fieldValue("'big'", 'Size', null, symbols, text)).toMatchObject({
      choices: [{ label: 'small' }, { label: 'big' }],
      current: "'big'",
    });
    expect(fieldValue('1', "1 | 2 | 'x'", null, [], '')).toMatchObject({
      choices: [{ code: '1' }, { code: '2' }, { code: "'x'" }],
    });
  });
});
