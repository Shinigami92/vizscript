import type {
  DataType,
  ExpressionTemplate,
  GraphDocument,
  GraphNode,
  GraphOp,
  NodeCodeMeta,
  Pin,
  PinRef,
  Point,
  ScriptSymbol,
  StatementMeta,
  TypeSystemInfo,
} from '@vizscript/core';
import {
  calleeText,
  getMeta,
  isTypeCompatible,
  qualifiedName,
} from '@vizscript/core';
import type { DocIndex } from '../../graph/doc-index';
import type { ExternalName } from '../../graph/project-index';
import { signature } from '../../graph/project-index';
import { isTypeImport } from '../../graph/symbols';
import { IDENTIFIER_PATH } from './menu-data';

export interface Variable {
  name: string;
  type: string;
}

/** A variable a function can read and set (UE: Get / Set in the menu). */
export interface ScopeVariable {
  /** As written in the function (`score`, `this.speed`, `self.hp`). */
  expression: string;
  dataType: DataType;
  /** Type as written, for the hint. */
  type: string;
  constant: boolean;
}

/** `this.x` / `self.x` for members used inside a method of their class. */
export function memberAccess(
  symbol: ScriptSymbol,
  owner: ScriptSymbol | undefined,
  language: string
): string | undefined {
  const isMember =
    symbol.scope !== '' &&
    symbol.kind !== 'local' &&
    !(language === 'gdscript' && symbol.scope === '');
  if (!isMember) {
    return symbol.name;
  }

  if (owner?.kind !== 'method' || owner.scope !== symbol.scope) {
    return undefined;
  }

  return `${language === 'typescript' ? 'this' : 'self'}.${symbol.name}`;
}

/** Fills `$1`, `$2` … of an expression template (`first` goes into `$1`). */
export function fillTemplate(
  template: string,
  placeholder: string | ((slot: number) => string),
  first?: string
): string {
  return template.replaceAll(/\$(\d)/g, (_, n: string) => {
    if (n === '1' && first !== undefined) {
      return first;
    }

    return typeof placeholder === 'string'
      ? placeholder
      : placeholder(Number(n));
  });
}

/**
 * The value of an empty input of an operator: the template's (`x * 1`),
 * else for operators of the type they make (`+`, `??`) the empty value of
 * the wire's type (`s + ''`), else the language's placeholder.
 */
export function emptyInput(
  expression: ExpressionTemplate,
  slot: number,
  types: TypeSystemInfo | null | undefined,
  wireType?: DataType
): string {
  const { empty } = expression;
  const given = typeof empty === 'string' ? empty : empty?.[slot - 1];
  const option =
    expression.result === undefined && wireType && wireType !== 'any'
      ? types?.primitives.find((t) => t.dataType === wireType)
      : undefined;
  // A default that is a node of its own would add a second node.
  const typed = option?.defaultIsNode ? undefined : option?.defaultValue;
  return given ?? typed ?? types?.placeholder ?? 'undefined';
}

/**
 * The value a new Set of a variable starts with: its type's default (`0` for
 * an `int`), so the value pin is typed; otherwise (also for a default that
 * is a node of its own, `Vector2.ZERO`) the language's placeholder.
 */
export function typeDefault(
  types: TypeSystemInfo | null | undefined,
  type: string | undefined
): string | undefined {
  const option = types?.primitives.find((t) => t.name === type);
  return option?.defaultIsNode ? undefined : option?.defaultValue;
}

/** A value picked for an input from the action menu goes where it opened. */
export function withPosition(op: GraphOp, world: Point): GraphOp {
  if (op.type === 'withImport') {
    return { ...op, op: withPosition(op.op, world) };
  }

  return (op.type === 'setInput' || op.type === 'makeValue') && !op.position
    ? { ...op, position: world }
    : op;
}

/** An op using a name of another file, with that name's import. */
export function withImport(external: ExternalName, op: GraphOp): GraphOp {
  return { type: 'withImport', import: { ...external.request }, op };
}

/**
 * Variables of a function: its parameters and locals, the fields of its
 * class and the module's variables. With `at` (an offset in the code),
 * only locals declared before it, and in the file's top-level code only
 * module variables declared before it.
 */
