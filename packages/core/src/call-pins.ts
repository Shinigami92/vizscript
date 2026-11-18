import type { ContainerNodeMeta } from './container-ops';
import { isContainerNode } from './container-ops';
import type { InputPinMeta } from './edit-meta';
import { getMeta } from './edit-meta';
import type { EngineClass } from './engine-classes';
import { classMethod } from './engine-classes';
import type { ImportedDeclaration } from './imports';
import type {
  DataType,
  FunctionGraph,
  GraphDocument,
  GraphNode,
  LiteralKind,
  Pin,
} from './ir';
import type { ScriptSymbol, SymbolParam } from './symbols';
import { qualifiedName } from './symbols';
import { arrayElementType } from './types';

export interface CallPinOptions {
  /** Argument written for a skipped parameter (`undefined`, `null`). */
  placeholder: string;
  /**
   * Missing arguments are written as `name=value` (Python), so defaults of
   * skipped parameters stay; otherwise positionally with placeholders.
   */
  keywordArguments?: boolean;
  /** Declarations of imported names, read from their files. */
  imports?: ReadonlyArray<ImportedDeclaration>;
  /** Classes the language knows (`TypeSystemInfo.classes`). */
  classes?: ReadonlyArray<EngineClass>;
  /**
   * The class the script extends (GDScript's `extends CharacterBody2D`):
   * its methods are called without a target (`move_and_slide()`).
   */
  selfClass?: string;
}

/** Pins of the arguments written in a call (`arg0`, `arg1`, …). */
export const ARG_PIN = /^arg\d+$/;

/** Offset of the `)` that closes a call node's arguments. */
export function callClose(text: string, node: GraphNode): number | undefined {
  const close = text.lastIndexOf(')', node.range.end - 1);
  return close >= node.range.start ? close : undefined;
}

function literalKind(param: SymbolParam): LiteralKind {
  switch (param.dataType) {
    case 'string': {
      return 'string';
    }

    case 'number': {
      return 'number';
    }

    case 'bool': {
      return 'boolean';
    }

    default: {
      return 'undefined';
    }
  }
}

/** The default value of a parameter as code, or `''`. */
function defaultOf(text: string, param: SymbolParam): string {
  return param.defaultRange
    ? text.slice(param.defaultRange.start, param.defaultRange.end)
    : (param.defaultText ?? '');
}

/**
 * The function a call node calls, when the file declares it or imports it
 * (`fn()`, `ns.fn()`, `module.fn()`).
 */
/** The type of the value wired into a call's target (`area` → `Area2D`). */
function targetType(fn: FunctionGraph, node: GraphNode): string | undefined {
  const edge = fn.edges.find(
    (e) => e.to.node === node.id && e.to.pin === 'target'
  );
  const source = edge
    ? fn.nodes
        .find((n) => n.id === edge.from.node)
        ?.pins.find((p) => p.id === edge.from.pin)
    : undefined;
  return source ? String(source.type) : undefined;
}

/** The declared type of a variable a call is made on (`barrel.look_at()`). */
function variableType(
  symbols: ReadonlyArray<ScriptSymbol>,
  owner: ScriptSymbol | undefined,
  name: string
): string | undefined {
  const scope = owner ? qualifiedName(owner) : undefined;
  const variable =
    symbols.find(
      (s) => s.name === name && s.kind === 'local' && s.scope === scope
    ) ??
    symbols.find(
      (s) =>
        s.name === name &&
        s.scope === '' &&
        (s.kind === 'variable' || s.kind === 'constant')
    );
  return variable?.type?.text;
}

