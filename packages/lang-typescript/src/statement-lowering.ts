import type * as t from '@babel/types';
import type { Pin, SourceRange } from '@vizscript/core';
import type { InsertPoint } from '@vizscript/core';
import { markUnusedValue, truncate } from '@vizscript/core';
import { patternAnnotation, typeFromAnnotation } from './annotations';
import { ControlFlowLowering } from './control-flow-lowering';
import type { InputSpec, ValueSource } from './lower-utils';
import {
  bindingNames,
  exportName,
  patternName,
  rangeOf,
  simpleChain,
  unwrap,
} from './lower-utils';

/** Lowers statements, declarations and exports into exec nodes. */
export abstract class StatementLowering extends ControlFlowLowering {
  protected override lowerStatements(
    stmts: ReadonlyArray<t.Statement>,
    path: string,
    inSwitchCase: boolean
  ): void {
    this.withScope(() => {
      for (const [index, stmt] of stmts.entries()) {
        if (
          inSwitchCase &&
          stmt.type === 'BreakStatement' &&
          !stmt.label &&
          index === stmts.length - 1
        ) {
          continue;
        }

        this.lowerStatement(stmt, `${path}/${index}`, false);
      }
    });
  }

  /** Lowers the body of a control structure (block or single statement). */
  protected override lowerBody(body: t.Statement, path: string): void {
    if (body.type === 'BlockStatement') {
      this.lowerStatements(body.body, path, false);
    } else {
      this.withScope(() => this.lowerStatement(body, `${path}/0`, true));
    }
  }

  protected lowerStatement(
    stmt: t.Statement,
    path: string,
    inline: boolean
  ): void {
    this.currentStatement = rangeOf(stmt);
    switch (stmt.type) {
      case 'ExpressionStatement': {
        this.lowerExpressionStatement(stmt, path, inline);
        return;
      }

      case 'VariableDeclaration': {
        this.lowerVariableDeclaration(stmt, path, inline);
        return;
      }

      case 'ReturnStatement':
      case 'ThrowStatement': {
        const isReturn = stmt.type === 'ReturnStatement';
        const argument = stmt.argument;
        const value = argument
          ? this.lowerExpr(argument, `${path}.value`, 'eager')
          : undefined;
        const pins: Pin[] = [this.execIn()];
        const valuePin = argument
          ? this.dataIn(
              isReturn ? 'value' : 'error',
              isReturn ? '' : 'Error',
              rangeOf(argument),
              'any',
              isReturn ? { optional: true } : undefined
            )
          : isReturn && typeof stmt.start === 'number'
            ? // `return;`: a value can be wired in after the keyword.
              this.dataIn('value', '', undefined, 'any', {
                insertInitAt: stmt.start + 'return'.length,
                insertPrefix: ' ',
              })
            : undefined;
        if (valuePin) {
          pins.push(valuePin);
        }

        const node = this.addNode({
          kind: isReturn ? 'return' : 'throw',
          title: isReturn ? 'Return' : 'Throw',
          category: isReturn ? 'return' : 'flow',
          purity: 'impure',
          range: rangeOf(stmt),
          pins,
          path,
          meta: this.statementMeta(stmt, inline),
        });
        if (valuePin) {
          this.feed(node.id, valuePin, value);
        }

        this.chain(node, null);
        return;
      }

      case 'IfStatement': {
        this.lowerIf(stmt, path, inline);
        return;
      }

      case 'BlockStatement': {
        this.lowerStatements(stmt.body, `${path}/block`, false);
        return;
      }

      case 'ForStatement':
      case 'WhileStatement':
      case 'DoWhileStatement': {
        this.lowerLoop(stmt, path, inline);
        return;
      }

      case 'ForOfStatement':
      case 'ForInStatement': {
        this.lowerForEach(stmt, path, inline);
        return;
      }

      case 'SwitchStatement': {
        this.lowerSwitch(stmt, path, inline);
        return;
      }

      case 'TryStatement': {
        this.lowerTry(stmt, path, inline);
        return;
      }

      case 'BreakStatement':
      case 'ContinueStatement': {
        const isBreak = stmt.type === 'BreakStatement';
        const node = this.addNode({
          kind: isBreak ? 'break' : 'continue',
          title: isBreak ? 'Break' : 'Continue',
          subtitle: stmt.label?.name,
          category: 'flow',
          purity: 'impure',
          range: rangeOf(stmt),
          pins: [this.execIn()],
          path,
          meta: this.statementMeta(stmt, inline),
        });
        this.chain(node, null);
        return;
      }

      case 'LabeledStatement': {
        this.lowerStatement(stmt.body, path, inline);
        return;
      }

      case 'FunctionDeclaration': {
        this.queueFunction(
          stmt.id?.name ?? 'anonymous',
          this.exportKeyword ? `${this.exportKeyword} function` : 'function',
          stmt
        );
        return;
      }

      case 'ClassDeclaration': {
        this.queueClass(stmt, stmt.id?.name ?? 'AnonymousClass');
        return;
      }

      case 'ExportNamedDeclaration':
      case 'ExportDefaultDeclaration':
      case 'ExportAllDeclaration':
      case 'TSExportAssignment': {
        this.lowerExport(stmt, path, inline);
        return;
      }

      case 'ImportDeclaration':
      case 'EmptyStatement':
      case 'DebuggerStatement':
      case 'TSTypeAliasDeclaration':
      case 'TSInterfaceDeclaration':
      case 'TSModuleDeclaration':
      case 'TSEnumDeclaration':
      case 'TSDeclareFunction':
      case 'TSImportEqualsDeclaration':
      case 'TSNamespaceExportDeclaration': {
        return;
      }

      default: {
        this.lowerUnknownStatement(stmt, path, inline);
      }
    }
  }

