import type {
  GraphNode,
  InputSpec,
  InsertPoint,
  Pin,
  SourceRange,
} from '@vizscript/core';
import { lineIndent, markUnusedValue, truncate } from '@vizscript/core';
import type { Block, Expr, FunctionItem, Span, Stmt, ValueItem } from './ast';
import { ControlFlowLowering } from './control-flow-lowering';
import { dataTypeOf } from './data-type';
import type { ClosureSource } from './lower-utils';
import { isBlock, rangeOf, simpleChain, unwrap } from './lower-utils';

/** Lowers one function (or the constants of a module) into a FunctionGraph. */
export class FnGraphBuilder extends ControlFlowLowering {
  private statementInsert(stmt: Stmt): InsertPoint | undefined {
    // A value without `;` (the block's value) can't be followed.
    if (stmt.type === 'Expr' && !stmt.semicolon) {
      return undefined;
    }

    return {
      at: stmt.end,
      indent: lineIndent(this.text, stmt.start),
      mode: 'after',
    };
  }

  // ----------------------------------------------------------------- graphs

  public run(): void {
    const source = this.source;
    let range: SourceRange;
    if (source.type === 'module') {
      range = { start: 0, end: this.text.length };
      this.runModule(source.items);
    } else {
      range = rangeOf(source.fn);
      this.runFunction(source.name, source.kind, source.fn);
    }

    this.doc.functions.push({
      id: this.fnId,
      name: this.name,
      range,
      ...this.graph(),
    });
  }

  /** Constants and statics, like the variables of a module. */
  private runModule(items: ValueItem[]): void {
    const entry = this.addNode({
      kind: 'entry',
      title: 'Module',
      subtitle: this.doc.fileName,
      category: 'event',
      purity: 'impure',
      range: { start: 0, end: 0 },
      pins: [this.execOut('then', '')],
      path: 'entry',
      idText: 'entry|Module',
    });
    this.cursor = { node: entry.id, pin: 'then' };
    for (const [index, item] of items.entries()) {
      const path = `body/${index}`;
      this.currentStatement = rangeOf(item);
      const declared = item.valueType
        ? dataTypeOf(this.src(rangeOf(item.valueType)))
        : 'any';
      const valuePin = this.dataIn(
        'value',
        '',
        item.value ? rangeOf(item.value) : undefined,
        declared
      );
      const value = item.value
        ? this.lowerExpr(item.value, `${path}.value`, 'eager', item.name)
        : undefined;
      const type = declared === 'any' ? (value?.type ?? 'any') : declared;
      const keyword = item.type === 'Const' ? 'const' : 'static';
      const node = this.addNode({
        kind: 'setVar',
        title: `Set ${item.name}`,
        subtitle: [
          ...item.modifiers,
          keyword,
          ...(item.mutable ? ['mut'] : []),
        ].join(' '),
        category: 'function',
        purity: 'impure',
        range: rangeOf(item),
        pins: [
          this.execIn(),
          this.execOut('then', ''),
          valuePin,
          this.dataOut(
            'out',
            '',
            type,
            { sourceText: item.name },
            rangeOf(item.nameSpan)
          ),
        ],
        path,
        meta: {
          ...this.statementMeta(rangeOf(item), false),
          declares: [item.name],
        },
      });
      this.feed(node.id, valuePin, value);
      this.chain(node);
    }
  }

