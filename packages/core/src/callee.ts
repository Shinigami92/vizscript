import type {
  FunctionGraph,
  GraphDocument,
  GraphNode,
  Pin,
  PinRef,
} from './ir';
import { findNode } from './reconcile';

/**
 * The Target pin of a call made on a value written in the code
 * (`console.log(…)`, `cart.first()`). Free calls (`totalPrice(…)`) have
 * an unwired Target without a range.
 */
export function receiverPin(node: GraphNode): Pin | undefined {
  return node.kind === 'call'
    ? node.pins.find((p) => p.id === 'target' && p.range !== undefined)
    : undefined;
}

/**
 * Offset of a call's function name in the code: right after its receiver
 * and the `.` / `?.` / `::` (`console.log` → `log`), or where the node
 * starts.
 */
export function calleeNameAt(text: string, node: GraphNode): number {
  const range = receiverPin(node)?.range;
  if (!range) {
    return node.range.start;
  }

  const separator = text.slice(range.end).match(/^\s*(?:\?\.|\.|::)\s*/);
  return range.end + (separator?.[0].length ?? 0);
}

/** The function a call node calls, as written: `console.log`, `fn`. */
export function calleeText(text: string, node: GraphNode): string {
  const title = node.title.replace(/\?\.\(\)$/, '');
  const range = receiverPin(node)?.range;
  return range ? `${text.slice(range.start, range.end)}.${title}` : title;
}

/** The node wired into a call's receiver (Get `console` of `console.log`). */
function receiverSource(
  fn: FunctionGraph,
  node: GraphNode
): GraphNode | undefined {
  const edge = fn.edges.find(
    (e) => e.to.node === node.id && e.to.pin === 'target'
  );
  return edge ? fn.nodes.find((n) => n.id === edge.from.node) : undefined;
}

/**
 * A call of the file's own function: without a receiver (`totalPrice()`),
 * or on the own object (`this.save()`, `self.save()`).
 */
export function callsOwnFunction(fn: FunctionGraph, node: GraphNode): boolean {
  if (!receiverPin(node)) {
    return true;
  }

  const source = receiverSource(fn, node);
  return (
    source?.kind === 'entry' ||
    (source?.kind === 'getVar' &&
      (source.title === 'this' || source.title === 'self'))
  );
}

/**
 * A call as a path of names when its receiver is a Get or none
 * (`console.log`, `this.save`, `totalPrice`); `undefined` for calls on
 * other values (`fetch(url).then`).
 */
export function callPath(
  fn: FunctionGraph,
  node: GraphNode
): string | undefined {
  if (!receiverPin(node)) {
    return node.title;
  }

  const source = receiverSource(fn, node);
  return source?.kind === 'getVar'
    ? `${source.title}.${node.title}`
    : undefined;
}

/** Why a method's receiver can't be left empty in the code. */
export const RECEIVER_NEEDED =
  'A method needs a value to be called on; the graph keeps this until one is wired.';

/** Whether a pin is a method's receiver (`log`'s `this` of `console.log`). */
export function isReceiver(doc: GraphDocument, ref: PinRef): boolean {
  const node = ref.pin === 'target' ? findNode(doc, ref.node) : undefined;
  return node !== undefined && receiverPin(node) !== undefined;
}

/**
 * A method whose receiver lost its wire (graph-only): like UE's node of a
 * class's function without a Target, it shows only its exec pins and
 * `this` until a value is wired in.
 */
export function receiverMissing(fn: FunctionGraph, node: GraphNode): boolean {
  const pin = receiverPin(node);
  return (
    pin !== undefined &&
    pin.literal === undefined &&
    !fn.edges.some((e) => e.to.node === node.id && e.to.pin === pin.id)
  );
}
