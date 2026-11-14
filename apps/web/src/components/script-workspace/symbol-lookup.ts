import type {
  GraphDocument,
  ModuleReference,
  ScriptSymbol,
} from '@vizscript/core';
import { findNode, qualifiedName } from '@vizscript/core';

/** Where "Go to definition" of a node leads. */
export type DefinitionTarget =
  | { kind: 'file'; path: string; symbol?: string }
  | { kind: 'node'; nodeId: string; name: string; fnId: string };

/** A repository file (and name in it) a module reference points to. */
export type ResolveReference = (
  reference: ModuleReference
) => { path: string; symbol?: string } | undefined;

const DEFINITION_KINDS = new Set([
  'call',
  'getVar',
  'functionRef',
  'getProperty',
  'unknown',
]);

/** Where "Go to definition" of a node leads, if anywhere. */
export function findDefinitionTarget(
  d: GraphDocument | null,
  text: string,
  references: ReadonlyArray<ModuleReference>,
  resolveReference: ResolveReference,
  nodeId: string
): DefinitionTarget | undefined {
  const node = d ? findNode(d, nodeId) : undefined;
  if (!d || !node || !DEFINITION_KINDS.has(node.kind)) {
    return undefined;
  }

  // A callback: its own graph has the callback's range (before the
  // imported names its code uses).
  if (node.kind === 'functionRef') {
    const graph = d.functions.find(
      (f) =>
        f.range?.start === node.range.start && f.range.end === node.range.end
    );
    const entry = graph?.nodes.find((n) => n.kind === 'entry');
    if (graph && entry) {
      return {
        kind: 'node',
        nodeId: entry.id,
        name: graph.name,
        fnId: graph.id,
      };
    }
  }

  // Imported names used by the node itself (a call's callee, not its
  // arguments, which are nodes of their own).
  const paren = text.indexOf('(', node.range.start);
  const head =
    node.kind === 'call' && paren !== -1 && paren < node.range.end
      ? paren
      : node.range.end;
  const inside = references.filter(
    (r) => r.range.start >= node.range.start && r.range.end <= head
  );
  for (const reference of [
    ...inside.filter((r) => r.symbol),
    ...inside.filter((r) => !r.symbol),
  ]) {
    const target = resolveReference(reference);
    if (target) {
      return { kind: 'file', ...target };
    }
  }

  // A function of this file.
  if (node.kind === 'call' || node.kind === 'functionRef') {
    const name = node.title.replace(/^this\./, '');
    const own = d.functions.find((f) => f.nodes.includes(node));
    const fn =
      d.functions.find((f) => f !== own && f.name === name) ??
      d.functions.find((f) => f !== own && f.name.endsWith(`.${name}`));
    const entry = fn?.nodes.find((n) => n.kind === 'entry');
    if (fn && entry) {
      return { kind: 'node', nodeId: entry.id, name: fn.name, fnId: fn.id };
    }
  }

  return undefined;
}

/** "Go to definition (…)" of the graph's context menu. */
export function describeTarget(
  target: DefinitionTarget | undefined
): string | undefined {
  if (!target) {
    return undefined;
  }

  if (target.kind === 'node') {
    return target.name;
  }

  const file = target.path.split('/').at(-1) ?? target.path;
  return target.symbol ? `${target.symbol} · ${file}` : file;
}

/**
 * The variable of a single selected Get / Set node, like UE shows the
 * variable's details for its nodes. Locals of the node's function come
 * first, `self.x` / `this.x` are members of the method's class.
 */
export function variableOfNode(
  d: GraphDocument | null,
  selection: ReadonlyArray<string>
): ScriptSymbol | null {
  const id = selection.length === 1 ? selection[0] : undefined;
  const node = d && id ? findNode(d, id) : undefined;
  if (
    !d?.symbols ||
    !node ||
    (node.kind !== 'getVar' && node.kind !== 'setVar')
  ) {
    return null;
  }

  let name =
    node.kind === 'setVar' ? node.title.replace(/^Set /, '') : node.title;
  const member = /^(?:self|this)\./.test(name);
  name = name.replace(/^(?:self|this)\./, '');
  if (!/^#?[A-Za-z_$][\w$]*$/.test(name)) {
    return null;
  }

  const fn = d.functions.find((f) => f.nodes.includes(node));
  const owner = fn
    ? d.symbols.find((s) => s.fnId === fn.id && s.kind !== 'class')
    : undefined;
  const isVariable = (s: ScriptSymbol): boolean =>
    s.name === name &&
    (s.kind === 'variable' || s.kind === 'constant' || s.kind === 'local');
  const local =
    !member && owner
      ? d.symbols.find(
          (s) =>
            isVariable(s) &&
            s.kind === 'local' &&
            s.scope === qualifiedName(owner)
        )
      : undefined;
  const classScope = owner?.kind === 'method' ? owner.scope : '';
  return (
    local ??
    (member
      ? d.symbols.find(
          (s) => isVariable(s) && s.kind !== 'local' && s.scope === classScope
        )
      : undefined) ??
    d.symbols.find(
      (s) => isVariable(s) && s.kind !== 'local' && s.scope === ''
    ) ??
    null
  );
}

/** Function whose local variables "My Script" lists. */
export function currentFunctionOf(
  d: GraphDocument | null,
  symbol: ScriptSymbol | null,
  selection: ReadonlyArray<string>,
  focusFn: string | null
): string | null {
  if (symbol?.kind === 'local') {
    return symbol.scope;
  }

  if (symbol?.kind === 'function' || symbol?.kind === 'method') {
    return qualifiedName(symbol);
  }

  // The selected node's function, else the one open on its own.
  const first = selection[0];
  const fn = first
    ? d?.functions.find((f) => f.nodes.some((n) => n.id === first))
    : focusFn
      ? d?.functions.find((f) => f.id === focusFn)
      : undefined;
  const owner = fn
    ? d?.symbols?.find((s) => s.fnId === fn.id && s.kind !== 'class')
    : undefined;
  return owner ? qualifiedName(owner) : null;
}

/**
 * The graphs a callback's graph sits in, outermost first, like UE's graph
 * hierarchy (`_ready` › `area_entered.connect callback`).
 */
export function parentGraphs(
  d: GraphDocument | null,
  fnId: string | undefined
): Array<{ id: string; name: string }> {
  const parents: Array<{ id: string; name: string }> = [];
  if (!d) {
    return parents;
  }

  let current = d.functions.find((f) => f.id === fnId);
  while (current?.range) {
    const { start, end } = current.range;
    const parent = d.functions.find(
      (f) =>
        f !== current &&
        f.nodes.some(
          (n) =>
            n.kind === 'functionRef' &&
            n.range.start === start &&
            n.range.end === end
        )
    );
    if (!parent || parents.some((p) => p.id === parent.id)) {
      break;
    }

    parents.unshift({ id: parent.id, name: parent.name });
    current = parent;
  }

  return parents;
}
