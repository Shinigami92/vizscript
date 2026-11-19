import type { ScriptSymbol } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { signatureText } from '../src/graph/project-index';
import {
  decoratorsOf,
  shortDecorator,
  typeParamNames,
  typeParamsText,
} from '../src/graph/symbols';

const NOWHERE = { start: 0, end: 0 };

function symbol(modifiers: string[], typeParams?: string[]): ScriptSymbol {
  return {
    id: 'function:call',
    kind: 'function',
    name: 'call',
    scope: '',
    range: NOWHERE,
    nameRange: NOWHERE,
    dataType: 'function',
    modifiers,
    ...(typeParams ? { typeParams } : {}),
    params: [],
    returns: { text: 'Promise<T>', range: NOWHERE },
  };
}

describe('decorators and type parameters for display', () => {
  it('leaves GDScript export annotations to their switches', () => {
    expect(
      decoratorsOf(
        symbol(['@export_range(0, 10)', '@onready', '@rpc', 'static'])
      )
    ).toEqual(['@rpc']);
    expect(shortDecorator('@UseGuards(A, B)')).toBe('@UseGuards');
  });

  it('shows type parameters in full or by name', () => {
    const generic = symbol([], ['T extends object = {}', 'const K']);
    expect(typeParamsText(generic)).toBe('<T extends object = {}, const K>');
    expect(typeParamNames(generic)).toBe('<T, K>');
    expect(signatureText(generic)).toBe(
      'call<T extends object = {}, const K>() → Promise<T>'
    );
    expect(typeParamNames(symbol([]))).toBe('');
  });
});
