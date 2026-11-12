import type * as t from '@babel/types';
import type { Pin } from '@vizscript/core';
import { arrayElementType, lineIndent, truncate } from '@vizscript/core';
import { ExpressionLowering } from './expression-lowering';
import type { InputSpec } from './lower-utils';
import { patternName, rangeOf } from './lower-utils';

/** Lowers branches, loops, `switch` and `try` into flow nodes. */
export abstract class ControlFlowLowering extends ExpressionLowering {
  protected abstract lowerStatements(
    stmts: ReadonlyArray<t.Statement>,
    path: string,
    inSwitchCase: boolean
  ): void;

  protected abstract lowerBody(body: t.Statement, path: string): void;

  protected lowerIf(stmt: t.IfStatement, path: string, inline: boolean): void {
    const condition = this.lowerExpr(stmt.test, `${path}.test`, 'eager');
    const condPin = this.dataIn(
      'condition',
      'Condition',
      rangeOf(stmt.test),
      'bool'
    );
    const node = this.addNode({
      kind: 'branch',
      title: 'Branch',
      category: 'flow',
      purity: 'impure',
      range: rangeOf(stmt),
      pins: [
        this.execIn(),
        condPin,
        this.execOut('true', 'True', this.blockInsert(stmt.consequent)),
        this.execOut(
          'false',
          'False',
          stmt.alternate ? this.blockInsert(stmt.alternate) : undefined
        ),
        this.execOut(
          'completed',
          'Completed',
          this.statementInsert(stmt, inline),
          true
        ),
      ],
      path,
      meta: this.statementMeta(stmt, inline),
    });
    this.feed(node.id, condPin, condition);
    this.chain(node, 'true');
    this.lowerBody(stmt.consequent, `${path}/then`);

    if (stmt.alternate) {
      this.cursor = { node: node.id, pin: 'false' };
      this.lowerBody(stmt.alternate, `${path}/else`);
    }

    this.cursor = { node: node.id, pin: 'completed' };
  }

  protected lowerLoop(
    stmt: t.ForStatement | t.WhileStatement | t.DoWhileStatement,
    path: string,
    inline: boolean
  ): void {
    const title =
      stmt.type === 'ForStatement'
        ? 'For Loop'
        : stmt.type === 'WhileStatement'
          ? 'While Loop'
          : 'Do While';
    let subtitle: string | undefined;
    if (stmt.type === 'ForStatement') {
      const header = [stmt.init, stmt.test, stmt.update]
        .map((part) => (part ? this.source(rangeOf(part)) : ''))
        .join('; ');
      subtitle = truncate(header, 36);
    }

    this.withScope(() => {
      if (
        stmt.type === 'ForStatement' &&
        stmt.init?.type === 'VariableDeclaration'
      ) {
        for (const decl of stmt.init.declarations) {
          if (decl.id.type === 'Identifier') {
            this.declare(decl.id.name, { type: 'number' });
          }
        }
      }

      const pins: Pin[] = [this.execIn()];
      const inputs: InputSpec[] = [];
      if (stmt.test) {
        inputs.push({
          pin: this.dataIn(
            'condition',
            'Condition',
            rangeOf(stmt.test),
            'bool'
          ),
          value: this.lowerExpr(stmt.test, `${path}.test`, 'lazy'),
        });
        pins.push(...inputs.map((i) => i.pin));
      }

      pins.push(
        this.execOut('body', 'Loop Body', this.blockInsert(stmt.body)),
        this.execOut(
          'completed',
          'Completed',
          this.statementInsert(stmt, inline),
          true
        )
      );

      const node = this.addNode({
        kind: 'loop',
        title,
        subtitle,
        category: 'flow',
        purity: 'impure',
        range: rangeOf(stmt),
        pins,
        path,
        meta: this.statementMeta(stmt, inline),
      });
      this.feedAll(node.id, inputs);
      this.chain(node, 'body');
      this.lowerBody(stmt.body, `${path}/body`);
      this.cursor = { node: node.id, pin: 'completed' };
    });
  }