function calledSymbol(
  text: string,
  doc: GraphDocument,
  fn: FunctionGraph,
  node: GraphNode,
  imports: ReadonlyMap<string, ImportedDeclaration>,
  options: CallPinOptions
): ScriptSymbol | undefined {
  const symbols = doc.symbols ?? [];
  const owner = symbols.find(
    (s) => s.fnId === fn.id && (s.kind === 'function' || s.kind === 'method')
  );
  const target = node.pins.find((p) => p.id === 'target' && p.range);
  const targetText = target?.range
    ? text.slice(target.range.start, target.range.end)
    : undefined;
  const title = node.title.replace(/\?\.\(\)$/, '');
  const self =
    targetText === 'this' ||
    targetText === 'self' ||
    /^(?:this|self)\./.test(title);
  const name = title.split('.').at(-1) ?? title;
  const engine = (cls: string | undefined): ScriptSymbol | undefined =>
    classMethod(options.classes, cls, name);

  if (self) {
    // A method of the class the calling method belongs to (or of the
    // class the script extends).
    const cls = owner?.kind === 'method' ? owner.scope : '';
    return (
      symbols.find(
        (s) =>
          s.name === name &&
          s.scope === cls &&
          (s.kind === 'method' || s.kind === 'function')
      ) ?? (cls === '' ? engine(options.selfClass) : undefined)
    );
  }

  // `ns.fn()`: a function of an imported module; `value.fn()`: a method of
  // the value's class; `Input.fn()`: a method of a global object.
  const module =
    targetText ?? (title.includes('.') ? title.split('.')[0] : undefined);
  if (module) {
    return (
      moduleImport(symbols, imports, module)?.members?.find(
        (s) => s.name === name && s.kind === 'function'
      ) ??
      engine(targetType(fn, node)) ??
      engine(variableType(symbols, owner, module)) ??
      engine(
        options.classes?.find((c) => c.singleton && c.name === module)?.name
      )
    );
  }

  if (title.includes('.') || target) {
    return undefined;
  }

  const imported = imports.get(name)?.declaration;
  return (
    symbols.find(
      (s) => s.name === name && s.scope === '' && s.kind === 'function'
    ) ??
    (imported?.kind === 'function' ? imported : undefined) ??
    engine(options.selfClass)
  );
}

/**
 * Calls of imported functions get the output of their declaration: its
 * type, or no pin for functions without a result (unless wired).
 */
function typeResult(
  fn: FunctionGraph,
  node: GraphNode,
  symbol: ScriptSymbol
): void {
  const at = node.pins.findIndex((p) => p.id === 'return');
  const pin = node.pins[at];
  if (!pin || symbol.returnType === undefined) {
    return;
  }

  if (symbol.returnType === 'void') {
    const wired = fn.edges.some(
      (e) => e.from.node === node.id && e.from.pin === 'return'
    );
    if (!wired) {
      node.pins.splice(at, 1);
    }
  } else if (pin.type === 'any') {
    pin.type = symbol.returnType;
  }
}

/**
 * Whether a call to these parameters takes more arguments than any count
 * written (a `...rest` / `*args` parameter): UE's "Add pin +".
 */
export function takesMoreArguments(
  params: ReadonlyArray<SymbolParam>
): boolean {
  return params.some((p) => p.rest && !p.keywords);
}

/** The type of one value of a `...rest` / `*args` parameter. */
function restElementType(param: SymbolParam): DataType {
  return param.dataType === 'array' || param.dataType.endsWith('[]')
    ? arrayElementType(param.dataType)
    : param.dataType;
}

/**
 * The first, empty pin of a `...rest` parameter without values (`data[0]`
 * of `console.log()`); "Add argument pin" adds the next ones.
 */
function restPin(
  param: SymbolParam,
  gap: number,
  given: number,
  close: number,
  options: Pick<CallPinOptions, 'placeholder'>
): Pin {
  // Skipped parameters before it get a placeholder.
  const fill = Array.from({ length: gap }, () => `${options.placeholder}, `);
  const type = restElementType(param);
  const meta: InputPinMeta = {
    insertInitAt: close,
    insertPrefix: `${given > 0 ? ', ' : ''}${fill.join('')}`,
    optional: true,
  };
  return {
    id: `param:${param.name}`,
    name: `${param.name}[0]`,
    direction: 'in',
    kind: 'data',
    type,
    literal: {
      value: '',
      raw: '',
      kind: literalKind({ ...param, dataType: type }),
      editable: true,
    },
    meta: { ...meta },
  };
}

/** The parameter an argument is passed to by name (`timeout=5`). */
function keywordOf(pin: Pin): string | undefined {
  return getMeta<InputPinMeta>(pin).keyword;
}

/**
 * The pins of a call node completed from the parameters it calls, like
 * UE's call nodes: given arguments get their parameter's name, type and
 * default ("Reset to default"); missing ones become unconnected pins that
 * insert the argument when they get a value or a wire. Returns new pins;
 * the node's own are left alone.
 */
