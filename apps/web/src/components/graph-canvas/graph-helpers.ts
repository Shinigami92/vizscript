import type {
  DataType,
  GraphDocument,
  GraphNode,
  GraphOp,
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
  placeholder: string,
  first?: string
): string {
  return template.replaceAll(/\$(\d)/g, (_, n: string) =>
    n === '1' && first !== undefined ? first : placeholder
  );
}

/**
 * The value a new Set of a variable starts with: its type's default (`0` for
 * an `int`), so the value pin is typed; otherwise the language's placeholder.
 */
export function typeDefault(
  types: TypeSystemInfo | null | undefined,
  type: string | undefined
): string | undefined {
  return types?.primitives.find((t) => t.name === type)?.defaultValue;
}

/** A value picked for an input from the action menu goes where it opened. */
export function withPosition(op: GraphOp, world: Point): GraphOp {
  if (op.type === 'withImport') {
    return { ...op, op: withPosition(op.op, world) };
  }

  return op.type === 'setInput' && !op.position
    ? { ...op, position: world }
    : op;
}

/** An op using a name of another file, with that name's import. */
export function withImport(external: ExternalName, op: GraphOp): GraphOp {
  return { type: 'withImport', import: { ...external.request }, op };
}

/**
 * Variables of a function: its parameters and locals, the fields of its
 * class and the module's variables.
 */
export function scopeVariables(
  doc: GraphDocument | null,
  fnId: string | undefined
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

/** Variables that can be read in the function of `nodeId`, with types. */
export function variablesNear(index: DocIndex, nodeId: string): Variable[] {
  const fn = index.nodes.get(nodeId)?.fn;
  const found = new Map<string, string>();
  const add = (name: string, type: string): void => {
    if (/^[A-Za-z_$][\w$]*$/.test(name) && !found.has(name)) {
      found.set(name, type);
    }
  };

  for (const node of fn?.nodes ?? []) {
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
} {
  const nodes = ids
    .map((id) => index.nodes.get(id)?.node)
    .filter((n): n is GraphNode => n !== undefined);
  const ranges = nodes
    .map((node) => ({
      node,
      range: getMeta<StatementMeta>(node).stmt ?? node.range,
    }))
    .filter(({ range }) => range.end > range.start);
  const outer = ranges
    .filter(
      (a) =>
        !ranges.some(
          (b) =>
            b !== a &&
            b.range.start <= a.range.start &&
            a.range.end <= b.range.end &&
            (b.range.start < a.range.start || b.range.end > a.range.end)
        )
    )
    .toSorted((a, b) => a.range.start - b.range.start);
  const code = outer
    .map(({ range }) => {
      const lineStart = text.lastIndexOf('\n', range.start - 1) + 1;
      const before = text.slice(lineStart, range.start);
      const indent = /^[ \t]*$/.test(before) ? before : '';
      return indent + text.slice(range.start, range.end);
    })
    .join('\n');
  return {
    code,
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
