import type {
  GraphNode,
  InputSpec,
  Pin,
  SourceRange,
  ValueSource,
} from '@vizscript/core';
import { markUnusedValue, truncate } from '@vizscript/core';
import type { Block, Expr, Span, Stmt, VarDecl } from './ast';
import { ControlFlowLowering } from './control-flow-lowering';
import { dataTypeOf } from './data-type';
import { rangeOf, simpleChain, unwrap } from './lower-utils';

/** Engine callbacks shown as events (like Blueprint's Event BeginPlay). */
const VIRTUAL_METHODS = new Set([
  '_init',
  '_ready',
  '_enter_tree',
  '_exit_tree',
  '_process',
  '_physics_process',
  '_input',
  '_unhandled_input',
  '_unhandled_key_input',
  '_shortcut_input',
  '_gui_input',
  '_draw',
  '_notification',
  '_to_string',
  '_get',
  '_set',
  '_get_property_list',
  '_validate_property',
  '_integrate_forces',
  '_run',
]);

/** Lowers one function (or the members of a class) into a FunctionGraph. */
export class FnGraphBuilder extends ControlFlowLowering {
  // -------------------------------------------------------------- graphs

  public run(): void {
    const source = this.source;
    const entryPins: Pin[] = [];
    let entry: GraphNode;
    let range: SourceRange;

    if (source.type === 'class') {
      range = rangeOf(source.range);
      // Class members can't take arbitrary statements: no insert point.
      entryPins.push(this.execOut('then', ''));
      entry = this.addNode({
        kind: 'entry',
        title: source.name,
        subtitle: source.subtitle,
        category: 'event',
        purity: 'impure',
        range: { start: 0, end: 0 },
        pins: entryPins,
        path: 'entry',
        idText: `entry|${source.name}`,
      });
      this.cursor = { node: entry.id, pin: 'then' };
      this.lowerMembers(source.body, source.prefix);
    } else {
      const fn = source.fn;
      range = rangeOf(fn);
      entryPins.push(this.execOut('then', '', this.blockInsert(fn.body)));
      const shortName = source.name.split('.').at(-1) ?? source.name;
      // Engine callbacks and signal handlers (`_on_button_pressed`) are
      // events, like UE's red event nodes; other functions start purple.
      const event =
        VIRTUAL_METHODS.has(shortName) || shortName.startsWith('_on_');
      const subtitle = VIRTUAL_METHODS.has(shortName)
        ? 'event'
        : `${fn.isStatic ? 'static ' : ''}${source.kind}`;
      entry = this.addNode({
        kind: 'entry',
        title: source.name,
        subtitle,
        category: event ? 'event' : 'entry',
        purity: 'impure',
        range: { start: fn.start, end: fn.body.start },
        pins: entryPins,
        path: 'entry',
        idText: `entry|${source.name}`,
      });
      for (const [index, param] of fn.params.entries()) {
        const type = param.type
          ? dataTypeOf(param.type)
          : param.defaultValue
            ? this.literalType(param.defaultValue)
            : 'any';
        const pinId = `param${index}`;
        entryPins.push(
          this.dataOut(
            pinId,
            param.name,
            type,
            { sourceText: param.name },
            rangeOf(param)
          )
        );
        this.declare(param.name, {
          source: { node: entry.id, pin: pinId },
          type,
        });
      }

      this.cursor = { node: entry.id, pin: 'then' };
      this.lowerBlock(fn.body, 'body');
    }

    this.doc.functions.push({
      id: this.fnId,
      name: this.name,
      range,
      ...this.graph(),
    });
  }

  /** Member variables in declaration order, functions as their own graphs. */
  private lowerMembers(body: ReadonlyArray<Stmt>, prefix: string): void {
    for (const [index, stmt] of body.entries()) {
      const path = `members/${index}`;
      switch (stmt.type) {
        case 'Var': {
          this.lowerVar(stmt, path, false, false, true);
          if (stmt.setter) {
            this.queueFunction(
              `${prefix}${stmt.name}.set`,
              'setter',
              stmt.setter
            );
          }

          if (stmt.getter) {
            this.queueFunction(
              `${prefix}${stmt.name}.get`,
              'getter',
              stmt.getter
            );
          }

          break;
        }

        case 'Func': {
          this.queueFunction(
            `${prefix}${stmt.name ?? 'anonymous'}`,
            'func',
            stmt
          );
          break;
        }

        case 'Class': {
          this.doc.queue.push({
            type: 'class',
            name: `${prefix}${stmt.name}`,
            body: stmt.body.body,
            subtitle: stmt.extends ? `class extends ${stmt.extends}` : 'class',
            range: stmt,
            prefix: `${prefix}${stmt.name}.`,
          });
          break;
        }

        default: {
          break;
        }
      }
    }
  }

  // ------------------------------------------------------------ statements

