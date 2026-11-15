import type { DeclarationSyntax } from './declaration-syntax';
import type { GraphDocument } from './ir';
import { failed, succeeded } from './op-result';
import type { OpResult } from './ops';
import { findNode } from './reconcile';
import { checkName } from './symbol-ops';
import type { ScriptSymbol } from './symbols';
import { qualifiedName } from './symbols';

/**
 * Renames a name a node binds for its block (UE: the name of a loop's
 * index or element pin): `for (const item of items)`, `for i in range(n)`,
 * `catch (error)`. The backend's rename finds the uses; only those in the
 * node's own code change, so another loop with the same name keeps its.
 */
export function renameBinding(
  text: string,
  doc: GraphDocument,
  nodeId: string,
  pinId: string,
  name: string,
  syntax: DeclarationSyntax | undefined
): OpResult {
  const node = findNode(doc, nodeId);
  const pin = node?.pins.find((p) => p.id === pinId);
  const range = pin?.direction === 'out' ? pin.range : undefined;
  if (!syntax || !node || !pin || !range) {
    return failed('This value has no name to change.');
  }

  const old = text.slice(range.start, range.end);
  const next = name.trim();
  if (next === old) {
    return succeeded([]);
  }

  if (!syntax.identifier.test(old)) {
    return failed('Only a single name can be changed here.');
  }

  const fn = doc.functions.find((f) => f.nodes.some((n) => n.id === nodeId));
  const owner = (doc.symbols ?? []).find(
    (s) => s.fnId === fn?.id && (s.kind === 'function' || s.kind === 'method')
  );
  const symbol: ScriptSymbol = {
    id: `local:${owner ? qualifiedName(owner) : ''}.${old}`,
    kind: 'local',
    name: old,
    scope: owner ? qualifiedName(owner) : '',
    range: node.range,
    nameRange: range,
    dataType: pin.type,
    modifiers: [],
  };
  const error = checkName(doc, syntax, symbol.scope, next, symbol);
  if (error) {
    return failed(error);
  }

  const renamed = syntax.rename(text, doc, symbol, next);
  if (!renamed.ok) {
    return renamed;
  }

  // Uses of the same name outside the node belong to another binding.
  const edits = renamed.edits.filter(
    (e) => e.start >= node.range.start && e.end <= node.range.end
  );
  if (!edits.some((e) => e.start === range.start)) {
    edits.push({ start: range.start, end: range.end, text: next });
  }

  return succeeded(edits.toSorted((a, b) => a.start - b.start));
}
