import type {
  GraphDocument,
  ScriptSymbol,
  TypeSystemInfo,
} from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { signatureText } from '../src/graph/project-index';
import {
  decoratable,
  decoratorsOf,
  hasEditableTypeParams,
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

describe('what Details edits', () => {
  const types: TypeSystemInfo = {
    primitives: [],
    modifiers: {},
    decorators: { on: ['class', 'member', 'parameter'] },
    typeParams: true,
  };
  const cls = {
    ...symbol([]),
    id: 'class:Store',
    kind: 'class' as const,
    name: 'Store',
  };
  const method = {
    ...symbol([]),
    id: 'method:Store.get',
    kind: 'method' as const,
    name: 'get',
    scope: 'Store',
  };
  const doc = { symbols: [cls, method] } as unknown as GraphDocument;

  it('decorates classes, their members and their inputs (TypeScript)', () => {
    expect(decoratable(types, doc, cls)).toEqual({
      declaration: true,
      params: false,
    });
    expect(decoratable(types, doc, method)).toEqual({
      declaration: true,
      params: true,
    });
    // A function of the module: none in TypeScript.
    expect(decoratable(types, doc, symbol([]))).toEqual({
      declaration: false,
      params: false,
    });
    expect(decoratable(null, doc, cls)).toEqual({
      declaration: false,
      params: false,
    });
  });

  it('edits type parameters of declared functions, not of arrow functions', () => {
    expect(hasEditableTypeParams(types, symbol([]))).toBe(true);
    expect(hasEditableTypeParams(types, symbol(['const']))).toBe(false);
    expect(hasEditableTypeParams(types, symbol(['callback']))).toBe(false);
    expect(hasEditableTypeParams({ ...types, typeParams: false }, cls)).toBe(
      false
    );
  });
});