export function scopeVariables(
  doc: GraphDocument | null,
  fnId: string | undefined,
  at?: number
): ScopeVariable[] {
  if (!doc || !fnId) {
    return [];
  }

  const symbols = doc.symbols ?? [];
  const owner = symbols.find(
    (s) => s.fnId === fnId && (s.kind === 'function' || s.kind === 'method')
  );
  const scope = owner ? qualifiedName(owner) : undefined;
  const found = new Map<string, ScopeVariable>();
  const add = (variable: ScopeVariable): void => {
    if (!found.has(variable.expression)) {
      found.set(variable.expression, variable);
    }
  };

  for (const param of owner?.params ?? []) {
    if (!param.rest) {
      add({
        expression: param.name,
        dataType: param.dataType,
        type: param.type?.text ?? String(param.dataType),
        constant: false,
      });
    }
  }

  for (const symbol of symbols) {
    const local = symbol.kind === 'local' && symbol.scope === scope;
    if (!local && symbol.kind !== 'variable' && symbol.kind !== 'constant') {
      continue;
    }

    // A loop's variable (whose range is the loop) is there from its name.
    const within = symbol.visibleIn;
    const declared =
      within && symbol.range.end >= within.end
        ? symbol.nameRange.end
        : symbol.range.end;
    const ordered = local || (!owner && symbol.scope === '');
    if (ordered && at !== undefined && declared > at) {
      continue;
    }

    // A loop's variable after the loop, a block's `let` outside it.
    if (
      local &&
      at !== undefined &&
      within &&
      (at < within.start || at > within.end)
    ) {
      continue;
    }

    const expression = local
      ? symbol.name
      : memberAccess(symbol, owner, doc.language);
    if (expression) {
      add({
        expression,
        dataType: symbol.dataType,
        type: symbol.type?.text ?? String(symbol.dataType),
        constant:
          symbol.kind === 'constant' ||
          symbol.modifiers.includes('const') ||
          symbol.modifiers.includes('readonly'),
      });
    }
  }

  return [...found.values()].toSorted((a, b) =>
    a.expression.localeCompare(b.expression)
  );
}

/** A global object a Get can read (`console`, Godot's `Input`, `json`). */
export interface GlobalObject {
  name: string;
  /** Where it comes from: `global`, `singleton` or `import`. */
  hint: string;
}

/**
 * Objects every script can read without declaring them, like UE's Get of a
 * global: the objects of the built-in functions (`console` of
 * `console.log`), engine singletons and imported modules or classes.
 */
export function globalObjects(
  doc: GraphDocument | null,
  types: TypeSystemInfo | null | undefined
): GlobalObject[] {
  const found = new Map<string, GlobalObject>();
  for (const name of types?.globals ?? []) {
    const root = name.includes('.') ? name.split('.')[0] : undefined;
    if (root && /^[A-Za-z_$][\w$]*$/.test(root) && !found.has(root)) {
      found.set(root, { name: root, hint: 'global' });
    }
  }

  for (const cls of types?.classes ?? []) {
    if (cls.singleton && !found.has(cls.name)) {
      found.set(cls.name, { name: cls.name, hint: 'singleton' });
    }
  }

  // Functions are called, not read.
  for (const symbol of doc?.symbols ?? []) {
    if (
      symbol.kind === 'import' &&
      symbol.importedKind !== 'function' &&
      !isTypeImport(symbol) &&
      !found.has(symbol.name)
    ) {
      found.set(symbol.name, { name: symbol.name, hint: 'import' });
    }
  }

  return [...found.values()];
}

/** First parameter and result types of a function of the file. */
export function callSignature(
  doc: GraphDocument | null,
  text: string,
  callee: string
): {
  first?: DataType;
  returns?: DataType;
  detail?: string;
} {
  const name = callee.replace(/^(?:this|self)\./, '');
  const symbol = doc?.symbols?.find(
    (s) =>
      s.name === name &&
      s.params !== undefined &&
      (s.kind === 'function' || s.kind === 'method' || s.kind === 'import')
  );
  if (!symbol) {
    return {};
  }

  // UE's action tooltip: the signature, then the description.
  const typed = signature(symbol, text);
  const about = symbol.fnId
    ? doc?.functions
        .find((f) => f.id === symbol.fnId)
        ?.nodes.find((n) => n.kind === 'entry')?.comment?.text
    : undefined;
  return typed.detail && about
    ? { ...typed, detail: `${typed.detail}\n\n${about}` }
    : typed;
}

