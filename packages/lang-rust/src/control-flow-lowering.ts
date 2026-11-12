import type {
  GraphNode,
  InsertPoint,
  Pin,
  SourceRange,
  StatementMeta,
  ValueSource,
} from '@vizscript/core';
import { arrayElementType, lineIndent, truncate } from '@vizscript/core';
import type {
  Block,
  Expr,
  IfStmt,
  MatchStmt,
  Pattern,
  Span,
  Stmt,
} from './ast';
import { ExpressionLowering } from './expression-lowering';
import { isBlock, rangeOf, unwrap } from './lower-utils';

/** Branches and loops: `if`, `match`, `for`, `while` and their patterns. */
export abstract class ControlFlowLowering extends ExpressionLowering {
  /** The function's value is its last expression (`-> T`). */
  protected returnsValue = false;

  protected abstract lowerBlock(
    block: Block,
    path: string,
    tail: boolean
  ): void;

  protected abstract implicitReturn(
    expr: Expr,
    path: string,
    range: SourceRange
  ): void;

  protected abstract lowerExpressionStatement(
    stmt: Span,
    rawValue: Expr,
    path: string,
    meta: Record<string, unknown>,
    insert: InsertPoint | undefined
  ): void;

  // ---------------------------------------------------------------- inserts

  protected blockInsert(block: Block | undefined): InsertPoint | undefined {
    if (!block || block.open >= block.close) {
      return undefined;
    }

    const first = block.body[0];
    const indent = first
      ? lineIndent(this.text, first.start)
      : `${lineIndent(this.text, block.start)}    `;
    return { at: block.open, indent, mode: 'after' };
  }

  // ------------------------------------------------------------ control flow

  /** A condition input: a `let` pattern binds names (`if let Some(x)`). */
  protected lowerCondition(
    condition: Expr,
    path: string
  ): {
    pin: Pin;
    value: ValueSource | undefined;
    title: string;
    subtitle?: string;
    bindings: Pattern['bindings'];
  } {
    const cond = unwrap(condition);
    if (cond.type === 'Let') {
      return {
        pin: this.dataIn('condition', 'Value', rangeOf(cond.value)),
        value: this.lowerExpr(cond.value, `${path}.test`, 'eager'),
        title: 'If Let',
        subtitle: truncate(this.src(rangeOf(cond.pattern)), 28),
        bindings: cond.pattern.bindings,
      };
    }

    if (cond.type === 'LetChain') {
      return {
        pin: this.dataIn('condition', 'Condition', rangeOf(cond), 'bool'),
        value: this.pureNode({
          kind: 'unknown',
          title: truncate(this.src(rangeOf(cond)), 32),
          subtitle: 'let chain',
          range: rangeOf(cond),
          path: `${path}.test`,
          inputs: [],
          outType: 'bool',
          category: 'unknown',
        }),
        title: 'If Let',
        bindings: cond.parts.flatMap((p) =>
          p.type === 'Let' ? p.pattern.bindings : []
        ),
      };
    }

    return {
      pin: this.dataIn('condition', 'Condition', rangeOf(cond), 'bool'),
      value: this.lowerExpr(cond, `${path}.test`, 'eager'),
      title: 'Branch',
      bindings: [],
    };
  }

  /** Outputs for the names a pattern binds (`Some(x)` → `x`). */
  protected bindingOutputs(
    bindings: Pattern['bindings'],
    prefix: string,
    visibleIn: SourceRange
  ): Pin[] {
    return bindings.map((b, i) =>
      this.dataOut(`${prefix}${i}`, b.name, 'any', {
        sourceText: b.name,
        visibleIn,
      })
    );
  }

  protected declareBindings(
    nodeId: string,
    bindings: Pattern['bindings'],
    prefix: string
  ): void {
    for (const [i, b] of bindings.entries()) {
      this.declare(b.name, {
        source: { node: nodeId, pin: `${prefix}${i}` },
        type: 'any',
      });
    }
  }

  protected lowerIf(
    stmt: IfStmt,
    path: string,
    meta: Record<string, unknown>,
    insert: InsertPoint | undefined,
    tail: boolean
  ): void {
    const parts = [
      { condition: stmt.condition, body: stmt.body, span: stmt as Span },
      ...stmt.elifs.map((e) => ({
        condition: e.condition,
        body: e.body,
        span: e as Span,
      })),
    ];
    let first: GraphNode | undefined;
    for (const [index, part] of parts.entries()) {
      const isElif = index > 0;
      const next = parts[index + 1] ? undefined : stmt.orelse;
      const branchPath = isElif ? `${path}/elif${index}` : path;
      const condition = this.lowerCondition(part.condition, branchPath);
      const pins: Pin[] = [
        this.execIn(),
        condition.pin,
        this.execOut('true', 'True', this.blockInsert(part.body)),
        this.execOut('false', 'False', this.blockInsert(next)),
        ...this.bindingOutputs(condition.bindings, 'bind', rangeOf(part.body)),
      ];
      if (!isElif && !tail) {
        pins.push(this.execOut('completed', 'Completed', insert, true));
      }

      const elifMeta: StatementMeta = {
        stmt: rangeOf(part.span),
        locked: true,
      };
      const node = this.addNode({
        kind: 'branch',
        title: condition.title,
        subtitle: isElif
          ? ['else if', condition.subtitle].filter(Boolean).join(' ')
          : condition.subtitle,
        category: 'flow',
        purity: 'impure',
        range: rangeOf(part.span),
        pins,
        path: branchPath,
        meta: isElif ? (elifMeta as unknown as Record<string, unknown>) : meta,
      });
      this.feed(node.id, condition.pin, condition.value);
      this.chain(node, 'true');
      this.withScope(() => {
        this.declareBindings(node.id, condition.bindings, 'bind');
        this.lowerBlock(part.body, `${branchPath}/then`, tail);
      });
      this.cursor = { node: node.id, pin: 'false' };
      first ??= node;
    }

    if (stmt.orelse) {
      this.lowerBlock(stmt.orelse, `${path}/else`, tail);
    }

    this.cursor = first && !tail ? { node: first.id, pin: 'completed' } : null;
  }

