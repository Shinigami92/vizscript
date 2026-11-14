import type { GraphNode, InputSpec, InsertPoint, Pin } from '@vizscript/core';
import { markUnusedValue, truncate } from '@vizscript/core';
import type { Block, ClassDef, Expr, FunctionDef, Span, Stmt } from './ast';
import { ControlFlowLowering } from './control-flow-lowering';
import {
  dataTypeOf,
  isDeclarationOnly,
  rangeOf,
  simpleChain,
  unwrap,
} from './lower-utils';

/** Lowers statements and declarations into exec nodes. */
export abstract class StatementLowering extends ControlFlowLowering {
  protected queueFunction(name: string, kind: string, fn: FunctionDef): void {
    this.doc.queue.push({ type: 'function', name, kind, fn });
  }

  protected prefix(): string {
    return this.source.type === 'class' ? `${this.source.name}.` : '';
  }

  // ------------------------------------------------------------- statements

  protected lowerStatements(
    stmts: ReadonlyArray<Stmt>,
    path: string,
    inline: boolean,
    sole: boolean
  ): void {
    this.withScope(() => {
      for (const [index, stmt] of stmts.entries()) {
        this.lowerStatement(stmt, `${path}/${index}`, inline, sole);
      }
    });
  }

  protected override lowerBlock(block: Block, path: string): void {
    const sole = !block.inline && block.body.length === 1;
    this.lowerStatements(block.body, path, block.inline, sole);
  }