  protected lowerForEach(
    stmt: t.ForOfStatement | t.ForInStatement,
    path: string,
    inline: boolean
  ): void {
    const isOf = stmt.type === 'ForOfStatement';
    const left = stmt.left;
    const pattern =
      left.type === 'VariableDeclaration' ? left.declarations[0]?.id : left;
    const elementName = pattern ? patternName(pattern, this.text) : 'element';
    const isAwait = stmt.type === 'ForOfStatement' && stmt.await;
    const iterable = this.lowerExpr(stmt.right, `${path}.right`, 'eager');
    const arrayPin = this.dataIn(
      'array',
      isOf ? 'Array' : 'Object',
      rangeOf(stmt.right),
      isOf ? 'array' : 'object'
    );
    // `for (const x of names)` with `names: string[]` gives a typed element.
    const elementType = isOf ? arrayElementType(iterable.type) : 'string';
    const node = this.addNode({
      kind: 'forEach',
      title: isOf ? 'For Each' : 'For Each Key',
      subtitle: isAwait ? 'await' : undefined,
      category: 'flow',
      purity: 'impure',
      range: rangeOf(stmt),
      pins: [
        this.execIn(),
        arrayPin,
        this.execOut('body', 'Loop Body', this.blockInsert(stmt.body)),
        this.dataOut('element', elementName, elementType, {
          sourceText: elementName,
        }),
        this.execOut(
          'completed',
          'Completed',
          this.statementInsert(stmt, inline),
          true
        ),
      ],
      path,
      meta: this.statementMeta(stmt, inline),
    });
    this.feed(node.id, arrayPin, iterable);
    this.chain(node, 'body');
    this.withScope(() => {
      if (pattern?.type === 'Identifier') {
        this.declare(pattern.name, {
          source: { node: node.id, pin: 'element' },
          type: elementType,
        });
      }

      this.lowerBody(stmt.body, `${path}/body`);
    });
    this.cursor = { node: node.id, pin: 'completed' };
  }

  protected lowerSwitch(
    stmt: t.SwitchStatement,
    path: string,
    inline: boolean
  ): void {
    const valuePin = this.dataIn(
      'value',
      'Selection',
      rangeOf(stmt.discriminant)
    );
    const value = this.lowerExpr(stmt.discriminant, `${path}.value`, 'eager');
    const pins: Pin[] = [this.execIn(), valuePin];
    for (const [index, kase] of stmt.cases.entries()) {
      const name = kase.test
        ? truncate(this.source(rangeOf(kase.test)), 20)
        : 'Default';
      const colon = this.text.indexOf(
        ':',
        kase.test?.end ?? (kase.start ?? 0) + 'default'.length
      );
      const first = kase.consequent[0];
      const indent = first
        ? lineIndent(this.text, first.start ?? 0)
        : `${lineIndent(this.text, kase.start ?? 0)}  `;
      pins.push(
        this.execOut(
          `case${index}`,
          name,
          colon > 0 ? { at: colon + 1, indent, mode: 'after' } : undefined
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
      title: 'Switch',
      category: 'flow',
      purity: 'impure',
      range: rangeOf(stmt),
      pins,
      path,
      meta: this.statementMeta(stmt, inline),
    });
    this.feed(node.id, valuePin, value);
    this.chain(node, null);
    for (const [index, kase] of stmt.cases.entries()) {
      this.cursor = { node: node.id, pin: `case${index}` };
      this.lowerStatements(kase.consequent, `${path}/case${index}`, true);
    }

    this.cursor = { node: node.id, pin: 'completed' };
  }

  protected lowerTry(
    stmt: t.TryStatement,
    path: string,
    inline: boolean
  ): void {
    const pins: Pin[] = [
      this.execIn(),
      this.execOut('try', 'Try', this.blockInsert(stmt.block)),
    ];
    const handler = stmt.handler;
    const param = handler?.param;
    const errorName = param ? patternName(param, this.text) : 'error';
    if (handler) {
      pins.push(
        this.execOut('catch', 'Catch', this.blockInsert(handler.body)),
        this.dataOut('error', errorName, 'any', { sourceText: errorName })
      );
    }

    const finalizer = stmt.finalizer;
    if (finalizer) {
      pins.push(
        this.execOut('finally', 'Finally', this.blockInsert(finalizer))
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
      kind: 'try',
      title: 'Try',
      category: 'flow',
      purity: 'impure',
      range: rangeOf(stmt),
      pins,
      path,
      meta: this.statementMeta(stmt, inline),
    });
    this.chain(node, 'try');
    this.lowerStatements(stmt.block.body, `${path}/try`, false);

    if (handler) {
      this.cursor = { node: node.id, pin: 'catch' };
      this.withScope(() => {
        if (param?.type === 'Identifier') {
          this.declare(param.name, {
            source: { node: node.id, pin: 'error' },
            type: 'any',
          });
        }

        this.lowerStatements(handler.body.body, `${path}/catch`, false);
      });
    }

    if (finalizer) {
      this.cursor = { node: node.id, pin: 'finally' };
      this.lowerStatements(finalizer.body, `${path}/finally`, false);
    }

    this.cursor = { node: node.id, pin: 'completed' };
  }
}
