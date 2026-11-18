import { findConversion, isTypeCompatible } from '@vizscript/core';
import type { Conversion, GraphNode, Pin } from '@vizscript/core';

/** One end of a wire: a pin of a node in a function. */
export interface WireEnd {
  ns: {
    fnId: string;
    node: Pick<GraphNode, 'id'>;
    /** A floating node (not wired in yet) joins the function it's wired to. */
    full: Pick<GraphNode, 'floating'>;
  };
  pg: { pin: Pin };
}

/** The conversion a data wire from `a` to `b` needs (UE's autocast). */
export function conversionOf(
  a: WireEnd,
  b: WireEnd,
  conversions: ReadonlyArray<Conversion> | undefined
): Conversion | undefined {
  const pa = a.pg.pin;
  const pb = b.pg.pin;
  if (
    pa.kind !== 'data' ||
    pb.kind !== 'data' ||
    pa.direction === pb.direction
  ) {
    return undefined;
  }

  const [out, input] = pa.direction === 'out' ? [pa, pb] : [pb, pa];
  return findConversion(conversions, out.type, input.type);
}

/** A pin's name in messages: UE's "Exec is not compatible with Boolean." */
function label(pin: Pin): string {
  return pin.kind === 'exec' ? 'Exec' : String(pin.type);
}

/**
 * Why two pins can't be wired, like UE's messages; `null` if they can.
 * With `conversions`, a wire one of them converts is allowed.
 */
export function connectProblem(
  a: WireEnd,
  b: WireEnd,
  conversions?: ReadonlyArray<Conversion>
): string | null {
  const pa = a.pg.pin;
  const pb = b.pg.pin;
  if (a.ns.node.id === b.ns.node.id) {
    return 'Both are on the same node.';
  }

  if (a.ns.fnId !== b.ns.fnId && !a.ns.full.floating && !b.ns.full.floating) {
    return 'The pins are in different functions.';
  }

  if (pa.kind !== pb.kind) {
    return `${label(pa)} is not compatible with ${label(pb)}.`;
  }

  if (pa.direction === pb.direction) {
    return 'Directions are not compatible.';
  }

  if (pa.kind === 'data') {
    const out = pa.direction === 'out' ? pa : pb;
    const input = pa.direction === 'out' ? pb : pa;
    if (
      !isTypeCompatible(out.type, input.type) &&
      !(conversions && conversionOf(a, b, conversions))
    ) {
      return `${label(pa)} is not compatible with ${label(pb)}.`;
    }
  }

  return null;
}

/**
 * Why the wires of a Ctrl+drag (from `drag.from`, to `drag.ends`) can't
 * move to `target`; moved wires keep their values: no conversion.
 */
export function moveProblem(
  drag: { from: WireEnd; ends: ReadonlyArray<WireEnd> },
  target: WireEnd
): string | null {
  const from = drag.from.pg.pin;
  const to = target.pg.pin;
  if (to.kind !== from.kind || to.direction !== from.direction) {
    const exec = from.kind === 'exec' ? ' exec pin' : '';
    return from.direction === 'out'
      ? `Move the wires to another output${exec}.`
      : `Move the wire to another input${exec}.`;
  }

  for (const end of drag.ends) {
    const problem = connectProblem(end, target);
    if (problem) {
      return problem;
    }
  }

  return null;
}