  protected lowerStatement(
    stmt: Stmt,
    path: string,
    inline: boolean,
    sole: boolean
  ): void {
    this.currentStatement = rangeOf(stmt);
    const meta = this.statementMeta(rangeOf(stmt), inline, sole);
    const insert = this.statementInsert(stmt, inline);
    switch (stmt.type) {
      case 'FunctionDef': {
        this.queueFunction(
          `${this.prefix()}${stmt.name}`,
          this.source.type === 'class' ? 'method' : 'def',
          stmt
        );
        return;
      }

      case 'ClassDef': {
        this.queueClass(`${this.prefix()}${stmt.name}`, stmt);
        return;
      }

      case 'Import':
      case 'Scope':
      case 'Pass': {
        return;
      }

      case 'Expr': {
        this.lowerExpressionStatement(stmt, stmt.value, path, meta, insert);
        return;
      }

      case 'Assign': {
        this.lowerAssign(stmt, path, meta, insert);
        return;
      }

      case 'AugAssign': {
        const chain = simpleChain(stmt.target);
        const name =
          chain?.join('.') ?? truncate(this.src(rangeOf(stmt.target)), 24);
        const value = this.lowerExpr(stmt.value, `${path}.value`, 'eager');
        this.simpleNode(stmt, path, meta, insert, {
          kind: 'setVar',
          title: `Set ${name}`,
          subtitle: stmt.op,
          category: 'function',
          inputs: [
            { pin: this.dataIn('value', '', rangeOf(stmt.value)), value },
          ],
          outputs: [
            this.dataOut(
              'out',
              '',
              value.type,
              chain ? { sourceText: name } : {},
              rangeOf(stmt.target)
            ),
          ],
        });
        return;
      }

      case 'If': {
        this.lowerIf(stmt, path, meta, insert);
        return;
      }

      case 'For': {
        this.lowerFor(stmt, path, meta, insert);
        return;
      }

      case 'While': {
        const condPin = this.dataIn(
          'condition',
          'Condition',
          rangeOf(stmt.test),
          'bool'
        );
        const condition = this.lowerExpr(stmt.test, `${path}.test`, 'lazy');
        const pins: Pin[] = [
          this.execIn(),
          condPin,
          this.execOut('body', 'Loop Body', this.blockInsert(stmt.body)),
        ];
        if (stmt.orelse) {
          pins.push(
            this.execOut('else', 'Else', this.blockInsert(stmt.orelse))
          );
        }

        pins.push(this.execOut('completed', 'Completed', insert, true));
        const node = this.addNode({
          kind: 'loop',
          title: 'While Loop',
          category: 'flow',
          purity: 'impure',
          range: rangeOf(stmt),
          pins,
          path,
          meta,
        });
        this.feed(node.id, condPin, condition);
        this.chain(node, 'body');
        this.lowerBlock(stmt.body, `${path}/body`);
        if (stmt.orelse) {
          this.cursor = { node: node.id, pin: 'else' };
          this.lowerBlock(stmt.orelse, `${path}/else`);
        }

        this.cursor = { node: node.id, pin: 'completed' };
        return;
      }

      case 'With': {
        this.lowerWith(stmt, path, meta, insert);
        return;
      }

      case 'Try': {
        this.lowerTry(stmt, path, meta, insert);
        return;
      }

      case 'Match': {
        const valuePin = this.dataIn('value', 'Subject', rangeOf(stmt.subject));
        const value = this.lowerExpr(stmt.subject, `${path}.value`, 'eager');
        const pins: Pin[] = [this.execIn(), valuePin];
        for (const [i, kase] of stmt.cases.entries()) {
          pins.push(
            this.execOut(
              `case${i}`,
              truncate(this.src(rangeOf(kase.pattern)), 20),
              this.blockInsert(kase.body)
            )
          );
        }

        pins.push(this.execOut('completed', 'Completed', insert, true));
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
        for (const [i, kase] of stmt.cases.entries()) {
          this.cursor = { node: node.id, pin: `case${i}` };
          this.lowerBlock(kase.body, `${path}/case${i}`);
        }

        this.cursor = { node: node.id, pin: 'completed' };
        return;
      }

      case 'Return':
      case 'Raise': {
        const isReturn = stmt.type === 'Return';
        const valueExpr = isReturn ? stmt.value : stmt.exception;
        const valuePin = valueExpr
          ? this.dataIn(
              isReturn ? 'value' : 'error',
              isReturn ? '' : 'Exception',
              rangeOf(valueExpr),
              'any',
              isReturn ? { optional: true } : undefined
            )
          : isReturn
            ? // `return`: a value can be wired in after the keyword.
              this.dataIn('value', '', undefined, 'any', {
                insertInitAt: rangeOf(stmt).start + 'return'.length,
                insertPrefix: ' ',
              })
            : undefined;
        const value = valueExpr
          ? this.lowerExpr(valueExpr, `${path}.value`, 'eager')
          : undefined;
        const node = this.addNode({
          kind: isReturn ? 'return' : 'throw',
          title: isReturn ? 'Return' : 'Raise',
          category: isReturn ? 'return' : 'flow',
          purity: 'impure',
          range: rangeOf(stmt),
          pins: valuePin ? [this.execIn(), valuePin] : [this.execIn()],
          path,
          meta,
        });
        if (valuePin) {
          this.feed(node.id, valuePin, value);
        }

        this.chain(node, null);
        return;
      }

      case 'Break':
      case 'Continue': {
        const isBreak = stmt.type === 'Break';
        const node = this.addNode({
          kind: isBreak ? 'break' : 'continue',
          title: isBreak ? 'Break' : 'Continue',
          category: 'flow',
          purity: 'impure',
          range: rangeOf(stmt),
          pins: [this.execIn()],
          path,
          meta,
        });
        this.chain(node, null);
        return;
      }

      case 'Assert': {
        const inputs: InputSpec[] = [
          {
            pin: this.dataIn(
              'condition',
              'Condition',
              rangeOf(stmt.test),
              'bool'
            ),
            value: this.lowerExpr(stmt.test, `${path}.test`, 'eager'),
          },
        ];
        if (stmt.message) {
          inputs.push({
            pin: this.dataIn('message', 'Message', rangeOf(stmt.message)),
            value: this.lowerExpr(stmt.message, `${path}.message`, 'eager'),
          });
        }

        this.simpleNode(stmt, path, meta, insert, {
          kind: 'call',
          title: 'Assert',
          category: 'function',
          inputs,
        });
        return;
      }

      case 'Delete': {
        const targets = stmt.targets.map((t) => this.src(rangeOf(t)));
        this.simpleNode(stmt, path, meta, insert, {
          kind: 'setVar',
          title: `Delete ${truncate(targets.join(', '), 24)}`,
          category: 'function',
          inputs: [],
        });
        return;
      }

      case 'Yield': {
        const inputs: InputSpec[] = stmt.value
          ? [
              {
                pin: this.dataIn('value', '', rangeOf(stmt.value)),
                value: this.lowerExpr(stmt.value, `${path}.value`, 'eager'),
              },
            ]
          : [];
        this.simpleNode(stmt, path, meta, insert, {
          kind: 'await',
          title: 'Yield',
          category: 'latent',
          inputs,
        });
        return;
      }

      case 'Error': {
        this.simpleNode(stmt, path, meta, insert, {
          kind: 'unknown',
          title: truncate(this.src(rangeOf(stmt)), 32),
          subtitle: 'Syntax error',
          category: 'unknown',
          inputs: [],
        });
      }
    }
  }

