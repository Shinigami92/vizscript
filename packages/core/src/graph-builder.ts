import type {
  ExecOutPinMeta,
  InputPinMeta,
  InsertPoint,
  OutputPinMeta,
  StatementMeta,
} from './edit-meta';
import { createEdge, NodeIdFactory } from './ids';
import type {
  DataType,
  GraphEdge,
  GraphNode,
  NodeCategory,
  NodeKind,
  NodePurity,
  Pin,
  PinLiteral,
  PinRef,
  SourceRange,
} from './ir';
import { refinesType } from './types';

/** A value feeding an input pin: either a wire or an inline literal. */
export type ValueSource =
  | { pin: PinRef; type: DataType }
  | { literal: PinLiteral; type: DataType };

export interface ScopeEntry {
  /** Pin carrying the value (parameters, loop variables); else a getter. */
  source?: PinRef;
  type: DataType;
}

export interface InputSpec {
  pin: Pin;
  value: ValueSource | undefined;
}

export interface NodeOptions {
  kind: NodeKind;
  title: string;
  subtitle?: string;
  category: NodeCategory;
  purity: NodePurity;
  range: SourceRange;
  pins: Pin[];
  path: string;
  compact?: boolean;
  meta?: Record<string, unknown>;
  /** Text the stable id is derived from (default: title + source). */
  idText?: string;
}

/**
 * Shared bookkeeping for lowering one function into a graph: node and edge
 * creation, the exec cursor, scopes and pin factories. Language backends
 * extend it and add the AST walking.
 */
export abstract class GraphBuilderBase {
  protected readonly nodes: GraphNode[] = [];
  protected readonly edges: GraphEdge[] = [];
  protected readonly ids: NodeIdFactory;
  protected readonly scopes: Array<Map<string, ScopeEntry>> = [new Map()];
  /** Exec output the next statement is chained to. */
  protected cursor: PinRef | null = null;
  /** Range of the statement being lowered (for binding call results). */
  protected currentStatement: SourceRange | null = null;

  protected constructor(
    protected readonly text: string,
    protected readonly fnId: string
  ) {
    this.ids = new NodeIdFactory(fnId);
  }

  protected src(range: SourceRange): string {
    return this.text.slice(range.start, range.end);
  }

  protected addNode(options: NodeOptions): GraphNode {
    const node: GraphNode = {
      id: this.ids.create(
        options.kind,
        options.idText ?? `${options.title}|${this.src(options.range)}`
      ),
      kind: options.kind,
      category: options.category,
      purity: options.purity,
      title: options.title,
      range: options.range,
      pins: options.pins,
      path: options.path,
    };
    if (options.subtitle) {
      node.subtitle = options.subtitle;
    }

    if (options.compact) {
      node.compact = true;
    }

    if (options.meta) {
      node.meta = options.meta;
    }

    this.nodes.push(node);
    return node;
  }

  protected connect(kind: 'exec' | 'data', from: PinRef, to: PinRef): void {
    this.edges.push(createEdge(kind, from, to));
  }

  /** Wires the node's `exec` input to the cursor and advances it. */
  protected chain(node: GraphNode, thenPin: string | null = 'then'): void {
    if (this.cursor) {
      this.connect('exec', this.cursor, { node: node.id, pin: 'exec' });
    }

    this.cursor = thenPin ? { node: node.id, pin: thenPin } : null;
  }

  protected feed(
    nodeId: string,
    pin: Pin,
    value: ValueSource | undefined
  ): void {
    if (!value) {
      return;
    }

    if ('literal' in value) {
      pin.literal = value.literal;
    } else {
      this.connect('data', value.pin, { node: nodeId, pin: pin.id });
    }

    if (refinesType(pin.type, value.type)) {
      pin.type = value.type;
    }
  }

  protected feedAll(nodeId: string, inputs: ReadonlyArray<InputSpec>): void {
    for (const input of inputs) {
      this.feed(nodeId, input.pin, input.value);
    }
  }

