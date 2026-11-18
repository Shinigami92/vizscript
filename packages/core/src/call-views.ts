import type { CallLook, ContainerNodeMeta } from './container-ops';
import { getMeta } from './edit-meta';
import type { GraphDocument, GraphNode, Pin, Positions } from './ir';
import type { TextChange } from './reconcile';
import { renamedNodes } from './reconcile';

/**
 * Container nodes (ADD, INCLUDES …) are a way to draw calls of the code
 * (`items.push(x)`). A node the user wants to see as its call is
 * remembered in the layout (`~call|<nodeId>`, like comment box colors) and
 * drawn as that call (`withCallViews`). The code is the same either way.
 */
export const CALL_VIEW_PREFIX = '~call|';

export function callViewKey(nodeId: string): string {
  return `${CALL_VIEW_PREFIX}${nodeId}`;
}

export function isCallViewKey(key: string): boolean {
  return key.startsWith(CALL_VIEW_PREFIX);
}

/** The nodes shown as their calls. */
export function callViewIds(positions: Positions): Set<string> {
  return new Set(
    Object.keys(positions)
      .filter(isCallViewKey)
      .map((key) => key.slice(CALL_VIEW_PREFIX.length))
  );
}

/** The container node a node shown as its call is (`showAsCall`). */
interface ShownAsCallMeta {
  shownAsCall?: { word: string; label?: string };
}

/** The word of the container node `node` is drawn instead of, if any. */
export function shownAsCall(
  node: GraphNode
): { word: string; label?: string } | undefined {
  return getMeta<ShownAsCallMeta>(node).shownAsCall;
}

/** Whether a container node can be shown as the call it is in the code. */
export function hasCallLook(node: GraphNode): boolean {
  return Array.isArray(getMeta<ContainerNodeMeta>(node).container?.call?.order);
}

/**
 * A container node drawn as its call again: its pins in the call's order,
 * with what the container node knows (types, outputs' code). Exec pins
 * only when the node still has them: a read stays pure.
 */
export function showAsCall(node: GraphNode): GraphNode {
  const meta = getMeta<ContainerNodeMeta>(node);
  const call: CallLook | undefined = meta.container?.call;
  // Floating nodes are stored with the overlay: an older one may lack it.
  if (!meta.container || !Array.isArray(call?.order)) {
    return node;
  }

  const order = new Map(call.order.map((id, i) => [id, i]));
  const rank = (pin: Pin): number => order.get(pin.id) ?? order.size;
  const { container: _container, ...rest } = node.meta ?? {};
  const { word, label } = meta.container;
  const shown: GraphNode = {
    ...node,
    pins: node.pins.toSorted((a, b) => rank(a) - rank(b)),
    meta: {
      ...rest,
      shownAsCall: { word, ...(label === undefined ? {} : { label }) },
    } satisfies ShownAsCallMeta,
  };
  if (call.compact) {
    shown.compact = true;
  } else {
    delete shown.compact;
  }

  return shown;
}

/**
 * The document with the container nodes the layout names (`~call|…`)
 * drawn as their calls. The same document when there are none.
 */
export function withCallViews(
  doc: GraphDocument,
  positions: Positions
): GraphDocument {
  const ids = callViewIds(positions);
  if (ids.size === 0) {
    return doc;
  }

  let changed = false;
  const functions = doc.functions.map((fn) => {
    let own = false;
    const nodes = fn.nodes.map((node) => {
      if (!ids.has(node.id) || !hasCallLook(node)) {
        return node;
      }

      own = true;
      return showAsCall(node);
    });
    changed ||= own;
    return own ? { ...fn, nodes } : fn;
  });
  return changed ? { ...doc, functions } : doc;
}

/** The `~call|` entries after a re-parse: they follow their nodes. */
export function reconcileCallViews(
  previous: GraphDocument | undefined,
  next: GraphDocument,
  positions: Positions,
  change?: TextChange
): Positions {
  const entries = Object.fromEntries(
    Object.entries(positions).filter(([key]) => isCallViewKey(key))
  );
  if (!previous || Object.keys(entries).length === 0) {
    return entries;
  }

  const rename = renamedNodes(previous, next, change);
  const result: Positions = {};
  for (const [key, point] of Object.entries(entries)) {
    const id = key.slice(CALL_VIEW_PREFIX.length);
    result[callViewKey(rename.get(id) ?? id)] = point;
  }

  return result;
}
