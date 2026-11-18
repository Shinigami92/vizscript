import { getMeta } from './edit-meta';
import type { OutputPinMeta } from './edit-meta';
import { isElementGet } from './element-access';
import type { ValueSource } from './graph-builder';
import { createEdge } from './ids';
import type {
  DataType,
  FunctionGraph,
  GraphEdge,
  GraphNode,
  Pin,
  SourceRange,
} from './ir';
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

/**
 * The containers UE has nodes for: arrays, maps and sets; and strings, for
 * their LENGTH.
 */
export type ContainerKind = 'array' | 'map' | 'set' | 'string';

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
  /** What it does, in UE's word (CONTAINS); found by it, shown unless `label`. */
  word: string;
  /**
   * The word shown instead, where the language's own name reads better
   * (TypeScript's INCLUDES and HAS for CONTAINS).
   */
  label?: string;
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
  /**
   * Its values are passed by reference (Rust's `contains(&x)`): the action
   * menu writes `TypeSystemInfo.keyReference` before them.
   */
  byReference?: boolean;
  /**
   * Only for values whose type is written like this (a regular
   * expression): TypeScript's `Map` methods don't exist on a `Record`.
   */
  typeText?: string;
}

/** Which container a type is, if any (untyped ones too). */
export function containerKind(type: DataType): ContainerKind | undefined {
  if (isArrayType(type)) {
    return 'array';
  }

  if (isMapType(type)) {
    return 'map';
  }

  if (type === 'string') {
    return 'string';
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
      if (container === 'string') {
        return 'string';
      }

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
  container: { word: string; pin: string; label?: string };
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
    container: {
      word: op.word,
      pin: containerPin,
      ...(op.label === undefined ? {} : { label: op.label }),
    },
  } satisfies ContainerNodeMeta;
}

/** The word of a container node (`LENGTH`), if it is one: UE's. */
export function containerWord(node: GraphNode): string | undefined {
  return getMeta<ContainerNodeMeta>(node).container?.word;
}