  protected lookup(name: string): ScopeEntry | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const entry = this.scopes[i]?.get(name);
      if (entry) {
        return entry;
      }
    }

    return undefined;
  }

  protected declare(name: string, entry: ScopeEntry): void {
    this.scopes.at(-1)?.set(name, entry);
  }

  protected withScope(fn: () => void): void {
    this.scopes.push(new Map());
    try {
      fn();
    } finally {
      this.scopes.pop();
    }
  }

  protected execIn(): Pin {
    return { id: 'exec', name: '', direction: 'in', kind: 'exec', type: 'any' };
  }

  protected execOut(
    id: string,
    name: string,
    insert?: InsertPoint,
    continuation = false
  ): Pin {
    const meta: ExecOutPinMeta = {};
    if (insert) {
      meta.insert = insert;
    }

    if (continuation) {
      meta.continuation = true;
    }

    return {
      id,
      name,
      direction: 'out',
      kind: 'exec',
      type: 'any',
      meta: meta as Record<string, unknown>,
    };
  }

  protected dataIn(
    id: string,
    name: string,
    range?: SourceRange,
    type: DataType = 'any',
    meta?: InputPinMeta
  ): Pin {
    const pin: Pin = { id, name, direction: 'in', kind: 'data', type };
    if (range) {
      pin.range = range;
    }

    if (meta) {
      pin.meta = meta as Record<string, unknown>;
    }

    return pin;
  }

  protected dataOut(
    id: string,
    name: string,
    type: DataType,
    meta: OutputPinMeta,
    range?: SourceRange
  ): Pin {
    const pin: Pin = {
      id,
      name,
      direction: 'out',
      kind: 'data',
      type,
      meta: meta as Record<string, unknown>,
    };
    if (range) {
      pin.range = range;
    }

    return pin;
  }

  protected statementMeta(
    stmt: SourceRange,
    inline: boolean,
    sole = false
  ): Record<string, unknown> {
    const meta: StatementMeta = { stmt: { start: stmt.start, end: stmt.end } };
    if (inline) {
      meta.inline = true;
    }

    if (sole) {
      meta.sole = true;
    }

    return meta as unknown as Record<string, unknown>;
  }

  protected literal(
    kind: PinLiteral['kind'],
    value: string,
    raw: string,
    type: DataType
  ): ValueSource {
    return { literal: { kind, value, raw, editable: true }, type };
  }

  /** A pure node whose single output is the value of `range`. */
  protected pureNode(options: {
    kind: NodeKind;
    title: string;
    subtitle?: string;
    range: SourceRange;
    path: string;
    inputs: InputSpec[];
    outType: DataType;
    compact?: boolean;
    outName?: string;
    category?: NodeCategory;
  }): ValueSource {
    const range = { start: options.range.start, end: options.range.end };
    const node = this.addNode({
      kind: options.kind,
      title: options.title,
      subtitle: options.subtitle,
      category: options.category ?? 'pure',
      purity: 'pure',
      range,
      pins: [
        ...options.inputs.map((i) => i.pin),
        this.dataOut(
          'value',
          options.outName ?? '',
          options.outType,
          this.currentStatement
            ? {
                sourceText: this.src(range),
                scope: { ...this.currentStatement },
              }
            : { sourceText: this.src(range) },
          range
        ),
      ],
      path: options.path,
      compact: options.compact,
    });
    this.feedAll(node.id, options.inputs);
    return { pin: { node: node.id, pin: 'value' }, type: options.outType };
  }

  protected getVar(
    name: string,
    range: SourceRange,
    path: string,
    type: DataType
  ): ValueSource {
    return this.pureNode({
      kind: 'getVar',
      title: name,
      range,
      path,
      inputs: [],
      outType: type,
      compact: true,
      category: 'variable',
    });
  }

  /** The finished graph content. */
  protected graph(): { nodes: GraphNode[]; edges: GraphEdge[] } {
    return { nodes: this.nodes, edges: this.edges };
  }
}

/**
 * An expression statement whose value nobody uses (`a + b;`, often left over
 * after removing a wire) is shown like an unconnected Blueprint node: just
 * its pure nodes, without an exec node. Its root node stands for the
 * statement (deleting it removes the line). Returns whether that applies:
 * `value` comes from new nodes (since index `from`) that are all pure.
 */
export function markUnusedValue(
  nodes: ReadonlyArray<GraphNode>,
  from: number,
  value: ValueSource | undefined,
  statementMeta: Record<string, unknown>
): boolean {
  if (!value || !('pin' in value)) {
    return false;
  }

  const added = nodes.slice(from);
  const root = added.find((n) => n.id === value.pin.node);
  if (!root || added.some((n) => n.purity !== 'pure')) {
    return false;
  }

  root.meta = { ...root.meta, ...statementMeta, unused: true };
  return true;
}

/** Offset of the end of the line containing `offset` (before `\r\n`). */
export function lineEnd(text: string, offset: number): number {
  const index = text.indexOf('\n', offset);
  if (index === -1) {
    return text.length;
  }

  return text[index - 1] === '\r' ? index - 1 : index;
}

/** Gives every function a unique id: `fn:name`, `fn:name~1`, … */
export class FunctionIds {
  private readonly counts = new Map<string, number>();

  public next(name: string): string {
    const count = this.counts.get(name) ?? 0;
    this.counts.set(name, count + 1);
    return count === 0 ? `fn:${name}` : `fn:${name}~${count}`;
  }
}

/** A fresh {@link FunctionIds} counter for one document. */
export function functionIdCounter(): FunctionIds {
  return new FunctionIds();
}
