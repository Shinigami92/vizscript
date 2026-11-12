import type * as t from '@babel/types';
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
} from '@vizscript/core';
import type {
  ExecOutPinMeta,
  InputPinMeta,
  InsertPoint,
  OutputPinMeta,
  StatementMeta,
} from '@vizscript/core';
import {
  createEdge,
  lineIndent,
  NodeIdFactory,
  refinesType,
  truncate,
} from '@vizscript/core';
import type {
  AnyFunction,
  DocumentContext,
  InputSpec,
  ScopeEntry,
  ValueSource,
} from './lower-utils';
import { rangeOf } from './lower-utils';

/** Graph primitives shared by the lowering steps of one function. */
export abstract class GraphBuilder {
  protected readonly nodes: GraphNode[] = [];
  protected readonly edges: GraphEdge[] = [];
  protected readonly ids: NodeIdFactory;
  protected readonly fnId: string;
  protected readonly scopes: Array<Map<string, ScopeEntry>> = [new Map()];
  protected readonly text: string;
  protected cursor: PinRef | null = null;
  protected currentStatement: SourceRange | null = null;
  /** Set while lowering the declaration of an `export` statement. */
  protected exportKeyword: 'export' | 'export default' | null = null;

  public constructor(
    protected readonly doc: DocumentContext,
    protected readonly name: string,
    protected readonly kind: string,
    protected readonly fn: AnyFunction | t.Program
  ) {
    this.text = doc.text;
    this.fnId = doc.uniqueFunctionId(name);
    this.ids = new NodeIdFactory(this.fnId);
  }

  // ---------------------------------------------------------------- helpers

  protected source(range: SourceRange): string {
    return this.text.slice(range.start, range.end);
  }

  protected addNode(options: {
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
    idText?: string;
  }): GraphNode {
    const node: GraphNode = {
      id: this.ids.create(
        options.kind,
        options.idText ?? `${options.title}|${this.source(options.range)}`
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

  /** Wires the node's `exec` input to the current cursor and advances it. */
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

  /** Insertion point at the start of a `{ ... }` block. */
  protected blockInsert(block: t.Node): InsertPoint | undefined {
    if (block.type !== 'BlockStatement') {
      return undefined;
    }

    const first = block.body[0];
    const indent = first
      ? lineIndent(this.text, first.start ?? 0)
      : `${lineIndent(this.text, block.start ?? 0)}  `;
    return { at: (block.start ?? 0) + 1, indent, mode: 'after' };
  }

  protected statementInsert(
    stmt: t.Node,
    inline: boolean
  ): InsertPoint | undefined {
    if (inline) {
      return undefined;
    }

    return {
      at: stmt.end ?? 0,
      indent: lineIndent(this.text, stmt.start ?? 0),
      mode: 'after',
    };
  }

  protected statementMeta(
    stmt: t.Node,
    inline: boolean
  ): Record<string, unknown> {
    const meta: StatementMeta = { stmt: rangeOf(stmt) };
    if (inline) {
      meta.inline = true;
    }

    return meta as unknown as Record<string, unknown>;
  }

  protected queueFunction(name: string, kind: string, fn: AnyFunction): void {
    this.doc.queue.push({ name, kind, fn });
  }

  protected queueClass(
    cls: t.ClassDeclaration | t.ClassExpression,
    name: string
  ): void {
    for (const member of cls.body.body) {
      if (
        member.type !== 'ClassMethod' &&
        member.type !== 'ClassPrivateMethod'
      ) {
        continue;
      }

      const key =
        member.key.type === 'Identifier'
          ? member.key.name
          : member.key.type === 'PrivateName'
            ? `#${member.key.id.name}`
            : truncate(this.source(rangeOf(member.key)), 20);
      const kind =
        member.kind === 'constructor'
          ? 'constructor'
          : member.kind === 'get'
            ? 'getter'
            : member.kind === 'set'
              ? 'setter'
              : 'method';
      this.queueFunction(`${name}.${key}`, kind, member);
    }
  }

  // ---------------------------------------------------------------- values

  protected literal(
    kind: PinLiteral['kind'],
    value: string,
    raw: string,
    type: DataType
  ): ValueSource {
    return { literal: { kind, value, raw, editable: true }, type };
  }

  protected pureNode(options: {
    kind: NodeKind;
    title: string;
    subtitle?: string;
    expr: t.Node;
    path: string;
    inputs: InputSpec[];
    outType: DataType;
    compact?: boolean;
    outName?: string;
    category?: NodeCategory;
  }): ValueSource {
    const range = rangeOf(options.expr);
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
                sourceText: this.source(range),
                scope: { ...this.currentStatement },
              }
            : { sourceText: this.source(range) },
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
    expr: t.Node,
    path: string,
    type: DataType
  ): ValueSource {
    return this.pureNode({
      kind: 'getVar',
      title: name,
      expr,
      path,
      inputs: [],
      outType: type,
      compact: true,
      category: 'variable',
    });
  }
}