export function withParamPins(
  text: string,
  node: GraphNode,
  params: ReadonlyArray<SymbolParam>,
  options: Pick<CallPinOptions, 'placeholder' | 'keywordArguments'>
): Pin[] {
  const pins = node.pins.map((p) => ({ ...p }));
  const args = pins.filter(
    (p) => p.direction === 'in' && p.kind === 'data' && ARG_PIN.test(p.id)
  );
  const keywords = new Set(args.flatMap((p) => keywordOf(p) ?? []));
  const positional = args.filter(
    (p) =>
      keywordOf(p) === undefined &&
      getMeta<InputPinMeta>(p).spread === undefined
  );

  // Positional arguments from a `*rest` parameter on all belong to it.
  const restAt = params.findIndex((p) => p.rest && !p.keywords);
  const paramAt = (index: number): SymbolParam | undefined =>
    restAt !== -1 && index >= restAt ? params[restAt] : params[index];

  // Given arguments know their parameter's default ("Reset to default").
  for (const pin of args) {
    const keyword = keywordOf(pin);
    const param =
      keyword === undefined
        ? paramAt(positional.indexOf(pin))
        : params.find((p) => p.name === keyword);
    const value = param && !param.rest ? defaultOf(text, param) : '';
    if (value !== '') {
      pin.meta = { ...pin.meta, defaultValue: value };
    }

    // Positional ones get their type below; one passed by name here.
    if (keyword !== undefined && param && pin.type === 'any') {
      pin.type = param.dataType;
    }
  }

  // Types of the given arguments come from the parameters.
  for (const [index, pin] of positional.entries()) {
    const param = paramAt(index);
    if (param && !param.rest && pin.type === 'any') {
      pin.type = param.dataType;
    }

    // Functions declared elsewhere are unknown while lowering: name them.
    if (param && !param.rest && pin.name === '') {
      pin.name = param.name;
    }

    // Values of a `...rest` parameter, like UE's Make Array: `data[0]`.
    if (param?.rest) {
      pin.name = `${param.name}[${index - restAt}]`;
      if (pin.type === 'any') {
        pin.type = restElementType(param);
      }
    }
  }

  // A spread from a `...rest` parameter on fills it too: `...data[1]`.
  const rest = restAt === -1 ? undefined : params[restAt];
  const unnamed = args.filter((p) => keywordOf(p) === undefined);
  for (const [index, pin] of unnamed.entries()) {
    if (rest && index >= restAt && getMeta<InputPinMeta>(pin).spread) {
      pin.name = `${rest.name}[${index - restAt}]`;
    }
  }

  const close = callClose(text, node);
  if (close === undefined || positional.length < args.length - keywords.size) {
    return pins;
  }

  const added: Pin[] = [];
  for (const [index, param] of params.entries()) {
    // After a `*rest` parameter only keywords reach a parameter.
    const afterRest = restAt !== -1 && index > restAt;
    if (index === restAt && positional.length <= index) {
      added.push(
        restPin(param, index - positional.length, args.length, close, options)
      );
      continue;
    }

    if (
      param.rest ||
      keywords.has(param.name) ||
      (afterRest ? !options.keywordArguments : index < positional.length)
    ) {
      continue;
    }

    let prefix: string;
    if (options.keywordArguments) {
      // The next parameter in order is written like code usually is:
      // positionally (`fetch("Berlin")`); later ones by name, so the
      // defaults of the skipped ones stay.
      const next =
        index === positional.length && keywords.size === 0 && !afterRest;
      prefix = `${args.length > 0 ? ', ' : ''}${next ? '' : `${param.name}=`}`;
    } else {
      // Skipped parameters before this one get a placeholder.
      const gap = index - positional.length;
      const fill = Array.from({ length: gap }, () => options.placeholder);
      prefix = `${args.length > 0 ? ', ' : ''}${fill.map((v) => `${v}, `).join('')}`;
    }

    const meta: InputPinMeta = {
      insertInitAt: close,
      insertPrefix: prefix,
      optional: true,
    };
    added.push({
      id: `param:${param.name}`,
      name: param.name,
      direction: 'in',
      kind: 'data',
      type: param.dataType,
      literal: {
        value: defaultOf(text, param),
        raw: '',
        kind: literalKind(param),
        editable: true,
      },
      meta: { ...meta },
    });
  }

  // After the last input, before the outputs.
  const at = pins.findLastIndex((p) => p.direction === 'in') + 1;
  pins.splice(at, 0, ...added);
  return inSignatureOrder(pins, params, (pin) => {
    const keyword = keywordOf(pin);
    if (keyword !== undefined) {
      return params.findIndex((p) => p.name === keyword);
    }

    const index = positional.indexOf(pin);
    return index === -1
      ? undefined
      : Math.min(index, restAt === -1 ? index : restAt);
  });
}

/**
 * The argument and parameter pins of a call in the order of the signature,
 * like UE's call nodes: `urlopen(url, timeout=5)` shows `url`, `data`,
 * `timeout`. Pins without a parameter (`**kwargs` values) stay after the
 * pin before them; other pins keep their place.
 */
