import type {
  GraphDocument,
  GraphNode,
  GraphOp,
  Pin,
  PinRef,
  Point,
  TypeSystemInfo,
} from '@vizscript/core';
import {
  holdsFields,
  isArrayType,
  isMapType,
  mapKeyType,
} from '@vizscript/core';
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

/** A new key of `type`: an empty string or number, else the placeholder. */
function emptyKey(types: TypeSystemInfo, type: string): string {
  const option = types.primitives.find(
    (p) =>
      p.dataType === type &&
      !p.defaultIsNode &&
      (type !== 'string' || /^(["'])\1$/.test(p.defaultValue ?? ''))
  );
  return option?.defaultValue ?? types.placeholder ?? 'undefined';
}

/**
 * UE's GET and FIND from a container's output: one element of an array
 * (`items[0]`) or the value of a key in a map (`prices['']`), written as
 * an index, which the graph shows as a GET or FIND node.
 */
export function elementEntries(
  types: TypeSystemInfo | null | undefined,
  pin: Pin,
  source: PinRef,
  world: Point,
  emitOp: (op: GraphOp) => void
): ActionEntry[] {
  // TypeScript's `Map` has no index (`map.get(key)`); a `Record` has.
  const indexable =
    isMapType(pin.type) && !/^(?:Readonly|Weak)?Map</.test(pin.typeText ?? '');
  if (!types || pin.type === 'array' || pin.type === 'map') {
    return [];
  }

  const read = (expression: string): void =>
    emitOp({
      type: 'useValue',
      pin: source,
      expression,
      position: { ...world },
    });
  if (isArrayType(pin.type)) {
    return [
      {
        label: 'Get',
        category: 'Array',
        icon: 'i-mdi-grid text-amber-400',
        keywords: 'get index element item array list [ ]',
        hint: 'element at an index',
        fits: true,
        action: () => read('$value[0]'),
      },
    ];
  }

  if (!indexable) {
    return [];
  }

  const key = emptyKey(types, mapKeyType(pin.type));
  const literal = /^["']/.test(key);
  return [
    {
      label: 'Find',
      category: 'Map',
      icon: 'i-mdi-view-list text-amber-400',
      keywords: 'find get key value map dict dictionary [ ]',
      hint: 'value of a key',
      fits: true,
      action: () =>
        read(`$value[${literal ? '' : (types.keyReference ?? '')}${key}]`),
    },
  ];
}