  protected lowerBlock(block: Block, path: string): void {
    const sole = !block.inline && block.body.length === 1;
    this.withScope(() => {
      for (const [index, stmt] of block.body.entries()) {
        this.lowerStatement(stmt, `${path}/${index}`, block.inline, sole);
      }
    });
  }

  private lowerStatement(
    stmt: Stmt,
    path: string,
    inline: boolean,
    sole: boolean
  ): void {
    this.currentStatement = rangeOf(stmt);
    switch (stmt.type) {
      case 'Var': {
        this.lowerVar(stmt, path, inline, sole, false);
        return;
      }

      case 'Expr': {
        this.lowerExpressionStatement(stmt, stmt.expr, path, inline, sole);
        return;
      }

      case 'Assign': {
        this.lowerAssignment(stmt, path, inline, sole);
        return;
      }

      case 'If': {
        this.lowerIf(stmt, path, inline, sole);
        return;
      }

      case 'For': {
        this.lowerFor(stmt, path, inline, sole);
        return;
      }

      case 'While': {
        this.lowerWhile(stmt, path, inline, sole);
        return;
      }

      case 'Match': {
        this.lowerMatch(stmt, path, inline, sole);
        return;
      }

      case 'Return': {
        const valuePin = stmt.value
          ? this.dataIn('value', '', rangeOf(stmt.value), 'any', {
              optional: true,
            })
          : // `return`: a value can be wired in after the keyword.
            this.dataIn('value', '', undefined, 'any', {
              insertInitAt: rangeOf(stmt).start + 'return'.length,
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
          pins: valuePin ? [this.execIn(), valuePin] : [this.execIn()],
          path,
          meta: this.statementMeta(stmt, inline, sole),
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
          meta: this.statementMeta(stmt, inline, sole),
        });
        this.chain(node, null);
        return;
      }

      case 'Breakpoint': {
        const node = this.addNode({
          kind: 'call',
          title: 'Breakpoint',
          category: 'flow',
          purity: 'impure',
          range: rangeOf(stmt),
          pins: [
            this.execIn(),
            this.execOut('then', '', this.statementInsert(stmt, inline)),
          ],
          path,
          meta: this.statementMeta(stmt, inline, sole),
        });
        this.chain(node);
        return;
      }

      case 'Pass':
      case 'Signal':
      case 'Enum':
      case 'Extends':
      case 'ClassName':
      case 'Annotation': {
        return;
      }

      case 'Func': {
        // Not valid inside functions; show it as its own graph anyway.
        this.queueFunction(stmt.name ?? 'anonymous', 'func', stmt);
        return;
      }

      case 'Class': {
        this.doc.queue.push({
          type: 'class',
          name: stmt.name,
          body: stmt.body.body,
          subtitle: 'class',
          range: stmt,
          prefix: `${stmt.name}.`,
        });
        return;
      }

      case 'Error': {
        this.lowerUnknown(stmt, path, inline, sole, 'Error');
        return;
      }
    }
  }

  private lowerUnknown(
    stmt: Span,
    path: string,
    inline: boolean,
    sole: boolean,
    subtitle: string,
    value?: ValueSource,
    valueRange?: SourceRange
  ): void {
    const pins: Pin[] = [
      this.execIn(),
      this.execOut('then', '', this.statementInsert(stmt, inline)),
    ];
    const valuePin = value ? this.dataIn('value', '', valueRange) : undefined;
    if (valuePin) {
      pins.push(valuePin);
    }

    const node = this.addNode({
      kind: 'unknown',
      title: value ? 'Evaluate' : truncate(this.src(rangeOf(stmt)), 32),
      subtitle: value ? undefined : subtitle,
      category: 'unknown',
      purity: 'impure',
      range: rangeOf(stmt),
      pins,
      path,
      meta: this.statementMeta(stmt, inline, sole),
    });
    if (valuePin) {
      this.feed(node.id, valuePin, value);
    }

    this.chain(node);
  }