function inSignatureOrder(
  pins: Pin[],
  params: ReadonlyArray<SymbolParam>,
  positionOf: (pin: Pin) => number | undefined
): Pin[] {
  const slots: number[] = [];
  for (const [i, pin] of pins.entries()) {
    if (
      pin.direction === 'in' &&
      pin.kind === 'data' &&
      (ARG_PIN.test(pin.id) || pin.id.startsWith('param:'))
    ) {
      slots.push(i);
    }
  }

  let last = -1;
  const keyed = slots.map((slot, order) => {
    const pin = pins[slot] as Pin;
    const named = pin.id.startsWith('param:')
      ? params.findIndex((p) => `param:${p.name}` === pin.id)
      : positionOf(pin);
    // Unknown positions follow the pin before them.
    last = named === undefined || named === -1 ? last : named;
    return { pin, key: last, order };
  });
  const sorted = keyed.toSorted((a, b) => a.key - b.key || a.order - b.order);
  for (const [i, slot] of slots.entries()) {
    pins[slot] = (sorted[i] as (typeof sorted)[number]).pin;
  }

  return pins;
}

/**
 * The import a call's module is: by its local name (`math`, `np`), or by
 * its dotted path (`urllib.request`, while `import urllib.request` binds
 * the name `urllib`).
 */
function moduleImport(
  symbols: ReadonlyArray<ScriptSymbol>,
  imports: ReadonlyMap<string, ImportedDeclaration>,
  module: string
): ImportedDeclaration | undefined {
  const named = imports.get(module);
  if (named || !module.includes('.')) {
    return named;
  }

  const whole = symbols.find(
    (s) => s.kind === 'import' && s.imported === '*' && s.module === module
  );
  return whole ? imports.get(whole.name) : undefined;
}

/** `pins` with the names of the same inputs among `named`. */
export function namedPins(
  pins: ReadonlyArray<Pin>,
  named: ReadonlyArray<Pin>
): Pin[] {
  return pins.map((pin) => {
    const name = named.find((p) => p.id === pin.id)?.name;
    return pin.direction === 'in' && name !== undefined && name !== pin.name
      ? { ...pin, name }
      : pin;
  });
}

/**
 * A container node (with `pins`) named by the signature it calls (`named`
 * completes a node's pins from it): the pins of its fixed values
 * (`CallLook.hidden`, shown in its call view) take part, so the values
 * after them get their own names.
 */
export function namedContainerNode(
  node: GraphNode,
  pins: ReadonlyArray<Pin>,
  named: (all: GraphNode) => ReadonlyArray<Pin>
): GraphNode {
  const container = getMeta<ContainerNodeMeta>(node).container;
  const call = container?.call;
  const hidden = call?.hidden ?? [];
  const order = new Map((call?.order ?? []).map((id, i) => [id, i]));
  const rank = (pin: Pin): number => order.get(pin.id) ?? order.size;
  const result = named({
    ...node,
    pins: [...pins, ...hidden].toSorted((a, b) => rank(a) - rank(b)),
  });
  return {
    ...node,
    pins: namedPins(pins, result),
    ...(container && call && hidden.length > 0
      ? {
          meta: {
            ...node.meta,
            container: {
              ...container,
              call: { ...call, hidden: namedPins(hidden, result) },
            },
          } satisfies ContainerNodeMeta,
        }
      : {}),
  };
}

/**
 * Completes the input pins of calls to functions of the same file, like
 * UE's call nodes: every parameter is a pin, named and typed like it.
 * Missing arguments become unconnected pins that insert the argument when
 * they get a value or a wire.
 */
export function completeCallPins(
  doc: GraphDocument,
  text: string,
  options: CallPinOptions
): void {
  const imports = new Map((options.imports ?? []).map((i) => [i.name, i]));
  const own = new Set(doc.symbols ?? []);
  for (const fn of doc.functions) {
    for (const node of fn.nodes) {
      if (node.kind !== 'call') {
        continue;
      }

      const symbol = calledSymbol(text, doc, fn, node, imports, options);
      if (isContainerNode(node)) {
        // Container nodes (LENGTH, ADD …) keep their pins and types: they
        // take the values they show. The signature names them.
        const params = symbol?.params;
        if (params) {
          const named = namedContainerNode(node, node.pins, (all) =>
            withParamPins(text, all, params, options)
          );
          node.pins = named.pins;
          node.meta = named.meta;
        }

        continue;
      }

      if (symbol && !own.has(symbol)) {
        typeResult(fn, node, symbol);
      }

      const params = symbol?.params;
      if (symbol && params) {
        node.pins = withParamPins(text, node, params, options);
        if (takesMoreArguments(params)) {
          node.addPin = true;
        }
      }
    }
  }
}
