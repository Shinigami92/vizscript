import type {
  ContainerKind,
  ContainerOp,
  GraphOp,
  Pin,
  PinRef,
  Point,
  TypeSystemInfo,
} from '@vizscript/core';
import { containerKind, containerPartType } from '@vizscript/core';
import type { ActionEntry } from '../ActionMenu.vue';

/**
 * A new value of `type`: an empty string (`''`, not Rust's `' '` char) or
 * the type's own default, else the language's placeholder.
 */
export function emptyValueOf(types: TypeSystemInfo, type: string): string {
  const option = types.primitives.find(
    (p) =>
      p.dataType === type &&
      !p.defaultIsNode &&
      (type !== 'string' || /^(["'])\1$/.test(p.defaultValue ?? ''))
  );
  return option?.defaultValue ?? types.placeholder ?? 'undefined';
}

/** Whether `op` applies to a value of `pin`'s type (and type text). */
export function opFits(
  op: ContainerOp,
  kind: ContainerKind,
  pin: Pin
): boolean {
  return (
    op.on.includes(kind) &&
    (op.typeText === undefined ||
      new RegExp(op.typeText).test(pin.typeText ?? ''))
  );
}

const CATEGORIES: Record<ContainerKind, string> = {
  array: 'Array',
  map: 'Map',
  set: 'Set',
  string: 'String',
};

const ICONS: Record<ContainerKind, string> = {
  array: 'i-mdi-grid text-amber-400',
  map: 'i-mdi-view-list text-amber-400',
  set: 'i-mdi-code-braces text-amber-400',
  string: 'i-mdi-format-text text-pink-400',
};

/** `REMOVE INDEX` → `Remove Index`. */
function titled(word: string): string {
  return word.toLowerCase().replaceAll(/\b\w/g, (char) => char.toUpperCase());
}

/** The code `op` writes on `$value`, its values empty. */
function opExpression(
  types: TypeSystemInfo,
  op: ContainerOp,
  container: string
): string {
  const values = (op.args ?? []).map((part) => {
    const value =
      part === 'container' || part === 'keys' || part === 'values'
        ? (types.placeholder ?? 'undefined')
        : emptyValueOf(types, containerPartType(part, container));
    // Rust's `contains(&x)`, but `contains("x")`: a string is a reference.
    return op.byReference && !/^["']/.test(value)
      ? `${types.keyReference ?? ''}${value}`
      : value;
  });
  switch (op.form) {
    case 'method': {
      return `$value.${op.name}(${values.join(', ')})`;
    }

    case 'property': {
      return `$value.${op.name}`;
    }

    case 'function': {
      return `${op.name}(${['$value', ...values].join(', ')})`;
    }

    case 'operator': {
      // Rust's `&a | &b`: both sides by reference.
      const ref = op.byReference ? (types.keyReference ?? '') : '';
      const other = values[0] ?? `${ref}${types.placeholder ?? 'undefined'}`;
      return op.containerLast
        ? `${other} ${op.name} ${ref}$value`
        : `${ref}$value ${op.name} ${other}`;
    }
  }
}

/**
 * UE's container nodes from a container's output (LENGTH, CONTAINS,
 * ADD …), written the way the language does (`len(items)`,
 * `items.append(x)`, `x in d`), one per word, the values empty.
 */
export function containerEntries(
  types: TypeSystemInfo | null | undefined,
  pin: Pin,
  source: PinRef,
  world: Point,
  emitOp: (op: GraphOp) => void
): ActionEntry[] {
  const kind = containerKind(pin.type);
  if (!types?.containerOps || !kind || pin.direction !== 'out') {
    return [];
  }

  const entry = (
    word: string,
    name: string,
    expression: string
  ): ActionEntry => ({
    label: titled(word),
    category: CATEGORIES[kind],
    icon: ICONS[kind],
    keywords: `${word.toLowerCase()} ${name} ${kind}`,
    hint: expression.replaceAll('$value', '…'),
    fits: true,
    action: () =>
      emitOp({
        type: 'useValue',
        pin: source,
        expression,
        position: { ...world },
      }),
  });
  const words = new Set<string>();
  return types.containerOps.flatMap((op): ActionEntry[] => {
    if (!opFits(op, kind, pin) || words.has(op.word)) {
      return [];
    }

    words.add(op.word);
    const expression = opExpression(types, op, String(pin.type));
    // UE's LAST INDEX of an array: its LENGTH minus one (`lastIndexValue`).
    return op.word === 'LENGTH' && kind === 'array'
      ? [
          entry(op.word, op.name, expression),
          entry('LAST INDEX', op.name, `${expression} - 1`),
        ]
      : [entry(op.word, op.name, expression)];
  });
}