/** The word a container node shows: its label (INCLUDES), else its word. */
export function containerLabel(node: GraphNode): string | undefined {
  const container = getMeta<ContainerNodeMeta>(node).container;
  return container?.label ?? container?.word;
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

/** `1`, also with a Rust suffix (`1usize`). */
const ONE = /^1(?:_?[iu](?:8|16|32|64|128|size))?$/;

/**
 * UE's LAST INDEX: `len(items) - 1` (`items.length - 1` …). When `op` is
 * `-` of an array's LENGTH node (just built, among `nodes`) and the
 * literal 1, that node becomes LAST INDEX and covers the whole
 * subtraction (`range`, its code `text`): one node, its container pin
 * still `items`. `undefined` for anything else; the backend then builds
 * the `-` as usual.
 */
export function lastIndexValue(
  nodes: ReadonlyArray<GraphNode>,
  op: string,
  values: ReadonlyArray<ValueSource>,
  operandTexts: ReadonlyArray<string>,
  range: SourceRange,
  text: string
): ValueSource | undefined {
  const [length] = values;
  if (
    op !== '-' ||
    values.length !== 2 ||
    !length ||
    !ONE.test(operandTexts[1]?.trim() ?? '')
  ) {
    return undefined;
  }

  const node =
    'pin' in length ? nodes.find((n) => n.id === length.pin.node) : undefined;
  const container = node ? containerPinOf(node) : undefined;
  if (
    !node ||
    containerWord(node) !== 'LENGTH' ||
    !container ||
    !isArrayType(container.type)
  ) {
    return undefined;
  }

  const old = node.range;
  const same = (r: SourceRange | undefined): boolean =>
    r?.start === old.start && r.end === old.end;
  node.range = { start: range.start, end: range.end };
  node.pins = node.pins.map((pin) => {
    if (pin.direction !== 'out' || pin.kind !== 'data') {
      return pin;
    }

    // What wiring the value elsewhere copies or binds: the whole `- 1`.
    const meta = getMeta<OutputPinMeta>(pin);
    return {
      ...pin,
      ...(same(pin.range) ? { range: node.range } : {}),
      meta: {
        ...pin.meta,
        ...(meta.sourceText === undefined ? {} : { sourceText: text }),
        ...(meta.bind && same(meta.bind.expr)
          ? { bind: { ...meta.bind, expr: node.range } }
          : {}),
      },
    };
  });
  node.meta = {
    ...node.meta,
    container: { word: 'LAST INDEX', pin: container.id },
  } satisfies ContainerNodeMeta;
  return { ...length, type: 'number' };
}

/**
 * The code that tells whether `container` has `key`, written like the
 * map CONTAINS `op` (`key in d`, `m.has(key)`, `m.contains_key(&key)`).
 */
export function containsKeyCode(
  op: ContainerOp,
  container: string,
  key: string
): string {
  switch (op.form) {
    case 'method': {
      return `${container}.${op.name}(${key})`;
    }

    case 'property': {
      return `${container}.${op.name}`;
    }

    case 'function': {
      return `${op.name}(${container}, ${key})`;
    }

    case 'operator': {
      return op.containerLast
        ? `${key} ${op.name} ${container}`
        : `${container} ${op.name} ${key}`;
    }
  }
}

/**
 * UE's map FIND has a second output, whether the key is there. FIND nodes
 * of maps (`d.get(k)`, `d[k]`) among `nodes` get a `found` output whose
 * code is the language's CONTAINS of the same map and key
 * (`containsKeyCode`), so wiring it writes that. `source` reads the code
 * of a range.
 */
export function addFoundPins(
  nodes: ReadonlyArray<GraphNode>,
  ops: ReadonlyArray<ContainerOp>,
  source: (range: SourceRange) => string
): void {
  for (const node of nodes) {
    const word = containerWord(node) ?? (isElementGet(node) ? node.title : '');
    const container = containerPinOf(node);
    if (
      word !== 'FIND' ||
      !container?.range ||
      !isMapType(container.type) ||
      node.pins.some((p) => p.id === 'found')
    ) {
      continue;
    }

    const key = node.pins.find(
      (p) =>
        p.direction === 'in' &&
        p.kind === 'data' &&
        p !== container &&
        p.range !== undefined
    );
    // A type written only for some maps (TypeScript's `Map`, not a
    // `Record`): the pin's `typeText`, or a FIND that is a method, which
    // exists for those maps only.
    const fits = (op: ContainerOp): boolean =>
      op.typeText === undefined ||
      (container.typeText === undefined
        ? containerWord(node) === 'FIND'
        : new RegExp(op.typeText).test(container.typeText));
    const contains = ops.find(
      (op) => op.word === 'CONTAINS' && op.on.includes('map') && fits(op)
    );
    const code =
      key?.range && contains
        ? containsKeyCode(contains, source(container.range), source(key.range))
        : undefined;
    if (code) {
      node.pins = [
        ...node.pins,
        {
          id: 'found',
          name: 'found',
          direction: 'out',
          kind: 'data',
          type: 'bool',
          meta: { sourceText: code } satisfies OutputPinMeta,
        },
      ];
    }
  }
}

/**
 * A call or property read that a backend couldn't type while lowering
 * (`items.includes(x)` of a value only the checker types): what it is, so
 * `restyleContainerNodes` makes it a container node once its container
 * pin is typed.
 */
export interface ContainerCandidate {
  form: ContainerOp['form'];
  name: string;
  /** Number of values after the container. */
  args: number;
  /** The container pin (any value pin of an operator: it is found then). */
  pin: string;
  /** Written as a statement of its own: stays on the exec chain. */
  statement: boolean;
  /** Its code, for the value of a pure read (`sourceText`). */
  code: string;
}

interface ContainerCandidateMeta {
  containerCandidate: ContainerCandidate;
}

/** Notes on `node` what it could be once its container is typed. */
export function markContainerCandidate(
  node: GraphNode,
  candidate: ContainerCandidate
): void {
  node.meta = {
    ...node.meta,
    containerCandidate: candidate,
  } satisfies ContainerCandidateMeta;
}

/**
 * Container nodes for candidates (`markContainerCandidate`) whose
 * container pin has a container type now (after `applyTypes`). Reads
 * become pure like UE's: their exec pins go, the exec wire runs from the
 * node before to the node after. Unchanged functions are returned as
 * they are.
 */
export function restyleContainerNodes(
  fn: FunctionGraph,
  ops: ReadonlyArray<ContainerOp>
): FunctionGraph {
  let edges: GraphEdge[] = fn.edges;
  let changed = false;
  const nodes = fn.nodes.map((original) => {
    const candidate =
      getMeta<ContainerCandidateMeta>(original).containerCandidate;
    const own = candidate
      ? original.pins.find((p) => p.id === candidate.pin)
      : undefined;
    if (!candidate || !own || containerWord(original) !== undefined) {
      return original;
    }

    // Types come with the wires into the pins.
    const typed = (input: Pin): Pin => {
      if (containerKind(input.type)) {
        return input;
      }

      const wire = fn.edges.find(
        (e) => e.to.node === original.id && e.to.pin === input.id
      );
      const source = wire
        ? fn.nodes
            .find((n) => n.id === wire.from.node)
            ?.pins.find((p) => p.id === wire.from.pin)
        : undefined;
      return source ?? input;
    };
    let op: ContainerOp | undefined;
    let containerPin = candidate.pin;
    let pin = typed(own);
    if (candidate.form === 'operator') {
      // Which value is the container depends on the operator (`x in xs`).
      const values = original.pins.filter(
        (p) => p.direction === 'in' && p.kind === 'data'
      );
      const found = findContainerOperator(
        ops,
        candidate.name,
        values.map((v) => typed(v).type)
      );
      const at = found ? values[found.index] : undefined;
      if (found && at) {
        op = found.op;
        containerPin = at.id;
        pin = typed(at);
      }
    } else {
      const kind = containerKind(pin.type);
      op = ops.find(
        (o) =>
          kind !== undefined &&
          o.form === candidate.form &&
          o.name === candidate.name &&
          o.on.includes(kind) &&
          (o.args?.length ?? 0) === candidate.args &&
          (o.typeText === undefined ||
            (pin.typeText !== undefined &&
              new RegExp(o.typeText).test(pin.typeText)))
      );
    }

    if (!op) {
      return original;
    }

    changed = true;
    const node: GraphNode = { ...original, pins: [...original.pins] };
    styleContainerNode(node, op, pin.type, containerPin);
    if (op.mutates || candidate.statement || node.purity === 'pure') {
      return node;
    }

    // A read: pure, off the exec chain.
    const execIn = node.pins.find(
      (p) => p.kind === 'exec' && p.direction === 'in'
    );
    const execOut = node.pins.find(
      (p) => p.kind === 'exec' && p.direction === 'out'
    );
    const into = edges.filter(
      (e) => e.to.node === node.id && e.to.pin === execIn?.id
    );
    const from = edges.filter(
      (e) => e.from.node === node.id && e.from.pin === execOut?.id
    );
    edges = [
      ...edges.filter((e) => !into.includes(e) && !from.includes(e)),
      ...into.flatMap((a) => from.map((b) => createEdge('exec', a.from, b.to))),
    ];
    node.purity = 'pure';
    node.category = 'pure';
    node.pins = node.pins
      .filter((p) => p.kind !== 'exec')
      .map((p) => {
        if (p.direction !== 'out') {
          return p;
        }

        const { bind, ...rest } = getMeta<OutputPinMeta>(p);
        return {
          ...p,
          meta: {
            ...rest,
            sourceText: candidate.code,
            ...(bind ? { scope: bind.stmt } : {}),
          },
        };
      });
    return node;
  });
  return changed ? { ...fn, nodes, edges } : fn;
}

/** UE's map ADD written as `d[key] = value`. */
const MAP_ADD_ELEMENT: ContainerOp = {
  word: 'ADD',
  on: ['map'],
  form: 'operator',
  name: '[]=',
  args: ['key', 'value'],
  mutates: true,
};

/**
 * Draws a write to one element (`setElement`, pins `target`, `index`,
 * `item`) of a map as the map's ADD, like `m.set(k, v)`; arrays keep UE's
 * Set Array Elem node.
 */
export function styleElementWrite(node: GraphNode, target: DataType): void {
  if (isMapType(target)) {
    styleContainerNode(node, MAP_ADD_ELEMENT, target, 'target');
  }
}
