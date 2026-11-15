import type {
  GraphNode,
  InputSpec,
  InsertPoint,
  Pin,
  StatementMeta,
} from '@vizscript/core';
import {
  arrayElementType,
  lineEnd,
  lineIndent,
  truncate,
} from '@vizscript/core';
import type { Block, Expr, IfStmt, Span, Stmt } from './ast';
import { dataTypeOf } from './data-type';
import { ExpressionLowering } from './expression-lowering';
import { rangeOf, unwrap } from './lower-utils';

/** Branches and loops: `if`, `for`, `while` and `match`. */
export abstract class ControlFlowLowering extends ExpressionLowering {
  protected abstract lowerBlock(block: Block, path: string): void;

  /** New statements go on a new line at the start of an indented block. */
  protected blockInsert(block: Block | undefined): InsertPoint | undefined {
    const first = block?.body[0];
    if (!block || block.inline || !first) {
      return undefined;
    }

    return {
      at: lineEnd(this.text, block.colonEnd),
      indent: lineIndent(this.text, first.start),
      mode: 'after',
    };
  }

  protected statementInsert(
    stmt: Span,
    inline: boolean
  ): InsertPoint | undefined {
    if (inline) {
      return undefined;
    }

    return {
      at: lineEnd(this.text, stmt.end),
      indent: lineIndent(this.text, stmt.start),
      mode: 'after',
    };
  }

  // ------------------------------------------------------------ control flow

  /**
   * `for i in range(B)` / `range(A, B)` is UE's For Loop: First / End Index
   * pins (a missing start is `0`, inserted when set) and the index as an
   * output, no `range` call node. `undefined` for other iterables.
   */
  private countingInputs(
    stmt: Extract<Stmt, { type: 'For' }>,
    path: string
  ): InputSpec[] | undefined {
    const iter = unwrap(stmt.iterable);
    const callee = iter.type === 'Call' ? unwrap(iter.callee) : undefined;
    const args = iter.type === 'Call' ? iter.args : [];
    const [from, to] = args.length === 1 ? [undefined, args[0]] : args;
    if (
      callee?.type !== 'Identifier' ||
      callee.name !== 'range' ||
      args.length === 0 ||
      args.length > 2 ||
      !to
    ) {
      return undefined;
    }

    const end: InputSpec = {
      pin: this.dataIn('end', 'End Index', rangeOf(to), 'number'),
      value: this.lowerExpr(to, `${path}.end`, 'eager'),
    };
    const first: InputSpec = from
      ? {
          pin: this.dataIn('first', 'First Index', rangeOf(from), 'number'),
          value: this.lowerExpr(from, `${path}.first`, 'eager'),
        }
      : {
          pin: this.dataIn('first', 'First Index', undefined, 'number', {
            insertInitAt: rangeOf(to).start,
            insertPrefix: '',
            insertSuffix: ', ',
          }),
          value: {
            literal: { kind: 'number', value: '0', raw: '0', editable: true },
            type: 'number',
          },
        };
    return [first, end];
  }

  protected lowerFor(
    stmt: Extract<Stmt, { type: 'For' }>,
    path: string,
    inline: boolean,
    sole: boolean
  ): void {
    const counting = this.countingInputs(stmt, path);
    const arrayPin = this.dataIn(
      'array',
      'Array',
      rangeOf(stmt.iterable),
      'array'
    );
    const iterable = counting
      ? undefined
      : this.lowerExpr(stmt.iterable, `${path}.iterable`, 'eager');
    // `for x: T in` names the type; else it comes from a typed array.
    const elementType = stmt.variableType
      ? dataTypeOf(stmt.variableType)
      : counting
        ? 'number'
        : arrayElementType(iterable?.type ?? 'any');
    const node = this.addNode({
      kind: 'forEach',
      title: counting ? 'For Loop' : 'For Each',
      category: 'flow',
      purity: 'impure',
      range: rangeOf(stmt),
      pins: [
        this.execIn(),
        ...(counting ? counting.map((i) => i.pin) : [arrayPin]),
        this.execOut('body', 'Loop Body', this.blockInsert(stmt.body)),
        this.dataOut(
          'element',
          stmt.variable,
          elementType,
          { sourceText: stmt.variable },
          rangeOf(stmt.variableSpan)
        ),
        this.execOut(
          'completed',
          'Completed',
          this.statementInsert(stmt, inline),
          true
        ),
      ],
      path,
      meta: this.statementMeta(stmt, inline, sole),
    });
    if (counting) {
      this.feedAll(node.id, counting);
    } else if (iterable) {
      this.feed(node.id, arrayPin, iterable);
    }

    this.chain(node, 'body');
    this.withScope(() => {
      this.declare(stmt.variable, {
        source: { node: node.id, pin: 'element' },
        type: elementType,
      });
      this.lowerBlock(stmt.body, `${path}/body`);
    });
    this.cursor = { node: node.id, pin: 'completed' };
  }