  /**
   * Exports are the module's outputs, like the result pins of a Blueprint
   * function: `export default x` and `export { a, b }` become Export nodes,
   * exported declarations keep their own nodes and are labelled `export`.
   */
  protected lowerExport(
    stmt:
      | t.ExportNamedDeclaration
      | t.ExportDefaultDeclaration
      | t.ExportAllDeclaration
      | t.TSExportAssignment,
    path: string,
    inline: boolean
  ): void {
    if (stmt.type === 'ExportAllDeclaration') {
      if (stmt.exportKind !== 'type') {
        this.exportNode(
          stmt,
          path,
          inline,
          'Export * from',
          stmt.source.value,
          []
        );
      }

      return;
    }

    if (stmt.type === 'TSExportAssignment') {
      this.exportNode(stmt, path, inline, 'Export =', undefined, [
        {
          pin: this.dataIn('value', '', rangeOf(stmt.expression)),
          value: this.lowerExpr(stmt.expression, `${path}.value`, 'eager'),
        },
      ]);
      return;
    }

    if (stmt.type === 'ExportDefaultDeclaration') {
      const decl = stmt.declaration;
      if (decl.type === 'FunctionDeclaration' && decl.id) {
        this.queueFunction(decl.id.name, 'export default function', decl);
        return;
      }

      if (decl.type === 'ClassDeclaration' && decl.id) {
        this.queueClass(decl, decl.id.name);
        return;
      }

      if (
        decl.type === 'TSInterfaceDeclaration' ||
        decl.type === 'TSDeclareFunction'
      ) {
        return;
      }

      // Expressions (also anonymous functions/classes) feed the export.
      const expr =
        decl.type === 'FunctionDeclaration'
          ? ({ ...decl, type: 'FunctionExpression' } as t.FunctionExpression)
          : decl.type === 'ClassDeclaration'
            ? ({ ...decl, type: 'ClassExpression' } as t.ClassExpression)
            : decl;
      this.exportNode(stmt, path, inline, 'Export default', undefined, [
        {
          pin: this.dataIn('value', 'default', rangeOf(decl)),
          value: this.lowerExpr(expr, `${path}.value`, 'eager', 'default'),
        },
      ]);
      return;
    }

    if (stmt.declaration) {
      this.exportKeyword = 'export';
      try {
        this.lowerStatement(stmt.declaration, path, inline);
      } finally {
        this.exportKeyword = null;
      }

      return;
    }

    if (stmt.exportKind === 'type') {
      return;
    }

    const specifiers = stmt.specifiers.filter(
      (s) => !(s.type === 'ExportSpecifier' && s.exportKind === 'type')
    );
    if (specifiers.length === 0) {
      return;
    }

    if (stmt.source) {
      // `export { a } from './x'` re-exports without local values.
      const names = specifiers.map((s) => exportName(s.exported)).join(', ');
      this.exportNode(
        stmt,
        path,
        inline,
        'Re-export',
        truncate(`${names} from ${stmt.source.value}`, 36),
        []
      );
      return;
    }

    const inputs: InputSpec[] = [];
    for (const [i, spec] of specifiers.entries()) {
      if (spec.type !== 'ExportSpecifier') {
        continue;
      }

      inputs.push({
        pin: this.dataIn(
          `e${i}`,
          exportName(spec.exported),
          rangeOf(spec.local)
        ),
        value: this.lowerExpr(spec.local, `${path}.e${i}`, 'eager'),
      });
    }

    this.exportNode(stmt, path, inline, 'Export', undefined, inputs);
  }

