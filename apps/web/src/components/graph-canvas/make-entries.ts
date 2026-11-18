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
  arrayElementType,
  holdsFields,
  isArrayType,
  isMapType,
  mapKeyType,
  mapValueType,
} from '@vizscript/core';
import type { ActionEntry } from '../ActionMenu.vue';
import { emptyValueOf, opFits } from './container-entries';
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

/**
 * UE's GET and FIND from a container's output: one element of an array
 * (`items[0]`) or the value of a key in a map (`prices['']`), written as
 * an index, which the graph shows as a GET or FIND node. Writing one
 * goes the same way: UE's Set Array Elem (`items[0] = ''`), and a map's
 * ADD where the language has none of its own (`prices[''] = 0`). Like
 * every node made from a value, they float until they are wired.
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

  const use = (expression: string): void =>
    emitOp({
      type: 'useValue',
      pin: source,
      expression,
      position: { ...world },
    });
  if (isArrayType(pin.type)) {
    const item = emptyValueOf(types, arrayElementType(pin.type));
    return [
      {
        label: 'Get',
        category: 'Array',
        icon: 'i-mdi-grid text-amber-400',
        keywords: 'get index element item array list [ ]',
        hint: 'element at an index',
        fits: true,
        action: () => use('$value[0]'),
      },
      {
        label: 'Set Array Elem',
        category: 'Array',
        icon: 'i-mdi-grid text-amber-400',
        keywords: 'set array elem element item index write assign [ ] =',
        hint: 'write the element at an index',
        fits: true,
        action: () => use(`$value[0] = ${item}`),
      },
    ];
  }

  if (!indexable) {
    return [];
  }

  const key = emptyValueOf(types, mapKeyType(pin.type));
  const index = `$value[${/^["']/.test(key) ? '' : (types.keyReference ?? '')}${key}]`;
  const has = (word: string): boolean =>
    types.containerOps?.some(
      (op) => op.word === word && opFits(op, 'map', pin)
    ) ?? false;
  const entries: ActionEntry[] = [];
  // A FIND or ADD of the language (`d.get(k)`, no error when missing, like
  // UE's) goes before an index.
  if (!has('FIND')) {
    entries.push({
      label: 'Find',
      category: 'Map',
      icon: 'i-mdi-view-list text-amber-400',
      keywords: 'find get key value map dict dictionary [ ]',
      hint: 'value of a key',
      fits: true,
      action: () => use(index),
    });
  }

  if (!has('ADD')) {
    const value = emptyValueOf(types, mapValueType(pin.type));
    entries.push({
      label: 'Add',
      category: 'Map',
      icon: 'i-mdi-view-list text-amber-400',
      keywords: 'add set put key value map dict dictionary [ ] =',
      hint: 'set the value of a key',
      fits: true,
      action: () => use(`${index} = ${value}`),
    });
  }

  return entries;
}