  protected lowerWhile(
    stmt: Extract<Stmt, { type: 'While' }>,
    path: string,
    inline: boolean,
    sole: boolean
  ): void {
    const condPin = this.dataIn(
      'condition',
      'Condition',
      rangeOf(stmt.test),
      'bool'
    );
    const condition = this.lowerExpr(stmt.test, `${path}.test`, 'lazy');
    const node = this.addNode({
      kind: 'loop',
      title: 'While Loop',
      category: 'flow',
      purity: 'impure',
      range: rangeOf(stmt),
      pins: [
        this.execIn(),
        condPin,
        this.execOut('body', 'Loop Body', this.blockInsert(stmt.body)),
        this.execOut(
          'completed',
          'Completed',
          this.statementInsert(stmt, inline),
          true
        ),
      ],
      path,
      meta: this.statementMeta(stmt, inline, sole),
    });
    this.feed(node.id, condPin, condition);
    this.chain(node, 'body');
    this.lowerBlock(stmt.body, `${path}/body`);
    this.cursor = { node: node.id, pin: 'completed' };
  }

  protected lowerMatch(
    stmt: Extract<Stmt, { type: 'Match' }>,
    path: string,
    inline: boolean,
    sole: boolean
  ): void {
    const valuePin = this.dataIn('value', 'Value', rangeOf(stmt.subject));
    const value = this.lowerExpr(stmt.subject, `${path}.value`, 'eager');
    const pins: Pin[] = [this.execIn(), valuePin];
    for (const [index, branch] of stmt.branches.entries()) {
      pins.push(
        this.execOut(
          `case${index}`,
          truncate(this.src(rangeOf(branch.patterns)), 20),
          this.blockInsert(branch.body)
        )
      );
    }

    pins.push(
      this.execOut(
        'completed',
        'Completed',
        this.statementInsert(stmt, inline),
        true
      )
    );
    const node = this.addNode({
      kind: 'switch',
      title: 'Match',
      category: 'flow',
      purity: 'impure',
      range: rangeOf(stmt),
      pins,
      path,
      meta: this.statementMeta(stmt, inline, sole),
    });
    this.feed(node.id, valuePin, value);
    this.chain(node, null);
    for (const [index, branch] of stmt.branches.entries()) {
      this.cursor = { node: node.id, pin: `case${index}` };
      this.lowerBlock(branch.body, `${path}/case${index}`);
    }

    this.cursor = { node: node.id, pin: 'completed' };
  }

  protected lowerIf(
    stmt: IfStmt,
    path: string,
    inline: boolean,
    sole: boolean
  ): void {
    const branch = (
      test: Expr,
      body: Block,
      next: Block | undefined,
      span: Span,
      branchPath: string,
      isElif: boolean
    ): GraphNode => {
      const condPin = this.dataIn(
        'condition',
        'Condition',
        rangeOf(test),
        'bool'
      );
      const condition = this.lowerExpr(test, `${branchPath}.test`, 'eager');
      const pins: Pin[] = [
        this.execIn(),
        condPin,
        this.execOut('true', 'True', this.blockInsert(body)),
        this.execOut('false', 'False', this.blockInsert(next)),
      ];
      if (!isElif) {
        pins.push(
          this.execOut(
            'completed',
            'Completed',
            this.statementInsert(stmt, inline),
            true
          )
        );
      }

      const meta: StatementMeta = isElif
        ? { stmt: rangeOf(span), locked: true }
        : (this.statementMeta(stmt, inline, sole) as unknown as StatementMeta);
      const node = this.addNode({
        kind: 'branch',
        title: 'Branch',
        subtitle: isElif ? 'elif' : undefined,
        category: 'flow',
        purity: 'impure',
        range: rangeOf(span),
        pins,
        path: branchPath,
        meta: meta as unknown as Record<string, unknown>,
      });
      this.feed(node.id, condPin, condition);
      this.chain(node, 'true');
      this.lowerBlock(body, `${branchPath}/then`);
      this.cursor = { node: node.id, pin: 'false' };
      return node;
    };

    const parts = [
      { test: stmt.test, body: stmt.body, span: stmt as Span },
      ...stmt.elifs.map((e) => ({
        test: e.test,
        body: e.body,
        span: e as Span,
      })),
    ];
    let first: GraphNode | undefined;
    for (const [index, part] of parts.entries()) {
      const next = parts[index + 1]?.body ? undefined : stmt.orelse;
      const node = branch(
        part.test,
        part.body,
        next,
        part.span,
        index === 0 ? path : `${path}/elif${index}`,
        index > 0
      );
      first ??= node;
    }

    if (stmt.orelse) {
      this.lowerBlock(stmt.orelse, `${path}/else`);
    }

    if (first) {
      this.cursor = { node: first.id, pin: 'completed' };
    }
  }
}
