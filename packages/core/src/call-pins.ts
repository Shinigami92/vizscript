import type { InputPinMeta } from './edit-meta';
import type { EngineClass } from './engine-classes';
import { classMethod } from './engine-classes';
import type { ImportedDeclaration } from './imports';
import type {
  FunctionGraph,
  GraphDocument,
  GraphNode,
  LiteralKind,
  Pin,
} from './ir';
import type { ScriptSymbol, SymbolParam } from './symbols';
import { qualifiedName } from './symbols';

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
      imports
        .get(module)
        ?.members?.find((s) => s.name === name && s.kind === 'function') ??
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
  const keywords = new Set(
    args
      .map((p) => p.name)
      .filter((n) => n.endsWith('='))
      .map((n) => n.slice(0, -1))
  );
  const positional = args.filter(
    (p) => !p.name.endsWith('=') && p.name !== '...' && !p.name.startsWith('*')
  );

  // Positional arguments from a `*rest` parameter on all belong to it.
  const restAt = params.findIndex((p) => p.rest);
  const paramAt = (index: number): SymbolParam | undefined =>
    restAt !== -1 && index >= restAt ? params[restAt] : params[index];

  // Given arguments know their parameter's default ("Reset to default").
  for (const pin of args) {
    const param = pin.name.endsWith('=')
      ? params.find((p) => `${p.name}=` === pin.name)
      : paramAt(positional.indexOf(pin));
    const value = param && !param.rest ? defaultOf(text, param) : '';
    if (value !== '') {
      pin.meta = { ...pin.meta, defaultValue: value };
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
  }

  const close = callClose(text, node);
  if (close === undefined || positional.length < args.length - keywords.size) {
    return pins;
  }

  const added: Pin[] = [];
  for (const [index, param] of params.entries()) {
    // After a `*rest` parameter only keywords reach a parameter.
    const afterRest = restAt !== -1 && index > restAt;
    if (
      param.rest ||
      keywords.has(param.name) ||
      (afterRest ? !options.keywordArguments : index < positional.length)
    ) {
      continue;
    }

    let prefix: string;
    if (options.keywordArguments) {
      prefix = `${args.length > 0 ? ', ' : ''}${param.name}=`;
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
  return pins;
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
      if (symbol && !own.has(symbol)) {
        typeResult(fn, node, symbol);
      }

      const params = symbol?.params;
      if (symbol && params) {
        node.pins = withParamPins(text, node, params, options);
      }
    }
  }
}
