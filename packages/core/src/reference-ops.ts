import { calleeNameAt } from './callee';
import type { GraphDocument, GraphNode } from './ir';
import { failed, succeeded } from './op-result';
import type { OpResult } from './ops';
import { findNode } from './reconcile';

/** Operators an assignment may use. */
export const ASSIGN_OPERATORS: ReadonlyArray<string> = [
  '=',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
];

/** `x = v` ↔ `x += v`: the operator of an assignment (Set node). */
export function setAssignOperator(
  text: string,
  doc: GraphDocument,
  nodeId: string,
  operator: string
): OpResult {
  const node = findNode(doc, nodeId);
  const target =
    node?.kind === 'setVar' && node.title.startsWith('Set ')
      ? node.title.slice(4)
      : undefined;
  if (!node || !target || node.meta?.declares !== undefined) {
    return failed('Only assignments have an operator.');
  }

  if (!ASSIGN_OPERATORS.includes(operator)) {
    return failed(`Unknown operator ${operator}.`);
  }

  const at = node.range.start + target.length;
  const current = text
    .slice(at)
    .match(/^(\s*)((?:\*\*|\?\?|&&|\|\||<<|>>>|>>|[-+*/%&|^])?=)(?!=)/);
  if (text.slice(node.range.start, at) !== target || !current) {
    return failed('Cannot find the operator of this assignment.');
  }

  const start = at + (current[1] ?? '').length;
  return succeeded([
    { start, end: start + (current[2] ?? '').length, text: operator },
  ]);
}

/** `name`, `this.name`, `ns.fn`. */
const NAME_PATH = /^[A-Za-z_$#][\w$]*(?:\.[A-Za-z_$#][\w$]*)*$/;

/** The variable of a Get / Set or the function of a call, as written. */
export function referenceName(node: GraphNode): string | undefined {
  const name =
    node.kind === 'getVar' || node.kind === 'call'
      ? node.title
      : node.kind === 'setVar'
        ? node.title.replace(/^Set /, '')
        : undefined;
  return name && NAME_PATH.test(name) ? name : undefined;
}

export function replaceReference(
  text: string,
  doc: GraphDocument,
  nodeId: string,
  name: string
): OpResult {
  const node = findNode(doc, nodeId);
  const current = node ? referenceName(node) : undefined;
  if (!node || !current) {
    return failed('Only Get, Set and call nodes can be replaced.');
  }

  if (!NAME_PATH.test(name)) {
    return failed('Enter a name.');
  }

  // The name is where the node's code starts (`x`, `x = …`, `fn(…)`), or
  // right after a call's receiver (`console.log(…)`).
  const at = node.kind === 'call' ? calleeNameAt(text, node) : node.range.start;
  if (
    text.slice(at, at + current.length) !== current ||
    /[\w$]/.test(text.charAt(at + current.length))
  ) {
    return failed(
      node.kind === 'setVar'
        ? 'A declaration cannot point to another variable; rename it instead.'
        : 'Cannot find the name of this node in the code.'
    );
  }

  return succeeded([{ start: at, end: at + current.length, text: name }]);
}
