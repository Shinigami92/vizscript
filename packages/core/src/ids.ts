import type { GraphEdge, NodeKind, PinRef } from './ir';

/**
 * 32-bit FNV-1a hash rendered as base36. Small, fast and deterministic.
 */
export function hashString(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0).toString(36);
}

/** Collapses all whitespace so formatting changes keep ids stable. */
export function normalizeSource(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}

/**
 * Creates ids of the shape `<scope>/<kind>:<hash>#<occurrence>`.
 *
 * The id is derived from the node's (normalized) source text, so it survives
 * edits elsewhere in the file and reordering of statements.
 */
export class NodeIdFactory {
  private readonly occurrences = new Map<string, number>();

  public constructor(private readonly scope: string) {}

  public create(kind: NodeKind, sourceText: string): string {
    const base = `${this.scope}/${kind}:${hashString(normalizeSource(sourceText))}`;
    const occurrence = this.occurrences.get(base) ?? 0;
    this.occurrences.set(base, occurrence + 1);
    return `${base}#${occurrence}`;
  }
}

export function pinKey(ref: PinRef): string {
  return `${ref.node}::${ref.pin}`;
}

export function edgeId(from: PinRef, to: PinRef): string {
  return `${pinKey(from)}->${pinKey(to)}`;
}

export function createEdge(
  kind: GraphEdge['kind'],
  from: PinRef,
  to: PinRef
): GraphEdge {
  return { id: edgeId(from, to), kind, from, to };
}
