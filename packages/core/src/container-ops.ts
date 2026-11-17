import { getMeta } from './edit-meta';
import { isElementGet } from './element-access';
import type { ValueSource } from './graph-builder';
import type { DataType, GraphNode, Pin } from './ir';
import {
  arrayElementType,
  arrayOf,
  isArrayType,
  isMapType,
  isSetType,
  mapKeyType,
  mapValueType,
  setElementType,
} from './types';

/** The containers UE has nodes for: arrays, maps and sets. */
export type ContainerKind = 'array' | 'map' | 'set';

/**
 * A pin's type in terms of its container: an `element` (of an array or
 * set), a map's `key` or `value`, arrays of a map's `keys` or `values`, the
 * `container` itself, or a plain `number` or `bool`.
 */
export type ContainerPart =
  | 'element'
  | 'key'
  | 'value'
  | 'keys'
  | 'values'
  | 'container'
  | 'number'
  | 'bool';

/**
 * An operation on a container that UE draws as a compact node with one
 * word (LENGTH, CONTAINS, ADD …) over the container's symbol. Each backend
 * lists how its language writes them; the code stays as it is.
 */
export interface ContainerOp {
  /** The word on the node, like UE's. */
  word: string;
  /** The containers it is for. */
  on: ReadonlyArray<ContainerKind>;
  /**
   * How the code writes it: a method (`items.push(x)`), a property
   * (`items.length`), a function with the container first (`len(items)`)
   * or an operator (`x in items`, `a | b`).
   */
  form: 'method' | 'property' | 'function' | 'operator';
  /** The method, property, function or operator. */
  name: string;
  /** Types of the values after the container, in order. */
  args?: ReadonlyArray<ContainerPart>;
  /** Type of the result. */
  result?: ContainerPart;
  /**
   * Changes the container (ADD, REMOVE): stays on the exec chain. Others
   * are pure, like UE's LENGTH or CONTAINS, unless written as a statement.
   */
  mutates?: boolean;
  /** An operator whose container is its last value (`x in items`). */
  containerLast?: boolean;
}

/** Which container a type is, if any (untyped ones too). */
export function containerKind(type: DataType): ContainerKind | undefined {
  if (isArrayType(type)) {
    return 'array';
  }

  if (isMapType(type)) {
    return 'map';
  }

  return isSetType(type) ? 'set' : undefined;
}

/**
 * The operation a backend lists for a call, property or operator `name`
 * written as `form` on a container of type `container` with `args` values
 * after it (`undefined` for operators, which take any number).
 */
export function findContainerOp(
  ops: ReadonlyArray<ContainerOp>,
  form: ContainerOp['form'],
  name: string,
  container: DataType | undefined,
  args?: number
): ContainerOp | undefined {
  const kind = container === undefined ? undefined : containerKind(container);
  if (!kind) {
    return undefined;
  }

  return ops.find(
    (op) =>
      op.form === form &&
      op.name === name &&
      op.on.includes(kind) &&
      (args === undefined || (op.args?.length ?? 0) === args)
  );
}

/** The pin type of `part` for a container of type `container`. */
export function containerPartType(
  part: ContainerPart,
  container: DataType
): DataType {
  switch (part) {
    case 'element': {
      return isSetType(container)
        ? setElementType(container)
        : arrayElementType(container);
    }

    case 'key': {
      return mapKeyType(container);
    }

    case 'value': {
      return mapValueType(container);
    }

    case 'keys': {
      return arrayOf(mapKeyType(container));
    }

    case 'values': {
      return arrayOf(mapValueType(container));
    }

    case 'container': {
      return container;
    }

    case 'number': {
      return 'number';
    }

    case 'bool': {
      return 'bool';
    }
  }
}

/** What `styleContainerNode` keeps on a node. */
interface ContainerNodeMeta {
  container: { word: string; pin: string };
}

/**
 * Draws `node` (a call, property read or operator of the code) as UE's
 * container node for `op`: compact with the word, the container pin
 * `containerPin` first and typed by `container`, the other values and the
 * result by their parts. Pins that write missing values (a free call's
 * Target, left-out arguments) go: such nodes take what they show.
 */
export function styleContainerNode(
  node: GraphNode,
  op: ContainerOp,
  container: DataType,
  containerPin: string
): void {
  const target = node.pins.find((p) => p.id === containerPin);
  if (!target) {
    return;
  }

  const values = node.pins.filter(
    (p) =>
      p.direction === 'in' &&
      p.kind === 'data' &&
      p !== target &&
      p.range !== undefined
  );
  const typed = (pin: Pin, part: ContainerPart | undefined): Pin => {
    const type = part ? containerPartType(part, container) : 'any';
    return type === 'any' ? pin : { ...pin, type };
  };

  const exec = node.pins.filter((p) => p.kind === 'exec');
  const outputs = node.pins.filter(
    (p) => p.direction === 'out' && p.kind === 'data'
  );
  node.pins = [
    ...exec,
    { ...target, type: container },
    ...values.map((pin, i) => typed(pin, op.args?.[i])),
    ...outputs.map((pin, i) => (i === 0 ? typed(pin, op.result) : pin)),
  ];
  node.compact = true;
  node.meta = {
    ...node.meta,
    container: { word: op.word, pin: containerPin },
  } satisfies ContainerNodeMeta;
}

/** The word of a container node (`LENGTH`), if it is one. */
export function containerWord(node: GraphNode): string | undefined {
  return getMeta<ContainerNodeMeta>(node).container?.word;
}

/**
 * UE's container nodes: GET and FIND (element reads) and the operations of
 * `styleContainerNode`, drawn as a word over the container's symbol.
 */
export function isContainerNode(node: GraphNode): boolean {
  return isElementGet(node) || containerWord(node) !== undefined;
}

/** The container pin of a container node. */
export function containerPinOf(node: GraphNode): Pin | undefined {
  const id = getMeta<ContainerNodeMeta>(node).container?.pin;
  return id === undefined
    ? node.pins.find((p) => p.direction === 'in' && p.kind === 'data')
    : node.pins.find((p) => p.id === id);
}

/**
 * Draws the node of `source` (just built, among `nodes`) as the container
 * node of `op` (`styleContainerNode`); the value has the op's result type.
 */
export function styleContainerValue(
  nodes: ReadonlyArray<GraphNode>,
  source: ValueSource,
  op: ContainerOp,
  container: DataType,
  containerPin: string
): ValueSource {
  const node =
    'pin' in source ? nodes.find((n) => n.id === source.pin.node) : undefined;
  if (!node) {
    return source;
  }

  styleContainerNode(node, op, container, containerPin);
  const type = op.result ? containerPartType(op.result, container) : 'any';
  return type === 'any' ? source : { ...source, type };
}

/**
 * The container operation a backend lists for operator `name` with values
 * of `operands` types, and which value is the container.
 */
export function findContainerOperator(
  ops: ReadonlyArray<ContainerOp>,
  name: string,
  operands: ReadonlyArray<DataType>
): { op: ContainerOp; index: number } | undefined {
  for (const op of ops) {
    if (op.form !== 'operator' || op.name !== name) {
      continue;
    }

    const index = op.containerLast ? operands.length - 1 : 0;
    const kind = containerKind(operands[index] ?? 'any');
    if (kind && op.on.includes(kind)) {
      return { op, index };
    }
  }

  return undefined;
}