  private runFunction(
    name: string,
    kind: string,
    fn: FunctionItem | ClosureSource
  ): void {
    const isItem = 'type' in fn;
    const body = isItem ? fn.body : isBlock(fn.body) ? fn.body : undefined;
    const subtitle = isItem
      ? [...fn.modifiers.filter((m) => m !== 'pub'), kind].join(' ')
      : kind;
    const returns = fn.returns ? this.src(rangeOf(fn.returns)) : undefined;
    this.returnsValue = isItem
      ? returns !== undefined && dataTypeOf(returns) !== 'void'
      : returns === undefined || dataTypeOf(returns) !== 'void';
    const entryPins: Pin[] = [this.execOut('then', '', this.blockInsert(body))];
    const entry = this.addNode({
      kind: 'entry',
      title: name.split('::').at(-1) ?? name,
      subtitle: name.includes('::')
        ? `${subtitle} of ${name.split('::').slice(0, -1).join('::')}`
        : subtitle,
      // Like UE's purple function entry.
      category: 'entry',
      purity: 'impure',
      range: {
        start: isItem ? fn.headStart : fn.start,
        end: body ? body.start : fn.start,
      },
      pins: entryPins,
      path: 'entry',
      idText: `entry|${name}`,
    });
    if (isItem && fn.self) {
      const type = this.owner ?? 'Self';
      entryPins.push(
        this.dataOut(
          'self',
          'self',
          type,
          { sourceText: 'self' },
          rangeOf(fn.self)
        )
      );
      this.declare('self', { source: { node: entry.id, pin: 'self' }, type });
    }

    for (const [index, param] of fn.params.entries()) {
      const type = param.type
        ? dataTypeOf(this.src(rangeOf(param.type)), this.owner)
        : 'any';
      const pinId = `param${index}`;
      const label = param.name ?? this.src(rangeOf(param.pattern));
      entryPins.push(
        this.dataOut(
          pinId,
          label,
          type,
          { sourceText: param.name ?? label },
          rangeOf(param)
        )
      );
      if (param.name) {
        this.declare(param.name, {
          source: { node: entry.id, pin: pinId },
          type,
        });
      }
    }

    this.cursor = { node: entry.id, pin: 'then' };
    if (body) {
      this.lowerBlock(body, 'body', this.returnsValue);
      return;
    }

    if (!isItem && !isBlock(fn.body)) {
      // `|x| x + 1`: its expression is returned.
      this.implicitReturn(fn.body, 'body/0', rangeOf(fn.body));
    }
  }

  // ------------------------------------------------------------- statements

  protected lowerBlock(block: Block, path: string, tail: boolean): void {
    this.withScope(() => {
      const last = block.body.length - 1;
      for (const [index, stmt] of block.body.entries()) {
        this.lowerStatement(stmt, `${path}/${index}`, tail && index === last);
      }
    });
  }

