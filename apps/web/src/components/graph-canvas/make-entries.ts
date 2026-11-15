import type {
  GraphDocument,
  GraphNode,
  GraphOp,
  Pin,
  PinRef,
  Point,
  TypeSystemInfo,
} from '@vizscript/core';
import { holdsFields } from '@vizscript/core';
import type { ActionEntry } from '../ActionMenu.vue';
import { EXPRESSION_ICONS } from './menu-data';

/**
 * UE's Make <Struct> for an input of a type with fields (an interface):
 * the value with each field empty (`{ name: '', price: 0 }`).
 */
export function makeEntries(
  doc: GraphDocument | null | undefined,
  source: PinRef | undefined,
  pinOf: (pinRef: PinRef) => { node: GraphNode; pin: Pin } | undefined,
  emitOp: (op: GraphOp) => void
): ActionEntry[] {
  const found = source ? pinOf(source) : undefined;
  const typeName = found ? String(found.pin.type) : '';
  const symbols = doc?.symbols ?? [];
  const owner = symbols.find((s) => holdsFields(s) && s.name === typeName);
  if (
    !source ||
    found?.pin.direction !== 'in' ||
    found.pin.kind !== 'data' ||
    !owner ||
    !symbols.some((s) => s.kind === 'variable' && s.scope === owner.name)
  ) {
    return [];
  }

  return [
    {
      label: `Make ${typeName}`,
      category: 'Values',
      icon: EXPRESSION_ICONS.Values,
      keywords: `make struct object ${typeName}`,
      hint: 'its fields',
      fits: true,
      action: () => emitOp({ type: 'makeValue', pin: source, typeName }),
    },
  ];
}

/** A Throw node with a dragged value wired in (`throw value`). */
export function throwEntries(
  types: TypeSystemInfo | null | undefined,
  source: PinRef,
  world: Point,
  emitOp: (op: GraphOp) => void
): ActionEntry[] {
  const expression = types?.throwValue;
  return expression
    ? [
        {
          label: 'Throw error',
          category: 'Flow control',
          icon: 'i-mdi-alert-octagon-outline',
          keywords: 'throw raise error exception',
          action: () =>
            emitOp({
              type: 'useValue',
              pin: source,
              expression,
              position: { ...world },
            }),
        },
      ]
    : [];
}
