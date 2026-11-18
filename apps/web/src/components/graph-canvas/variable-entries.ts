import type { DataType } from '@vizscript/core';
import { isTypeCompatible } from '@vizscript/core';
import type { ActionEntry } from '../ActionMenu.vue';
import type { ScopeVariable, Variable } from './graph-helpers';
import { ICON_VARIABLE } from './menu-data';

/**
 * UE's "Get <name>" for an input the wire was dropped from: the values
 * near the node first (`variablesNear`), then the other variables the
 * function can read (fields, module variables). The name is a keyword
 * too, so it is found alone.
 */
export function variableReadEntries(
  near: ReadonlyArray<Variable>,
  scope: ReadonlyArray<ScopeVariable>,
  pinType: DataType,
  read: (expression: string) => void
): ActionEntry[] {
  const entry = (
    expression: string,
    type: string,
    dataType: DataType
  ): ActionEntry => ({
    label: `Get ${expression}`,
    category: 'Variables',
    icon: ICON_VARIABLE,
    hint: type,
    keywords: `get read ${expression}`,
    fits: isTypeCompatible(dataType, pinType),
    action: () => read(expression),
  });
  return [
    ...near.map((variable) =>
      entry(variable.name, variable.type, variable.type)
    ),
    ...scope
      .filter((variable) => !near.some((n) => n.name === variable.expression))
      .map((variable) =>
        entry(variable.expression, variable.type, variable.dataType)
      ),
  ];
}