/** UE's Context Sensitive: does a value of `from` fit into `to`? */
export function fitsType(
  from: DataType | undefined,
  to: DataType | undefined
): boolean | undefined {
  return from === undefined || to === undefined
    ? undefined
    : isTypeCompatible(from, to);
}

/**
 * Where the code of `nodeId` starts, for the variables declared before it;
 * `undefined` for a node not in the code yet (it can go anywhere).
 */
export function codeOffset(
  index: DocIndex,
  nodeId: string
): number | undefined {
  const node = index.nodes.get(nodeId)?.node;
  return !node || node.graphOnly || node.floating
    ? undefined
    : node.range.start;
}

/**
 * Whether the names `declarer` binds can be read by `target`: declared
 * before it, or a loop's variable inside that loop.
 */
function readableAt(
  declarer: GraphNode,
  target: GraphNode | undefined
): boolean {
  if (
    !target ||
    target.graphOnly ||
    target.floating ||
    declarer.graphOnly ||
    declarer.floating ||
    declarer.kind === 'entry'
  ) {
    return true;
  }

  if (declarer.kind === 'forEach') {
    return (
      declarer !== target &&
      declarer.range.start <= target.range.start &&
      target.range.end <= declarer.range.end
    );
  }

  return declarer.range.end <= target.range.start;
}

/**
 * Variables that can be read at the node `nodeId` (declared before it in
 * its function), with types.
 */
export function variablesNear(index: DocIndex, nodeId: string): Variable[] {
  const entry = index.nodes.get(nodeId);
  const fn = entry?.fn;
  const found = new Map<string, string>();
  const add = (name: string, type: string): void => {
    if (/^[A-Za-z_$][\w$]*$/.test(name) && !found.has(name)) {
      found.set(name, type);
    }
  };

  for (const node of fn?.nodes ?? []) {
    if (!readableAt(node, entry?.node)) {
      continue;
    }

    const out = node.pins.find(
      (p) => p.kind === 'data' && p.direction === 'out'
    );
    if (node.kind === 'entry' || node.kind === 'forEach') {
      for (const pin of node.pins) {
        if (pin.kind === 'data' && pin.direction === 'out') {
          add(pin.name.replace(/^\*+/, ''), String(pin.type));
        }
      }
    } else if (Array.isArray(node.meta?.declares)) {
      // Declarations name what they bind (including destructuring).
      const names = (node.meta.declares as unknown[]).filter(
        (n): n is string => typeof n === 'string'
      );
      for (const name of names) {
        add(name, names.length === 1 ? String(out?.type ?? 'any') : 'any');
      }
    } else if (
      node.kind === 'setVar' &&
      /^Set [A-Za-z_$][\w$]*$/.test(node.title)
    ) {
      add(node.title.slice(4), String(out?.type ?? 'any'));
    }
  }

  return [...found]
    .map(([name, type]) => ({ name, type }))
    .toSorted((a, b) => a.name.localeCompare(b.name));
}

/** Functions worth offering: called in this file, defined, or imported. */
export function collectCallables(
  doc: GraphDocument | null,
  text: string,
  imports: ReadonlyArray<string> | undefined,
  globals: ReadonlyArray<string> | undefined
): string[] {
  const names = new Set<string>();
  for (const fn of doc?.functions ?? []) {
    // Not the file's top-level graph ("Module").
    const topLevel = fn.range.start === 0 && fn.range.end >= text.length;
    if (!topLevel && /^[A-Za-z_$][\w$]*$/.test(fn.name)) {
      names.add(fn.name);
    }

    for (const node of fn.nodes) {
      const callee = node.kind === 'call' ? calleeText(text, node) : '';
      if (IDENTIFIER_PATH.test(callee)) {
        names.add(callee);
      }
    }
  }

  // Signals are emitted like a call (`score_changed.emit(…)`).
  for (const symbol of doc?.symbols ?? []) {
    if (symbol.kind === 'signal' && /^[A-Za-z_]\w*$/.test(symbol.name)) {
      names.add(`${symbol.name}.emit`);
    }
  }

  for (const name of imports ?? []) {
    names.add(name);
  }

  // The file's own names first, then built-ins (`console.log`, `print`).
  const own = [...names].toSorted((a, b) => a.localeCompare(b));
  return [...own, ...(globals ?? []).filter((name) => !names.has(name))];
}