  protected lowerMatch(
    stmt: MatchStmt,
    path: string,
    meta: Record<string, unknown>,
    insert: InsertPoint | undefined,
    tail: boolean
  ): void {
    const valuePin = this.dataIn('value', 'Subject', rangeOf(stmt.subject));
    const value = this.lowerExpr(stmt.subject, `${path}.value`, 'eager');
    const pins: Pin[] = [this.execIn(), valuePin];
    for (const [i, arm] of stmt.arms.entries()) {
      const label = this.src(rangeOf(arm.pattern));
      const guard = arm.guard ? ` if ${this.src(rangeOf(arm.guard))}` : '';
      pins.push(
        this.execOut(
          `case${i}`,
          truncate(`${label}${guard}`, 24),
          isBlock(arm.body) ? this.blockInsert(arm.body) : undefined
        ),
        ...this.bindingOutputs(arm.pattern.bindings, `case${i}_`, rangeOf(arm))
      );
    }

    if (!tail) {
      pins.push(this.execOut('completed', 'Completed', insert, true));
    }

    const node = this.addNode({
      kind: 'switch',
      title: 'Match',
      category: 'flow',
      purity: 'impure',
      range: rangeOf(stmt),
      pins,
      path,
      meta,
    });
    this.feed(node.id, valuePin, value);
    this.chain(node, null);
    for (const [i, arm] of stmt.arms.entries()) {
      this.cursor = { node: node.id, pin: `case${i}` };
      this.withScope(() => {
        this.declareBindings(node.id, arm.pattern.bindings, `case${i}_`);
        const armPath = `${path}/case${i}`;
        if (isBlock(arm.body)) {
          this.lowerBlock(arm.body, armPath, tail);
        } else if (tail && this.returnsValue) {
          this.implicitReturn(arm.body, `${armPath}/0`, rangeOf(arm.body));
        } else {
          this.currentStatement = rangeOf(arm.body);
          this.lowerExpressionStatement(
            arm.body,
            arm.body,
            `${armPath}/0`,
            { ...this.statementMeta(rangeOf(arm.body), false), locked: true },
            undefined
          );
        }
      });
    }

    this.cursor = tail ? null : { node: node.id, pin: 'completed' };
  }

  protected lowerFor(
    stmt: Extract<Stmt, { type: 'For' }>,
    path: string,
    meta: Record<string, unknown>,
    insert: InsertPoint | undefined
  ): void {
    const iterPin = this.dataIn(
      'array',
      'Iterable',
      rangeOf(stmt.iter),
      'array'
    );
    const iterable = this.lowerExpr(stmt.iter, `${path}.iter`, 'eager');
    const name = stmt.pattern.simple;
    const elementName = this.src(rangeOf(stmt.pattern));
    const elementType = name ? arrayElementType(iterable.type) : 'any';
    const iter = unwrap(stmt.iter);
    const isRange = iter.type === 'Range';
    const pins: Pin[] = [
      this.execIn(),
      iterPin,
      this.execOut('body', 'Loop Body', this.blockInsert(stmt.body)),
    ];
    if (name) {
      pins.push(
        this.dataOut('element', name, isRange ? 'number' : elementType, {
          sourceText: name,
          visibleIn: rangeOf(stmt.body),
        })
      );
    } else {
      pins.push(
        ...this.bindingOutputs(
          stmt.pattern.bindings,
          'element',
          rangeOf(stmt.body)
        )
      );
    }

    pins.push(this.execOut('completed', 'Completed', insert, true));
    const node = this.addNode({
      kind: 'forEach',
      title: isRange ? 'For Loop' : 'For Each',
      subtitle: stmt.label ?? (name ? undefined : truncate(elementName, 24)),
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
      if (name) {
        this.declare(name, {
          source: { node: node.id, pin: 'element' },
          type: isRange ? 'number' : elementType,
        });
      } else {
        this.declareBindings(node.id, stmt.pattern.bindings, 'element');
      }

      this.lowerBlock(stmt.body, `${path}/body`, false);
    });
    this.cursor = { node: node.id, pin: 'completed' };
  }

  protected lowerWhile(
    stmt: Extract<Stmt, { type: 'While' }>,
    path: string,
    meta: Record<string, unknown>,
    insert: InsertPoint | undefined
  ): void {
    const condition = this.lowerCondition(stmt.condition, path);
    const node = this.addNode({
      kind: 'loop',
      title: condition.title === 'If Let' ? 'While Let' : 'While Loop',
      subtitle:
        [stmt.label, condition.subtitle].filter(Boolean).join(' ') || undefined,
      category: 'flow',
      purity: 'impure',
      range: rangeOf(stmt),
      pins: [
        this.execIn(),
        condition.pin,
        this.execOut('body', 'Loop Body', this.blockInsert(stmt.body)),
        ...this.bindingOutputs(condition.bindings, 'bind', rangeOf(stmt.body)),
        this.execOut('completed', 'Completed', insert, true),
      ],
      path,
      meta,
    });
    this.feed(node.id, condition.pin, condition.value);
    this.chain(node, 'body');
    this.withScope(() => {
      this.declareBindings(node.id, condition.bindings, 'bind');
      this.lowerBlock(stmt.body, `${path}/body`, false);
    });
    this.cursor = { node: node.id, pin: 'completed' };
  }
}