  /** Classes with only methods get no graph of their own. */
  protected queueClass(name: string, cls: ClassDef): void {
    if (cls.body.body.some((s) => !isDeclarationOnly(s))) {
      this.doc.queue.push({ type: 'class', name, cls });
      return;
    }

    for (const member of cls.body.body) {
      if (member.type === 'FunctionDef') {
        this.queueFunction(`${name}.${member.name}`, 'method', member);
      } else if (member.type === 'ClassDef') {
        this.queueClass(`${name}.${member.name}`, member);
      }
    }
  }

  /** An exec-chained node with `exec`/`then` pins plus the given inputs. */
  protected simpleNode(
    stmt: Span,
    path: string,
    meta: Record<string, unknown>,
    insert: InsertPoint | undefined,
    options: {
      kind: GraphNode['kind'];
      title: string;
      subtitle?: string;
      category: GraphNode['category'];
      inputs: InputSpec[];
      outputs?: Pin[];
    }
  ): GraphNode {
    const node = this.addNode({
      kind: options.kind,
      title: options.title,
      subtitle: options.subtitle,
      category: options.category,
      purity: 'impure',
      range: rangeOf(stmt),
      pins: [
        this.execIn(),
        this.execOut('then', '', insert),
        ...options.inputs.map((i) => i.pin),
        ...(options.outputs ?? []),
      ],
      path,
      meta,
    });
    this.feedAll(node.id, options.inputs);
    this.chain(node);
    return node;
  }

  protected lowerExpressionStatement(
    stmt: Span,
    rawValue: Expr,
    path: string,
    meta: Record<string, unknown>,
    insert: InsertPoint | undefined
  ): void {
    const value = unwrap(rawValue);
    if (value.type === 'Literal' && value.kind === 'string') {
      return; // docstring
    }

    if (value.type === 'Call') {
      this.lowerCall(value, path, 'statement', { meta, insert, stmt });
      return;
    }

    if (value.type === 'Await') {
      const awaited = this.lowerExpr(value.argument, `${path}.value`, 'eager');
      const pin = this.dataIn(
        'awaitable',
        'Awaitable',
        rangeOf(value.argument)
      );
      const node = this.addNode({
        kind: 'await',
        title: 'Await',
        category: 'latent',
        purity: 'impure',
        range: rangeOf(stmt),
        pins: [
          this.execIn(),
          this.execOut('then', '', insert),
          pin,
          this.dataOut(
            'result',
            'Result',
            'any',
            {
              bind: {
                expr: rangeOf(value),
                stmt: rangeOf(stmt),
                isStatement: true,
                nameHint: 'result',
              },
            },
            rangeOf(value)
          ),
        ],
        path,
        meta,
      });
      this.feed(node.id, pin, awaited);
      this.chain(node);
      return;
    }

    const before = this.nodes.length;
    const evaluated = this.lowerExpr(value, `${path}.value`, 'lazy');
    if (markUnusedValue(this.nodes, before, evaluated, meta)) {
      return;
    }

    this.simpleNode(stmt, path, meta, insert, {
      kind: 'unknown',
      title: 'Evaluate',
      category: 'unknown',
      inputs: [
        { pin: this.dataIn('value', '', rangeOf(value)), value: evaluated },
      ],
    });
  }

