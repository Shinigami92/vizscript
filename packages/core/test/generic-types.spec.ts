import { describe, expect, it } from 'vitest';
import { refinesType, typeParamName, withoutTypeParams } from '../src';

describe('types of generics where they are used', () => {
  it('makes type parameters wildcards', () => {
    const params = ['T', 'K extends string = "id"', 'const V'];
    expect(typeParamName(params[1] ?? '')).toBe('K');
    expect(typeParamName(params[2] ?? '')).toBe('V');
    expect(withoutTypeParams('T', params)).toBe('any');
    expect(withoutTypeParams('T[]', params)).toBe('array');
    expect(withoutTypeParams('Map<K, V>', params)).toBe('map');
    expect(withoutTypeParams('Map<string, V>', params)).toBe(
      'Map<string, any>'
    );
    expect(withoutTypeParams('Set<T>', params)).toBe('set');
    expect(withoutTypeParams('Promise<T>', params)).toBe('Promise<any>');
    // Names that only contain a parameter's name stay.
    expect(withoutTypeParams('Token', params)).toBe('Token');
    expect(withoutTypeParams('T', undefined)).toBe('T');
  });

  it('lets the real type fill in the wildcards', () => {
    expect(refinesType('Promise<any>', 'Promise<string>')).toBe(true);
    expect(refinesType('Map<string, any>', 'Map<string, number>')).toBe(true);
    expect(refinesType('Promise<any>', 'Array<string>')).toBe(false);
    expect(refinesType('User', 'Admin')).toBe(false);
  });
});