  protected exportNode(
    stmt: t.Node,
    path: string,
    inline: boolean,
    title: string,
    subtitle: string | undefined,
    inputs: InputSpec[]
  ): void {
    const node = this.addNode({
      kind: 'export',
      title,
      subtitle,
      category: 'return',
      purity: 'impure',
      range: rangeOf(stmt),
      pins: [
        this.execIn(),
        this.execOut('then', '', this.statementInsert(stmt, inline)),
        ...inputs.map((i) => i.pin),
      ],
      path,
      meta: this.statementMeta(stmt, inline),
    });
    this.feedAll(node.id, inputs);
    this.chain(node);
  }

  protected lowerUnknownStatement(
    stmt: t.Node,
    path: string,
    inline: boolean,
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
      title: value ? 'Evaluate' : truncate(this.source(rangeOf(stmt)), 32),
      subtitle: value ? undefined : stmt.type,
      category: 'unknown',
      purity: 'impure',
      range: rangeOf(stmt),
      pins,
      path,
      meta: this.statementMeta(stmt, inline),
    });
    if (valuePin) {
      this.feed(node.id, valuePin, value);
    }

    this.chain(node);
  }

  protected lowerExpressionStatement(
    stmt: t.ExpressionStatement,
    path: string,
    inline: boolean
  ): void {
    const expr = unwrap(stmt.expression);
    const statementMeta = this.statementMeta(stmt, inline);
    const insert = this.statementInsert(stmt, inline);

    switch (expr.type) {
      case 'CallExpression':
      case 'OptionalCallExpression':
      case 'NewExpression': {
        this.lowerCall(expr, path, 'statement', {
          statementMeta,
          insert,
          stmt,
        });
        return;
      }

      case 'AwaitExpression': {
        const value = this.lowerExpr(expr.argument, `${path}.value`, 'eager');
        const pin = this.dataIn('promise', 'Promise', rangeOf(expr.argument));
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
                  expr: rangeOf(expr),
                  stmt: rangeOf(stmt),
                  isStatement: true,
                  nameHint: 'result',
                },
              },
              rangeOf(expr)
            ),
          ],
          path,
          meta: statementMeta,
        });
        this.feed(node.id, pin, value);
        this.chain(node);
        return;
      }

      case 'AssignmentExpression': {
        this.lowerAssignment(expr, stmt, path, statementMeta, insert);
        return;
      }

      case 'UpdateExpression': {
        const target = expr.argument;
        const chain = simpleChain(target);
        const name =
          chain?.join('.') ?? truncate(this.source(rangeOf(target)), 24);
        const node = this.addNode({
          kind: 'setVar',
          title: expr.prefix
            ? `${expr.operator}${name}`
            : `${name}${expr.operator}`,
          category: 'function',
          purity: 'impure',
          range: rangeOf(stmt),
          pins: [this.execIn(), this.execOut('then', '', insert)],
          path,
          meta: statementMeta,
        });
        this.chain(node);
        return;
      }

      default: {
        const before = this.nodes.length;
        const value = this.lowerExpr(expr, `${path}.value`, 'lazy');
        if (!markUnusedValue(this.nodes, before, value, statementMeta)) {
          this.lowerUnknownStatement(stmt, path, inline, value, rangeOf(expr));
        }
      }
    }
  }

  protected lowerAssignment(
    expr: t.AssignmentExpression,
    stmt: t.Node,
    path: string,
    statementMeta: Record<string, unknown>,
    insert: InsertPoint | undefined
  ): void {
    const left = expr.left;
    const pins: Pin[] = [this.execIn(), this.execOut('then', '', insert)];
    const inputs: InputSpec[] = [];
    let title: string;
    let varName: string | undefined;

    const chain = simpleChain(left);
    const rootWired =
      chain?.[0] !== undefined && this.lookup(chain[0])?.source !== undefined;

    if (chain && !(rootWired && chain.length > 1)) {
      varName = chain.join('.');
      title = `Set ${varName}`;
    } else if (
      left.type === 'MemberExpression' ||
      left.type === 'OptionalMemberExpression'
    ) {
      const property = left.computed
        ? `[${truncate(this.source(rangeOf(left.property)), 16)}]`
        : this.source(rangeOf(left.property));
      title = `Set .${property}`;
      inputs.push({
        pin: this.dataIn('target', 'Target', rangeOf(left.object), 'object'),
        value: this.lowerExpr(left.object, `${path}.target`, 'eager'),
      });
    } else {
      title = `Set ${truncate(this.source(rangeOf(left)), 24)}`;
    }

    inputs.push({
      pin: this.dataIn('value', '', rangeOf(expr.right)),
      value: this.lowerExpr(expr.right, `${path}.value`, 'eager', varName),
    });
    pins.push(...inputs.map((i) => i.pin));
    const scoped = varName ? this.lookup(varName) : undefined;
    pins.push(
      this.dataOut(
        'out',
        '',
        scoped?.type ?? 'any',
        varName ? { sourceText: varName } : {},
        rangeOf(left)
      )
    );

    const node = this.addNode({
      kind: 'setVar',
      title,
      subtitle: expr.operator === '=' ? undefined : expr.operator,
      category: 'function',
      purity: 'impure',
      range: rangeOf(stmt),
      pins,
      path,
      meta: statementMeta,
    });
    this.feedAll(node.id, inputs);
    this.chain(node);
  }

  protected lowerVariableDeclaration(
    stmt: t.VariableDeclaration,
    path: string,
    inline: boolean
  ): void {
    const statementMeta = this.statementMeta(stmt, inline);
    const last = stmt.declarations.length - 1;
    for (const [index, decl] of stmt.declarations.entries()) {
      const name = patternName(decl.id, this.text);
      const declaredType = typeFromAnnotation(patternAnnotation(decl.id));
      const init = decl.init ? unwrap(decl.init) : undefined;

      if (
        init &&
        decl.id.type === 'Identifier' &&
        (init.type === 'ArrowFunctionExpression' ||
          init.type === 'FunctionExpression')
      ) {
        // `const fn = () => {}` defines a function graph, like a declaration.
        this.queueFunction(
          name,
          this.exportKeyword ? `${this.exportKeyword} function` : 'function',
          init
        );
        continue;
      }

      if (
        init &&
        decl.id.type === 'Identifier' &&
        init.type === 'ClassExpression'
      ) {
        this.queueClass(init, name);
        continue;
      }

      const value = decl.init
        ? this.lowerExpr(decl.init, `${path}.${index}`, 'eager', name)
        : undefined;
      const type =
        declaredType === 'any' ? (value?.type ?? 'any') : declaredType;

      const valuePin = this.dataIn(
        'value',
        '',
        decl.init ? rangeOf(decl.init) : undefined,
        declaredType,
        decl.init ? undefined : { insertInitAt: decl.id.end ?? 0 }
      );

      const node = this.addNode({
        kind: 'setVar',
        title: `Set ${name}`,
        subtitle: this.exportKeyword
          ? `${this.exportKeyword} ${stmt.kind}`
          : stmt.kind,
        category: 'function',
        purity: 'impure',
        range: stmt.declarations.length === 1 ? rangeOf(stmt) : rangeOf(decl),
        pins: [
          this.execIn(),
          this.execOut(
            'then',
            '',
            index === last ? this.statementInsert(stmt, inline) : undefined
          ),
          valuePin,
          this.dataOut(
            'out',
            '',
            type,
            decl.id.type === 'Identifier' ? { sourceText: name } : {},
            // The variable: a type checker tells its type.
            decl.id.type === 'Identifier' ? rangeOf(decl.id) : undefined
          ),
        ],
        path: `${path}.${index}`,
        // Names this declaration binds (also from destructuring patterns).
        meta: { ...statementMeta, declares: bindingNames(decl.id) },
      });
      this.feed(node.id, valuePin, value);
      if (valuePin.type === 'any') {
        valuePin.type = type;
      }

      this.chain(node);

      if (decl.id.type === 'Identifier') {
        this.declare(decl.id.name, { type });
      }
    }
  }
}