/** Names of other files and libraries not offered as callables already. */
export function newExternalNames(
  callables: ReadonlyArray<string>,
  externals: ReadonlyArray<ExternalName> | undefined
): ExternalName[] {
  // Once per callee (a library may declare a name twice, e.g. as a type).
  const known = new Set(callables);
  return (externals ?? []).filter((e) => {
    if (known.has(e.callee)) {
      return false;
    }

    known.add(e.callee);
    return true;
  });
}

export function suggestName(pin: Pin): string {
  if (/^[A-Za-z_$][\w$]*$/.test(pin.name)) {
    return pin.name;
  }

  // `&"parameters/move/blend_amount"` → `blend_amount`
  const words = (pin.literal?.value ?? '').match(/[A-Za-z_][\w]*/g);
  return words?.at(-1) ?? 'value';
}

/**
 * The code of the selected nodes, like UE copies nodes: whole statements
 * (with their pure inputs, which are part of them), outermost first, each
 * with its line's indentation so nested lines keep their place.
 */
export function selectionCode(
  index: DocIndex,
  text: string,
  ids: ReadonlyArray<string>
): {
  code: string;
  statements: GraphNode[];
  /** Only a value (a pure node): it has no statement end yet. */
  expression: boolean;
} {
  const nodes = ids
    .map((id) => index.nodes.get(id)?.node)
    .filter((n): n is GraphNode => n !== undefined);
  const ranges = nodes
    .map((node) => ({
      node,
      statement: getMeta<StatementMeta>(node).stmt !== undefined,
      range: getMeta<StatementMeta>(node).stmt ?? node.range,
      /** Its own code differs from its range's (`x in items` of `not in`). */
      own: getMeta<NodeCodeMeta>(node).code,
    }))
    .filter(({ range }) => range.end > range.start);
  const covers = (
    b: (typeof ranges)[number],
    a: (typeof ranges)[number]
  ): boolean =>
    b.range.start <= a.range.start &&
    a.range.end <= b.range.end &&
    (b.range.start < a.range.start ||
      b.range.end > a.range.end ||
      // Same range (`x not in items` as CONTAINS → NOT): the one whose
      // code is the range's covers the other, so it is copied once.
      (a.own !== undefined && b.own === undefined));
  const outer = ranges
    .filter((a) => !ranges.some((b) => b !== a && covers(b, a)))
    .toSorted((a, b) => a.range.start - b.range.start);
  const code = outer
    .map(({ range, own }) => {
      const lineStart = text.lastIndexOf('\n', range.start - 1) + 1;
      const before = text.slice(lineStart, range.start);
      const indent = /^[ \t]*$/.test(before) ? before : '';
      return indent + (own ?? text.slice(range.start, range.end));
    })
    .join('\n');
  return {
    code,
    expression: outer.length === 1 && outer[0]?.statement === false,
    statements: outer
      .map(({ node }) => node)
      .filter((n) => n.purity === 'impure'),
  };
}

/** Exec output that continues after a statement (`completed` of blocks). */
export function continuation(node: GraphNode): PinRef | undefined {
  const out =
    node.pins.find(
      (p) => p.kind === 'exec' && p.direction === 'out' && p.id === 'completed'
    ) ??
    node.pins.find(
      (p) => p.kind === 'exec' && p.direction === 'out' && p.id === 'then'
    );
  return out ? { node: node.id, pin: out.id } : undefined;
}

/** The name of a dragged value: a Get's variable, a function's input. */
export function valueName(node: GraphNode, pin: Pin): string | undefined {
  if (node.kind === 'getVar') {
    return node.title;
  }

  return node.kind === 'entry' ? pin.name : undefined;
}

/**
 * The method `callee` is of the dragged value, if it is one: functions of
 * the object itself (`console` → `console.log`, an input `items` →
 * `items.push`) are its methods, `.log()` on it, not `console.log(console)`.
 */
export function ownMethodName(
  node: GraphNode,
  pin: Pin,
  callee: string
): string | undefined {
  const owner = valueName(node, pin);
  const name =
    owner && callee.startsWith(`${owner}.`)
      ? callee.slice(owner.length + 1)
      : '';
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : undefined;
}