  private lowerStatement(stmt: Stmt, path: string, tail: boolean): void {
    this.currentStatement = rangeOf(stmt);
    const meta = this.statementMeta(rangeOf(stmt), false);
    if (
      tail &&
      this.returnsValue &&
      (stmt.type === 'If' || stmt.type === 'Match')
    ) {
      // The function's value: deleting it leaves `todo!()`.
      meta['tail'] = true;
    }

    const insert = this.statementInsert(stmt);
    switch (stmt.type) {
      case 'Item': {
        if (stmt.item.type === 'Function' && stmt.item.body) {
          this.doc.queue.push({
            type: 'function',
            name: stmt.item.name,
            kind: 'fn',
            fn: stmt.item,
          });
        }

        return;
      }

      case 'Empty': {
        return;
      }

      case 'Let': {
        this.lowerLet(stmt, path, meta, insert);
        return;
      }

      case 'Assign': {
        this.lowerAssign(stmt, path, meta, insert);
        return;
      }

      case 'Expr': {
        if (tail && !stmt.semicolon && this.returnsValue) {
          this.implicitReturn(stmt.value, path, rangeOf(stmt));
          return;
        }

        this.lowerExpressionStatement(stmt, stmt.value, path, meta, insert);
        return;
      }

      case 'If': {
        this.lowerIf(stmt, path, meta, insert, tail);
        return;
      }

      case 'Match': {
        this.lowerMatch(stmt, path, meta, insert, tail);
        return;
      }

      case 'For': {
        this.lowerFor(stmt, path, meta, insert);
        return;
      }

      case 'While': {
        this.lowerWhile(stmt, path, meta, insert);
        return;
      }

      case 'Loop': {
        const node = this.addNode({
          kind: 'loop',
          title: 'Loop',
          subtitle: stmt.label,
          category: 'flow',
          purity: 'impure',
          range: rangeOf(stmt),
          pins: [
            this.execIn(),
            this.execOut('body', 'Loop Body', this.blockInsert(stmt.body)),
            this.execOut('completed', 'Completed', insert, true),
          ],
          path,
          meta,
        });
        this.chain(node, 'body');
        this.lowerBlock(stmt.body, `${path}/body`, false);
        this.cursor = { node: node.id, pin: 'completed' };
        return;
      }

      case 'Return': {
        const valuePin = stmt.value
          ? this.dataIn('value', '', rangeOf(stmt.value), 'any', {
              optional: true,
            })
          : // `return`: a value can be wired in after the keyword.
            this.dataIn('value', '', undefined, 'any', {
              insertInitAt: stmt.start + 'return'.length,
              insertPrefix: ' ',
            });
        const value = stmt.value
          ? this.lowerExpr(stmt.value, `${path}.value`, 'eager')
          : undefined;
        const node = this.addNode({
          kind: 'return',
          title: 'Return',
          category: 'return',
          purity: 'impure',
          range: rangeOf(stmt),
          pins: [this.execIn(), valuePin],
          path,
          meta,
        });
        this.feed(node.id, valuePin, value);
        this.chain(node, null);
        return;
      }

      case 'Break':
      case 'Continue': {
        const isBreak = stmt.type === 'Break';
        const pins: Pin[] = [this.execIn()];
        const value =
          isBreak && stmt.value
            ? this.lowerExpr(stmt.value, `${path}.value`, 'eager')
            : undefined;
        const valuePin =
          isBreak && stmt.value
            ? this.dataIn('value', '', rangeOf(stmt.value))
            : undefined;
        if (valuePin) {
          pins.push(valuePin);
        }

        const node = this.addNode({
          kind: isBreak ? 'break' : 'continue',
          title: isBreak ? 'Break' : 'Continue',
          subtitle: stmt.label,
          category: 'flow',
          purity: 'impure',
          range: rangeOf(stmt),
          pins,
          path,
          meta,
        });
        if (valuePin) {
          this.feed(node.id, valuePin, value);
        }

        this.chain(node, null);
        return;
      }

      case 'BlockStmt': {
        // `unsafe { … }` and `{ … }`: their statements run in place.
        this.lowerBlock(stmt.block, `${path}/block`, tail);
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

  /** The function's value: a Return node for the last expression. */
  protected implicitReturn(expr: Expr, path: string, range: SourceRange): void {
    const value = unwrap(expr);
    if (value.type === 'If') {
      this.lowerIf(
        value.stmt,
        path,
        this.statementMeta(range, false),
        undefined,
        true
      );
      return;
    }

    if (value.type === 'Match') {
      this.lowerMatch(
        value.stmt,
        path,
        this.statementMeta(range, false),
        undefined,
        true
      );
      return;
    }

    if (value.type === 'Block' && value.label === '') {
      this.lowerBlock(value.block, `${path}/block`, true);
      return;
    }

    this.currentStatement = range;
    const lowered = this.lowerExpr(expr, `${path}.value`, 'eager');
    const pin = this.dataIn('value', '', rangeOf(expr));
    const node = this.addNode({
      kind: 'return',
      title: 'Return',
      subtitle: 'value',
      category: 'return',
      purity: 'impure',
      range,
      pins: [this.execIn(), pin],
      path,
      meta: this.statementMeta(range, false),
    });
    this.feed(node.id, pin, lowered);
    this.chain(node, null);
  }

  /** An exec-chained node with `exec`/`then` pins plus the given inputs. */
  private simpleNode(
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
    if (value.type === 'Call' || value.type === 'Macro') {
      this.lowerCall(value, path, 'statement', { meta, insert, stmt });
      return;
    }

    if (value.type === 'Try' || value.type === 'Await') {
      // `send()?;` and `run().await;`: the call is the statement.
      const inner = unwrap(value.value);
      if (inner.type === 'Call' || inner.type === 'Macro') {
        this.lowerCall(inner, path, 'statement', {
          meta,
          insert,
          stmt,
          suffix: value.type === 'Try' ? '?' : '.await',
        });
        return;
      }
    }

    if (value.type === 'If') {
      this.lowerIf(value.stmt, path, meta, insert, false);
      return;
    }

    if (value.type === 'Match') {
      this.lowerMatch(value.stmt, path, meta, insert, false);
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

  private lowerLet(
    stmt: Extract<Stmt, { type: 'Let' }>,
    path: string,
    meta: Record<string, unknown>,
    insert: InsertPoint | undefined
  ): void {
    const name = stmt.pattern.simple;
    const declared = stmt.valueType
      ? dataTypeOf(this.src(rangeOf(stmt.valueType)), this.owner)
      : 'any';
    const value = stmt.value ? unwrap(stmt.value) : undefined;
    if (value?.type === 'Closure' && name) {
      this.queueClosure(name, value);
    }

    const valuePin = this.dataIn(
      'value',
      '',
      stmt.value ? rangeOf(stmt.value) : undefined,
      declared,
      stmt.value
        ? undefined
        : { insertInitAt: stmt.valueType?.end ?? stmt.pattern.end }
    );
    const lowered = stmt.value
      ? this.lowerExpr(stmt.value, `${path}.value`, 'eager', name)
      : undefined;
    const type = declared === 'any' ? (lowered?.type ?? 'any') : declared;
    const title = name
      ? `Set ${name}`
      : `Set ${truncate(this.src(rangeOf(stmt.pattern)), 28)}`;
    const outputs: Pin[] = name
      ? [
          this.dataOut(
            'out',
            '',
            type,
            { sourceText: name },
            rangeOf(stmt.pattern.bindings[0] ?? stmt.pattern)
          ),
        ]
      : stmt.pattern.bindings.map((b, i) =>
          this.dataOut(
            `out${i}`,
            b.name,
            'any',
            { sourceText: b.name },
            rangeOf(b)
          )
        );
    const pins: Pin[] = [
      this.execIn(),
      this.execOut('then', '', insert),
      valuePin,
      ...outputs,
    ];
    if (stmt.orelse) {
      pins.push(this.execOut('else', 'Else', this.blockInsert(stmt.orelse)));
    }

    const node = this.addNode({
      kind: 'setVar',
      title,
      subtitle: [
        stmt.mutable ? 'let mut' : 'let',
        ...(stmt.valueType ? [`: ${this.src(rangeOf(stmt.valueType))}`] : []),
      ].join(' '),
      category: 'function',
      purity: 'impure',
      range: rangeOf(stmt),
      pins,
      path,
      meta: {
        ...meta,
        declares: stmt.pattern.bindings.map((b) => b.name),
      },
    });
    this.feed(node.id, valuePin, lowered);
    if (valuePin.type === 'any') {
      valuePin.type = type;
    }

    if (stmt.orelse) {
      const cursor = { node: node.id, pin: 'then' };
      this.chain(node, 'else');
      this.lowerBlock(stmt.orelse, `${path}/else`, false);
      this.cursor = cursor;
    } else {
      this.chain(node);
    }

    if (name) {
      this.declare(name, { type });
    } else {
      for (const binding of stmt.pattern.bindings) {
        this.declare(binding.name, { type: 'any' });
      }
    }
  }

  private lowerAssign(
    stmt: Extract<Stmt, { type: 'Assign' }>,
    path: string,
    meta: Record<string, unknown>,
    insert: InsertPoint | undefined
  ): void {
    const target = unwrap(stmt.target);
    const inputs: InputSpec[] = [];
    let title: string;
    let varName: string | undefined;
    const chain = simpleChain(target);
    const rootWired =
      chain?.[0] !== undefined &&
      chain[0] !== 'self' &&
      this.lookup(chain[0])?.source !== undefined;
    if (chain && !(rootWired && chain.length > 1)) {
      varName = chain.join('.');
      title = `Set ${varName}`;
    } else if (target.type === 'Field') {
      title = `Set .${target.name}`;
      inputs.push({
        pin: this.dataIn('target', 'Target', rangeOf(target.object), 'object'),
        value: this.lowerExpr(target.object, `${path}.target`, 'eager'),
      });
    } else if (target.type === 'Index') {
      title = 'Set [ ]';
      inputs.push(
        {
          pin: this.dataIn(
            'target',
            'Target',
            rangeOf(target.object),
            'object'
          ),
          value: this.lowerExpr(target.object, `${path}.target`, 'eager'),
        },
        {
          pin: this.dataIn('key', 'Index', rangeOf(target.index)),
          value: this.lowerExpr(target.index, `${path}.key`, 'eager'),
        }
      );
    } else if (target.type === 'Unary' && target.op === '*') {
      title = `Set *${truncate(this.src(rangeOf(target.argument)), 24)}`;
      inputs.push({
        pin: this.dataIn('target', 'Target', rangeOf(target.argument)),
        value: this.lowerExpr(target.argument, `${path}.target`, 'eager'),
      });
    } else {
      title = `Set ${truncate(this.src(rangeOf(target)), 28)}`;
    }

    const value = this.lowerExpr(stmt.value, `${path}.value`, 'eager', varName);
    const valuePin = this.dataIn('value', '', rangeOf(stmt.value));
    inputs.push({ pin: valuePin, value });
    const known = varName
      ? (this.lookup(varName)?.type ?? this.doc.globals.get(varName))
      : undefined;
    const type = known && known !== 'any' ? known : value.type;
    if (valuePin.type === 'any' && known && known !== 'any') {
      valuePin.type = known;
    }

    this.simpleNode(stmt, path, meta, insert, {
      kind: 'setVar',
      title,
      subtitle: stmt.op,
      category: 'function',
      inputs,
      outputs: [
        this.dataOut(
          'out',
          '',
          type,
          varName ? { sourceText: varName } : {},
          rangeOf(target)
        ),
      ],
    });
  }
}
