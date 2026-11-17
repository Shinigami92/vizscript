import type {
  DataType,
  GraphNode,
  InputSpec,
  InsertPoint,
  Pin,
  StatementMeta,
} from '@vizscript/core';
import { iteratedType, lineEnd, lineIndent, truncate } from '@vizscript/core';
import type { Block, IfStmt, Span, Stmt } from './ast';
import { ExpressionLowering } from './expression-lowering';
import { rangeOf, unwrap } from './lower-utils';

/** The type of an `except` clause's error: the class it names, if one. */
function errorType(exception: string | undefined): DataType {
  return exception && /^\w+$/.test(exception) ? exception : 'any';
}

/** Lowers branches, loops, `with` and `try` into flow nodes. */
export abstract class ControlFlowLowering extends ExpressionLowering {
  protected abstract lowerBlock(block: Block, path: string): void;

  // ---------------------------------------------------------------- inserts

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

  protected lowerIf(
    stmt: IfStmt,
    path: string,
    meta: Record<string, unknown>,
    insert: InsertPoint | undefined
  ): void {
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
      const isElif = index > 0;
      const next = parts[index + 1] ? undefined : stmt.orelse;
      const branchPath = isElif ? `${path}/elif${index}` : path;
      const condPin = this.dataIn(
        'condition',
        'Condition',
        rangeOf(part.test),
        'bool'
      );
      const condition = this.lowerExpr(
        part.test,
        `${branchPath}.test`,
        'eager'
      );
      const pins: Pin[] = [
        this.execIn(),
        condPin,
        this.execOut('true', 'True', this.blockInsert(part.body)),
        this.execOut('false', 'False', this.blockInsert(next)),
      ];
      if (!isElif) {
        pins.push(this.execOut('completed', 'Completed', insert, true));
      }

      const elifMeta: StatementMeta = {
        stmt: rangeOf(part.span),
        locked: true,
      };
      const node = this.addNode({
        kind: 'branch',
        title: 'Branch',
        subtitle: isElif ? 'elif' : undefined,
        category: 'flow',
        purity: 'impure',
        range: rangeOf(part.span),
        pins,
        path: branchPath,
        meta: isElif ? (elifMeta as unknown as Record<string, unknown>) : meta,
      });
      this.feed(node.id, condPin, condition);
      this.chain(node, 'true');
      this.lowerBlock(part.body, `${branchPath}/then`);
      this.cursor = { node: node.id, pin: 'false' };
      first ??= node;
    }

    if (stmt.orelse) {
      this.lowerBlock(stmt.orelse, `${path}/else`);
    }

