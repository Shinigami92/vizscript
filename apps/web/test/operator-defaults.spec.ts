import type { ExpressionTemplate, TypeSystemInfo } from '@vizscript/core';
import { pythonBackend } from '@vizscript/lang-python';
import { typescriptBackend } from '@vizscript/lang-typescript';
import { describe, expect, it } from 'vitest';
import {
  emptyInput,
  fillTemplate,
  typeDefault,
} from '../src/components/graph-canvas/graph-helpers';

function system(types: TypeSystemInfo | undefined): TypeSystemInfo {
  if (!types) {
    throw new Error('No type system');
  }

  return types;
}

const TS = system(typescriptBackend.typeSystem);
const PY = system(pythonBackend.typeSystem);

function template(types: TypeSystemInfo, label: string): ExpressionTemplate {
  const found = types.expressions?.find((e) => e.label === label);
  if (!found) {
    throw new Error(`No template ${label}`);
  }

  return found;
}

function fill(
  types: TypeSystemInfo,
  label: string,
  first?: string,
  wireType?: Parameters<typeof emptyInput>[3]
): string {
  const expression = template(types, label);
  return fillTemplate(
    expression.template,
    (slot) => emptyInput(expression, slot, types, wireType),
    first
  );
}

describe('operators start with values that fit', () => {
  it('fills math and logic with neutral values', () => {
    const ts = TS;
    expect(fill(ts, '× (multiply)', '$value')).toBe('$value * 1');
    expect(fill(ts, '÷ (divide)')).toBe('0 / 1');
    expect(fill(ts, '< (less)', '$value')).toBe('$value < 0');
    expect(fill(ts, 'AND', '$value')).toBe('$value && true');
    expect(fill(ts, 'Select (a ? b : c)')).toBe('true ? undefined : undefined');
    expect(fill(PY, 'OR', '$value')).toBe('$value or False');
  });

  it('fills operators of their wire type with its empty value', () => {
    const ts = TS;
    expect(fill(ts, '+ (add)', '$value', 'string')).toBe("$value + ''");
    expect(fill(ts, '+ (add)', '$value', 'number')).toBe('$value + 0');
    expect(fill(ts, '+ (add)')).toBe('undefined + undefined');
    // A comparison's inputs are not of its result type.
    expect(fill(ts, '== (equal)', '$value', 'bool')).toBe(
      '$value === undefined'
    );
  });
});

describe('defaults of new Set nodes', () => {
  it('starts with an inline default, not a node of its own', () => {
    expect(typeDefault(TS, 'number')).toBe('0');
    // `{}` and `new Date()` would add a Make Object / call node.
    expect(typeDefault(TS, 'object')).toBeUndefined();
    expect(typeDefault(TS, 'Date')).toBeUndefined();
  });
});