  protected lowerAssign(
    stmt: Extract<Stmt, { type: 'Assign' }>,
    path: string,
    meta: Record<string, unknown>,
    insert: InsertPoint | undefined
  ): void {
    const targets = stmt.targets.map((t) => unwrap(t));
    const first = targets.length === 1 ? targets[0] : undefined;
    const declared = stmt.annotation
      ? dataTypeOf(this.src(rangeOf(stmt.annotation)))
      : 'any';
    const value = stmt.value ? unwrap(stmt.value) : undefined;

    if (value?.type === 'Lambda' && first?.type === 'Name') {
      // `f = lambda x: ...` defines a function graph.
      this.doc.queue.push({
        type: 'function',
        name: `${this.prefix()}${first.name}`,
        kind: 'lambda',
        fn: {
          params: value.params,
          body: value.body,
          start: value.start,
          end: value.end,
        },
      });
    }

    const inputs: InputSpec[] = [];
    let title: string;
    let varName: string | undefined;
    const chain = first ? simpleChain(first) : undefined;
    const rootWired =
      chain?.[0] !== undefined && this.lookup(chain[0])?.source !== undefined;
    if (chain && !(rootWired && chain.length > 1 && chain[0] !== 'self')) {
      varName = chain.join('.');
      title = `Set ${varName}`;
    } else if (first?.type === 'Attribute') {
      title = `Set .${first.name}`;
      inputs.push({
        pin: this.dataIn('target', 'Target', rangeOf(first.object), 'object'),
        value: this.lowerExpr(first.object, `${path}.target`, 'eager'),
      });
    } else if (first?.type === 'Subscript') {
      const sliced = first.index.type === 'Opaque';
      title = sliced
        ? `Set [${truncate(this.src(rangeOf(first.index)), 12)}]`
        : 'Set [ ]';
      inputs.push({
        pin: this.dataIn('target', 'Target', rangeOf(first.object), 'object'),
        value: this.lowerExpr(first.object, `${path}.target`, 'eager'),
      });
      if (!sliced) {
        inputs.push({
          pin: this.dataIn('key', 'Key', rangeOf(first.index)),
          value: this.lowerExpr(first.index, `${path}.key`, 'eager'),
        });
      }
    } else {
      title = `Set ${truncate(targets.map((t) => this.src(rangeOf(t))).join(' = '), 28)}`;
    }

    const valuePin = this.dataIn(
      'value',
      '',
      value ? rangeOf(value) : undefined,
      declared,
      value
        ? undefined
        : { insertInitAt: stmt.annotation?.end ?? targets[0]?.end ?? stmt.end }
    );
    const lowered = value
      ? this.lowerExpr(value, `${path}.value`, 'eager', varName)
      : undefined;
    inputs.push({ pin: valuePin, value: lowered });
    const type = declared === 'any' ? (lowered?.type ?? 'any') : declared;
    this.simpleNode(stmt, path, meta, insert, {
      kind: 'setVar',
      title,
      subtitle: stmt.annotation
        ? `: ${this.src(rangeOf(stmt.annotation))}`
        : undefined,
      category: 'function',
      inputs,
      outputs: [
        this.dataOut(
          'out',
          '',
          type,
          varName ? { sourceText: varName } : {},
          first && rangeOf(first)
        ),
      ],
    });
    if (valuePin.type === 'any') {
      valuePin.type = type;
    }

    if (first?.type === 'Name') {
      this.declare(first.name, { type });
    }
  }
}