    if (first) {
      this.cursor = { node: first.id, pin: 'completed' };
    }
  }

  /**
   * `for i in range(B)` / `range(A, B)` is UE's For Loop: First / End Index
   * pins (a missing start is `0`, inserted when set) and the index as an
   * output, no `range` call node. Iterables of the pins otherwise.
   */
  private countingInputs(
    stmt: Extract<Stmt, { type: 'For' }>,
    path: string
  ): InputSpec[] | undefined {
    const iter = unwrap(stmt.iter);
    const callee = iter.type === 'Call' ? unwrap(iter.callee) : undefined;
    const args = iter.type === 'Call' ? iter.args : [];
    const [from, to] = args.length === 1 ? [undefined, args[0]] : args;
    if (
      callee?.type !== 'Name' ||
      callee.name !== 'range' ||
      args.length === 0 ||
      args.length > 2 ||
      args.some((a) => a.keyword !== undefined || a.star !== undefined) ||
      !to ||
      unwrap(stmt.target).type !== 'Name'
    ) {
      return undefined;
    }

    const end: InputSpec = {
      pin: this.dataIn('end', 'End Index', rangeOf(to.value), 'number'),
      value: this.lowerExpr(to.value, `${path}.end`, 'eager'),
    };
    const first: InputSpec = from
      ? {
          pin: this.dataIn(
            'first',
            'First Index',
            rangeOf(from.value),
            'number'
          ),
          value: this.lowerExpr(from.value, `${path}.first`, 'eager'),
        }
      : {
          pin: this.dataIn('first', 'First Index', undefined, 'number', {
            insertInitAt: rangeOf(to.value).start,
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
    meta: Record<string, unknown>,
    insert: InsertPoint | undefined
  ): void {
    const counting = this.countingInputs(stmt, path);
    if (counting) {
      this.lowerCountingFor(stmt, counting, path, meta, insert);
      return;
    }

    const iterPin = this.dataIn(
      'array',
      'Iterable',
      rangeOf(stmt.iter),
      'array'
    );
    const iterable = this.lowerExpr(stmt.iter, `${path}.iter`, 'eager');
    const target = unwrap(stmt.target);
    const elementName = this.src(rangeOf(target));
    const elementType =
      target.type === 'Name' ? iteratedType(iterable.type) : 'any';
    const pins: Pin[] = [
      this.execIn(),
      iterPin,
      this.execOut('body', 'Loop Body', this.blockInsert(stmt.body)),
      this.dataOut(
        'element',
        truncate(elementName, 20),
        elementType,
        { sourceText: elementName },
        rangeOf(target)
      ),
    ];
    if (stmt.orelse) {
      pins.push(this.execOut('else', 'Else', this.blockInsert(stmt.orelse)));
    }

    pins.push(this.execOut('completed', 'Completed', insert, true));
    const node = this.addNode({
      kind: 'forEach',
      title: 'For Each',
      subtitle: stmt.isAsync ? 'async' : undefined,
      category: 'flow',
      purity: 'impure',
      range: rangeOf(stmt),
      pins,
      path,
      meta,
    });
    this.feed(node.id, iterPin, iterable);
    this.chain(node, 'body');
    this.withScope(() => {
      // `for x in ...` wires x; tuple targets stay readable getters.
      if (target.type === 'Name') {
        this.declare(target.name, {
          source: { node: node.id, pin: 'element' },
          type: elementType,
        });
      }

      this.lowerBlock(stmt.body, `${path}/body`);
    });
    if (stmt.orelse) {
      this.cursor = { node: node.id, pin: 'else' };
      this.lowerBlock(stmt.orelse, `${path}/else`);
    }

    this.cursor = { node: node.id, pin: 'completed' };
  }

  private lowerCountingFor(
    stmt: Extract<Stmt, { type: 'For' }>,
    inputs: InputSpec[],
    path: string,
    meta: Record<string, unknown>,
    insert: InsertPoint | undefined
  ): void {
    const target = unwrap(stmt.target);
    const name = this.src(rangeOf(target));
    const pins: Pin[] = [
      this.execIn(),
      ...inputs.map((i) => i.pin),
      this.execOut('body', 'Loop Body', this.blockInsert(stmt.body)),
      this.dataOut(
        'element',
        name,
        'number',
        { sourceText: name },
        rangeOf(target)
      ),
    ];
    if (stmt.orelse) {
      pins.push(this.execOut('else', 'Else', this.blockInsert(stmt.orelse)));
    }

    pins.push(this.execOut('completed', 'Completed', insert, true));
    const node = this.addNode({
      kind: 'forEach',
      title: 'For Loop',
      category: 'flow',
      purity: 'impure',
      range: rangeOf(stmt),
      pins,
      path,
      meta,
    });
    this.feedAll(node.id, inputs);
    this.chain(node, 'body');
    this.withScope(() => {
      this.declare(name, {
        source: { node: node.id, pin: 'element' },
        type: 'number',
      });
      this.lowerBlock(stmt.body, `${path}/body`);
    });
    if (stmt.orelse) {
      this.cursor = { node: node.id, pin: 'else' };
      this.lowerBlock(stmt.orelse, `${path}/else`);
    }

    this.cursor = { node: node.id, pin: 'completed' };
  }

  protected lowerWith(
    stmt: Extract<Stmt, { type: 'With' }>,
    path: string,
    meta: Record<string, unknown>,
    insert: InsertPoint | undefined
  ): void {
    const many = stmt.items.length > 1;
    const inputs: InputSpec[] = stmt.items.map((item, i) => ({
      pin: this.dataIn(
        `context${i}`,
        many ? `Context ${i + 1}` : 'Context',
        rangeOf(item.context)
      ),
      value: this.lowerExpr(item.context, `${path}.context${i}`, 'eager'),
    }));
    const outputs: Pin[] = [];
    for (const [i, item] of stmt.items.entries()) {
      if (item.target) {
        const name = this.src(rangeOf(item.target));
        outputs.push(
          this.dataOut(
            `as${i}`,
            name,
            'any',
            { sourceText: name },
            rangeOf(item.target)
          )
        );
      }
    }

    const node = this.addNode({
      kind: 'try',
      title: 'With',
      subtitle: stmt.isAsync ? 'async' : undefined,
      category: 'flow',
      purity: 'impure',
      range: rangeOf(stmt),
      pins: [
        this.execIn(),
        ...inputs.map((i) => i.pin),
        this.execOut('body', 'Body', this.blockInsert(stmt.body)),
        ...outputs,
        this.execOut('completed', 'Completed', insert, true),
      ],
      path,
      meta,
    });
    this.feedAll(node.id, inputs);
    this.chain(node, 'body');
    this.withScope(() => {
      for (const [i, item] of stmt.items.entries()) {
        const target = item.target ? unwrap(item.target) : undefined;
        if (target?.type === 'Name') {
          this.declare(target.name, {
            source: { node: node.id, pin: `as${i}` },
            type: 'any',
          });
        }
      }

      this.lowerBlock(stmt.body, `${path}/body`);
    });
    this.cursor = { node: node.id, pin: 'completed' };
  }

  protected lowerTry(
    stmt: Extract<Stmt, { type: 'Try' }>,
    path: string,
    meta: Record<string, unknown>,
    insert: InsertPoint | undefined
  ): void {
    const pins: Pin[] = [
      this.execIn(),
      this.execOut('try', 'Try', this.blockInsert(stmt.body)),
    ];
    const errorTypes: DataType[] = [];
    for (const [i, handler] of stmt.handlers.entries()) {
      const exception = handler.exception
        ? this.src(rangeOf(handler.exception))
        : undefined;
      errorTypes.push(errorType(exception));
      pins.push(
        this.execOut(
          `except${i}`,
          exception ? `Except ${truncate(exception, 18)}` : 'Except',
          this.blockInsert(handler.body)
        )
      );
      if (handler.name) {
        pins.push(
          this.dataOut(`error${i}`, handler.name, errorTypes[i] ?? 'any', {
            sourceText: handler.name,
          })
        );
      }
    }

    if (stmt.orelse) {
      pins.push(this.execOut('else', 'Else', this.blockInsert(stmt.orelse)));
    }

    if (stmt.finalbody) {
      pins.push(
        this.execOut('finally', 'Finally', this.blockInsert(stmt.finalbody))
      );
    }

    pins.push(this.execOut('completed', 'Completed', insert, true));
    const node = this.addNode({
      kind: 'try',
      title: 'Try',
      category: 'flow',
      purity: 'impure',
      range: rangeOf(stmt),
      pins,
      path,
      meta,
    });
    this.chain(node, 'try');
    this.lowerBlock(stmt.body, `${path}/try`);
    for (const [i, handler] of stmt.handlers.entries()) {
      this.cursor = { node: node.id, pin: `except${i}` };
      this.withScope(() => {
        if (handler.name) {
          // Its readers take the error's type too (`{1}` of a Format Text).
          this.declare(handler.name, {
            source: { node: node.id, pin: `error${i}` },
            type: errorTypes[i] ?? 'any',
          });
        }

        this.lowerBlock(handler.body, `${path}/except${i}`);
      });
    }

    if (stmt.orelse) {
      this.cursor = { node: node.id, pin: 'else' };
      this.lowerBlock(stmt.orelse, `${path}/else`);
    }

    if (stmt.finalbody) {
      this.cursor = { node: node.id, pin: 'finally' };
      this.lowerBlock(stmt.finalbody, `${path}/finally`);
    }

    this.cursor = { node: node.id, pin: 'completed' };
  }
}