  private lowerVar(
    stmt: VarDecl,
    path: string,
    inline: boolean,
    sole: boolean,
    member: boolean
  ): void {
    if (stmt.value && unwrap(stmt.value).type === 'Lambda' && !member) {
      // `var f := func(): ...` defines a function graph.
      const lambda = unwrap(stmt.value) as Extract<Expr, { type: 'Lambda' }>;
      this.queueFunction(stmt.name, 'lambda', lambda.fn);
    }

    const declared = dataTypeOf(stmt.typeRef);
    const value = stmt.value
      ? this.lowerExpr(
          stmt.value,
          `${path}.value`,
          member ? 'lazy' : 'eager',
          stmt.name
        )
      : undefined;
    const type = declared === 'any' ? (value?.type ?? 'any') : declared;
    const valuePin = this.dataIn(
      'value',
      '',
      stmt.value ? rangeOf(stmt.value) : undefined,
      declared,
      stmt.value
        ? undefined
        : { insertInitAt: stmt.typeRef?.end ?? stmt.nameSpan.end }
    );
    const annotations = stmt.annotations.map((a) => `@${a.name}`).join(' ');
    const subtitle = [
      annotations,
      stmt.isStatic ? 'static' : '',
      stmt.kind,
      stmt.typeRef ? `: ${stmt.typeRef.name}` : '',
    ]
      .filter(Boolean)
      .join(' ')
      .replace(' :', ':');
    const node = this.addNode({
      kind: 'setVar',
      title: `Set ${stmt.name}`,
      subtitle,
      category: 'function',
      purity: 'impure',
      range: rangeOf(stmt),
      pins: [
        this.execIn(),
        this.execOut(
          'then',
          '',
          member ? undefined : this.statementInsert(stmt, inline)
        ),
        valuePin,
        this.dataOut(
          'out',
          '',
          type,
          { sourceText: stmt.name },
          rangeOf(stmt.nameSpan)
        ),
      ],
      path,
      meta: this.statementMeta(stmt, inline, sole),
    });
    this.feed(node.id, valuePin, value);
    if (valuePin.type === 'any') {
      valuePin.type = type;
    }

    this.chain(node);
    if (!member) {
      this.declare(stmt.name, { type });
    }
  }

  private lowerExpressionStatement(
    stmt: Span,
    rawExpr: Expr,
    path: string,
    inline: boolean,
    sole: boolean
  ): void {
    const expr = unwrap(rawExpr);
    const statementMeta = this.statementMeta(stmt, inline, sole);
    const insert = this.statementInsert(stmt, inline);

    if (expr.type === 'Call') {
      this.lowerCall(expr, path, 'statement', { statementMeta, insert, stmt });
      return;
    }

    if (expr.type === 'Await') {
      const value = this.lowerExpr(expr.argument, `${path}.value`, 'eager');
      const pin = this.dataIn('signal', 'Signal', rangeOf(expr.argument));
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
          this.dataOut('result', 'Result', 'any', {
            bind: {
              expr: rangeOf(expr),
              stmt: rangeOf(stmt),
              isStatement: true,
              nameHint: 'result',
            },
          }),
        ],
        path,
        meta: statementMeta,
      });
      this.feed(node.id, pin, value);
      this.chain(node);
      return;
    }

    const before = this.nodes.length;
    const value = this.lowerExpr(expr, `${path}.value`, 'lazy');
    if (
      markUnusedValue(
        this.nodes,
        before,
        value,
        this.statementMeta(rangeOf(stmt), inline, sole)
      )
    ) {
      return;
    }

    this.lowerUnknown(
      stmt,
      path,
      inline,
      sole,
      'Expression',
      value,
      rangeOf(expr)
    );
  }

  private lowerAssignment(
    stmt: Extract<Stmt, { type: 'Assign' }>,
    path: string,
    inline: boolean,
    sole: boolean
  ): void {
    const target = unwrap(stmt.target);
    const pins: Pin[] = [
      this.execIn(),
      this.execOut('then', '', this.statementInsert(stmt, inline)),
    ];
    const inputs: InputSpec[] = [];
    let title: string;
    let varName: string | undefined;

    const chain = simpleChain(target, this.text);
    const rootWired =
      chain?.[0] !== undefined && this.lookup(chain[0])?.source !== undefined;
    if (chain && !(rootWired && chain.length > 1)) {
      varName = chain.join('.');
      title = `Set ${varName}`;
    } else if (target.type === 'Attribute') {
      title = `Set .${target.name}`;
      inputs.push({
        pin: this.dataIn('target', 'Target', rangeOf(target.object), 'object'),
        value: this.lowerExpr(target.object, `${path}.target`, 'eager'),
      });
    } else if (target.type === 'Subscript') {
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
          pin: this.dataIn('key', 'Key', rangeOf(target.index)),
          value: this.lowerExpr(target.index, `${path}.key`, 'eager'),
        }
      );
    } else {
      title = `Set ${truncate(this.src(rangeOf(target)), 24)}`;
    }

    inputs.push({
      pin: this.dataIn('value', '', rangeOf(stmt.value)),
      value: this.lowerExpr(stmt.value, `${path}.value`, 'eager', varName),
    });
    pins.push(...inputs.map((i) => i.pin));
    const scoped = varName ? this.lookup(varName) : undefined;
    pins.push(
      this.dataOut(
        'out',
        '',
        scoped?.type ?? 'any',
        varName ? { sourceText: varName } : {},
        rangeOf(target)
      )
    );

    const node = this.addNode({
      kind: 'setVar',
      title,
      subtitle: stmt.op === '=' ? undefined : stmt.op,
      category: 'function',
      purity: 'impure',
      range: rangeOf(stmt),
      pins,
      path,
      meta: this.statementMeta(stmt, inline, sole),
    });
    this.feedAll(node.id, inputs);
    this.chain(node);
  }
}
