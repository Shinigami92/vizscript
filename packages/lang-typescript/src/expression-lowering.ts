import type * as t from '@babel/types';
import { conversionCall } from '@vizscript/core';
import type { DataType, Pin } from '@vizscript/core';
import type { InsertPoint, OutputPinMeta } from '@vizscript/core';
import { arrayElementType, arrayOfAll, truncate } from '@vizscript/core';
import { CONVERSIONS } from './conversions';
import { GraphBuilder } from './graph-builder';
import type { EvalMode, InputSpec, ValueSource } from './lower-utils';
import {
  COMPARISON_OPERATORS,
  rangeOf,
  simpleChain,
  unwrap,
} from './lower-utils';

/** Lowers expressions into pure nodes, hoisted calls and literals. */
export abstract class ExpressionLowering extends GraphBuilder {
  protected lowerCall(
    expr: t.CallExpression | t.OptionalCallExpression | t.NewExpression,
    path: string,
    mode: 'statement' | 'hoist' | 'pure',
    statement?: {
      statementMeta: Record<string, unknown>;
      insert: InsertPoint | undefined;
      stmt: t.Node;
    }
  ): ValueSource {
    const evalMode: EvalMode = mode === 'pure' ? 'lazy' : 'eager';
    const callee = expr.callee;
    const isNew = expr.type === 'NewExpression';
    const inputs: InputSpec[] = [];

    let title: string;
    let knownName: string | undefined;

    const chain =
      callee.type === 'V8IntrinsicIdentifier' ? undefined : simpleChain(callee);
    const rootWired =
      chain?.[0] !== undefined && this.lookup(chain[0])?.source !== undefined;

    if (chain && !(rootWired && chain.length > 1)) {
      title = chain.join('.');
      knownName = chain.length === 1 ? chain[0] : undefined;
    } else if (
      callee.type === 'MemberExpression' ||
      callee.type === 'OptionalMemberExpression'
    ) {
      title = callee.computed
        ? `[${truncate(this.source(rangeOf(callee.property)), 16)}]`
        : this.source(rangeOf(callee.property));
      inputs.push({
        pin: this.dataIn('target', 'Target', rangeOf(callee.object), 'object'),
        value: this.lowerExpr(callee.object, `${path}.target`, evalMode),
      });
    } else {
      title = 'Call';
      inputs.push({
        pin: this.dataIn('function', 'Function', rangeOf(callee), 'function'),
        value:
          callee.type === 'V8IntrinsicIdentifier' || callee.type === 'Super'
            ? undefined
            : this.lowerExpr(callee, `${path}.callee`, evalMode),
      });
    }

    if (isNew) {
      title = `new ${title}`;
    } else if (expr.type === 'OptionalCallExpression' && expr.optional) {
      title = `${title}?.()`;
    }

    const paramNames = knownName
      ? this.doc.functionParams.get(knownName)
      : undefined;
    for (const [index, arg] of expr.arguments.entries()) {
      if (arg.type === 'SpreadElement') {
        inputs.push({
          pin: this.dataIn(
            `arg${index}`,
            '...',
            rangeOf(arg.argument),
            'array'
          ),
          value: this.lowerExpr(arg.argument, `${path}.arg${index}`, evalMode),
        });
        continue;
      }

      if (arg.type === 'ArgumentPlaceholder') {
        continue;
      }

      inputs.push({
        pin: this.dataIn(
          `arg${index}`,
          paramNames?.[index] ?? '',
          rangeOf(arg)
        ),
        value: this.lowerExpr(
          arg,
          `${path}.arg${index}`,
          evalMode,
          `${title} callback`
        ),
      });
    }

    // `String(x)`: a pure compact node, like UE's autocast.
    const converts =
      isNew || mode === 'statement'
        ? undefined
        : conversionCall(CONVERSIONS, title, inputs.length);
    const returnType: DataType =
      converts ??
      (knownName ? this.doc.functionReturnTypes.get(knownName) : undefined) ??
      (isNew && chain ? (chain.at(-1) ?? 'object') : 'any');

    const impure = mode !== 'pure' && converts === undefined;
    const pins: Pin[] = impure
      ? [this.execIn(), this.execOut('then', '', statement?.insert)]
      : [];
    pins.push(...inputs.map((i) => i.pin));

    const outMeta: OutputPinMeta = impure
      ? {
          bind: {
            expr: rangeOf(expr),
            stmt: this.currentStatement ?? rangeOf(expr),
            isStatement: mode === 'statement',
            nameHint: chain?.at(-1) ?? 'value',
          },
        }
      : { sourceText: this.source(rangeOf(expr)) };
    if (returnType !== 'void') {
      pins.push(this.dataOut('return', '', returnType, outMeta, rangeOf(expr)));
    }

    const node = this.addNode({
      kind: 'call',
      title,
      category: impure ? 'function' : 'pure',
      purity: impure ? 'impure' : 'pure',
      ...(converts ? { compact: true } : {}),
      range:
        mode === 'statement' && statement
          ? rangeOf(statement.stmt)
          : rangeOf(expr),
      pins,
      path,
      meta: statement?.statementMeta,
    });
    this.feedAll(node.id, inputs);

    if (impure) {
      this.chain(node);
    }

    return { pin: { node: node.id, pin: 'return' }, type: returnType };
  }

  protected lowerExpr(
    rawExpr: t.Node,
    path: string,
    mode: EvalMode,
    nameHint?: string
  ): ValueSource {
    if (rawExpr.type === 'Super') {
      return this.getVar('super', rawExpr, path, 'object');
    }

    const expr = unwrap(rawExpr as t.Expression);
    const range = rangeOf(expr);
    const raw = this.source(range);

    switch (expr.type) {
      case 'StringLiteral': {
        return this.literal('string', expr.value, raw, 'string');
      }

      case 'NumericLiteral': {
        return this.literal('number', raw, raw, 'number');
      }

      case 'BigIntLiteral': {
        return this.literal('bigint', raw, raw, 'bigint');
      }

      case 'BooleanLiteral': {
        return this.literal('boolean', String(expr.value), raw, 'bool');
      }

      case 'NullLiteral': {
        return this.literal('null', 'null', raw, 'null');
      }

      case 'RegExpLiteral': {
        return this.literal('regexp', raw, raw, 'regexp');
      }

      case 'TemplateLiteral': {
        if (expr.expressions.length === 0) {
          const cooked = expr.quasis[0]?.value.cooked ?? '';
          return this.literal('template', cooked, raw, 'string');
        }

        const inputs: InputSpec[] = expr.expressions.map((e, i) => ({
          pin: this.dataIn(`part${i}`, `{${i}}`, rangeOf(e)),
          value: this.lowerExpr(e as t.Expression, `${path}.part${i}`, mode),
        }));
        let format = '';
        for (const [i, quasi] of expr.quasis.entries()) {
          format += quasi.value.raw;
          if (i < expr.expressions.length) {
            format += `{${i}}`;
          }
        }

        return this.pureNode({
          kind: 'template',
          title: 'Format Text',
          subtitle: truncate(format, 32),
          expr,
          path,
          inputs,
          outType: 'string',
          outName: 'Result',
        });
      }

      case 'UnaryExpression': {
        const argument = expr.argument;
        if (
          (expr.operator === '-' || expr.operator === '+') &&
          (argument.type === 'NumericLiteral' ||
            argument.type === 'BigIntLiteral')
        ) {
          const kind = argument.type === 'NumericLiteral' ? 'number' : 'bigint';
          return this.literal(kind, raw, raw, kind);
        }

        if (expr.operator === 'void' && argument.type === 'NumericLiteral') {
          return this.literal('undefined', 'undefined', raw, 'void');
        }

        const type: DataType =
          expr.operator === '!' || expr.operator === 'delete'
            ? 'bool'
            : expr.operator === 'typeof'
              ? 'string'
              : expr.operator === 'void'
                ? 'void'
                : 'number';
        return this.pureNode({
          kind: 'operator',
          title: expr.operator,
          expr,
          path,
          inputs: [
            {
              pin: this.dataIn('a', '', rangeOf(argument)),
              value: this.lowerExpr(argument, `${path}.a`, mode),
            },
          ],
          outType: type,
          compact: true,
        });
      }

      case 'BinaryExpression':
      case 'LogicalExpression': {
        const leftExpr = expr.left as t.Expression;
        const left = this.lowerExpr(leftExpr, `${path}.a`, mode);
        const right = this.lowerExpr(
          expr.right,
          `${path}.b`,
          expr.type === 'LogicalExpression' ? 'lazy' : mode
        );
        const op = expr.operator;
        let type: DataType;
        if (COMPARISON_OPERATORS.has(op)) {
          type = 'bool';
        } else if (expr.type === 'LogicalExpression') {
          type = left.type === right.type ? left.type : 'any';
        } else if (op === '+') {
          type =
            left.type === 'string' || right.type === 'string'
              ? 'string'
              : left.type === 'number' && right.type === 'number'
                ? 'number'
                : 'any';
        } else {
          type = left.type === 'bigint' ? 'bigint' : 'number';
        }

        return this.pureNode({
          kind: 'operator',
          title: op,
          expr,
          path,
          inputs: [
            { pin: this.dataIn('a', '', rangeOf(leftExpr)), value: left },
            { pin: this.dataIn('b', '', rangeOf(expr.right)), value: right },
          ],
          outType: type,
          compact: true,
        });
      }

      case 'ConditionalExpression': {
        const yes = this.lowerExpr(expr.consequent, `${path}.true`, 'lazy');
        const no = this.lowerExpr(expr.alternate, `${path}.false`, 'lazy');
        return this.pureNode({
          kind: 'select',
          title: 'Select',
          expr,
          path,
          inputs: [
            {
              pin: this.dataIn(
                'condition',
                'Condition',
                rangeOf(expr.test),
                'bool'
              ),
              value: this.lowerExpr(expr.test, `${path}.test`, mode),
            },
            {
              pin: this.dataIn('true', 'True', rangeOf(expr.consequent)),
              value: yes,
            },
            {
              pin: this.dataIn('false', 'False', rangeOf(expr.alternate)),
              value: no,
            },
          ],
          outType: yes.type === no.type ? yes.type : 'any',
        });
      }

      case 'Identifier': {
        // A placeholder (`x = undefined`) says nothing about the type.
        if (expr.name === 'undefined') {
          return this.literal('undefined', 'undefined', raw, 'any');
        }

        const entry = this.lookup(expr.name);
        if (entry?.source) {
          return { pin: entry.source, type: entry.type };
        }

        return this.getVar(expr.name, expr, path, entry?.type ?? 'any');
      }

      case 'ThisExpression': {
        return this.getVar('this', expr, path, 'object');
      }

      case 'MemberExpression':
      case 'OptionalMemberExpression': {
        const chain = simpleChain(expr);
        const root = chain?.[0];
        if (chain && root !== undefined && !this.lookup(root)?.source) {
          return this.getVar(chain.join('.'), expr, path, 'any');
        }

        const inputs: InputSpec[] = [
          {
            pin: this.dataIn('target', '', rangeOf(expr.object), 'object'),
            value: this.lowerExpr(expr.object, `${path}.target`, mode),
          },
        ];
        let title: string;
        if (expr.computed) {
          title = expr.type === 'OptionalMemberExpression' ? '?.[ ]' : '[ ]';
          inputs.push({
            pin: this.dataIn('key', '', rangeOf(expr.property)),
            value: this.lowerExpr(expr.property, `${path}.key`, mode),
          });
        } else {
          title = `${expr.type === 'OptionalMemberExpression' ? '?.' : '.'}${this.source(rangeOf(expr.property))}`;
        }

        return this.pureNode({
          kind: 'getProperty',
          title,
          expr,
          path,
          inputs,
          outType: 'any',
          compact: true,
        });
      }

      case 'CallExpression':
      case 'OptionalCallExpression':
      case 'NewExpression': {
        return this.lowerCall(expr, path, mode === 'eager' ? 'hoist' : 'pure');
      }

      case 'AwaitExpression': {
        const value = this.lowerExpr(expr.argument, `${path}.value`, mode);
        if (mode === 'lazy') {
          return this.pureNode({
            kind: 'await',
            title: 'await',
            expr,
            path,
            inputs: [
              {
                pin: this.dataIn('promise', '', rangeOf(expr.argument)),
                value,
              },
            ],
            outType: 'any',
            compact: true,
          });
        }

        const pin = this.dataIn('promise', 'Promise', rangeOf(expr.argument));
        const node = this.addNode({
          kind: 'await',
          title: 'Await',
          category: 'latent',
          purity: 'impure',
          range,
          pins: [
            this.execIn(),
            this.execOut('then', ''),
            pin,
            this.dataOut('result', 'Result', 'any', {
              bind: {
                expr: range,
                stmt: this.currentStatement ?? range,
                isStatement: false,
                nameHint: 'result',
              },
            }),
          ],
          path,
        });
        this.feed(node.id, pin, value);
        this.chain(node);
        return { pin: { node: node.id, pin: 'result' }, type: 'any' };
      }

      case 'ObjectExpression': {
        return this.lowerObject(expr, path, mode, nameHint);
      }

      case 'ArrayExpression': {
        const inputs: InputSpec[] = [];
        for (const [i, element] of expr.elements.entries()) {
          if (!element) {
            continue;
          }

          if (element.type === 'SpreadElement') {
            inputs.push({
              pin: this.dataIn(
                `e${i}`,
                '...',
                rangeOf(element.argument),
                'array'
              ),
              value: this.lowerExpr(element.argument, `${path}.e${i}`, mode),
            });
            continue;
          }

          inputs.push({
            pin: this.dataIn(`e${i}`, `[${i}]`, rangeOf(element)),
            value: this.lowerExpr(element, `${path}.e${i}`, mode),
          });
        }

        return this.pureNode({
          kind: 'makeArray',
          title: 'Make Array',
          expr,
          path,
          inputs,
          outType: arrayOfAll(
            inputs.map((i) =>
              i.pin.name === '...'
                ? arrayElementType(i.value?.type ?? 'any')
                : (i.value?.type ?? 'any')
            )
          ),
          outName: 'Array',
        });
      }

      case 'ArrowFunctionExpression':
      case 'FunctionExpression': {
        const name =
          (expr.type === 'FunctionExpression' ? expr.id?.name : undefined) ??
          nameHint ??
          'anonymous';
        this.queueFunction(
          name,
          expr.type === 'ArrowFunctionExpression'
            ? 'arrow function'
            : 'function',
          expr
        );
        return this.pureNode({
          kind: 'functionRef',
          title: `ƒ ${name}`,
          expr,
          path,
          inputs: [],
          outType: 'function',
          compact: true,
        });
      }

      default: {
        return this.pureNode({
          kind: 'unknown',
          title: truncate(raw, 32),
          subtitle: expr.type,
          expr,
          path,
          inputs: [],
          outType: 'any',
          category: 'unknown',
        });
      }
    }
  }

  protected lowerObject(
    expr: t.ObjectExpression,
    path: string,
    mode: EvalMode,
    nameHint: string | undefined
  ): ValueSource {
    const owner = nameHint ?? 'object';
    const inputs: InputSpec[] = [];
    for (const [i, prop] of expr.properties.entries()) {
      if (prop.type === 'SpreadElement') {
        inputs.push({
          pin: this.dataIn(`p${i}`, '...', rangeOf(prop.argument), 'object'),
          value: this.lowerExpr(prop.argument, `${path}.p${i}`, mode),
        });
        continue;
      }

      const key = prop.computed
        ? `[${truncate(this.source(rangeOf(prop.key)), 16)}]`
        : prop.key.type === 'Identifier'
          ? prop.key.name
          : truncate(this.source(rangeOf(prop.key)), 16);

      if (prop.type === 'ObjectMethod') {
        const fnName = `${owner}.${key}`;
        this.queueFunction(fnName, 'method', prop);
        inputs.push({
          pin: this.dataIn(`p${i}`, key, undefined, 'function'),
          value: this.pureNode({
            kind: 'functionRef',
            title: `ƒ ${fnName}`,
            expr: prop,
            path: `${path}.p${i}`,
            inputs: [],
            outType: 'function',
            compact: true,
          }),
        });
        continue;
      }

      const valueExpr = prop.value as t.Expression;
      inputs.push({
        pin: this.dataIn(
          `p${i}`,
          key,
          rangeOf(valueExpr),
          'any',
          !prop.computed && prop.key.type === 'Identifier'
            ? {
                propertyKey: prop.key.name,
                property: rangeOf(prop),
                ...(prop.shorthand ? { shorthand: true } : {}),
              }
            : undefined
        ),
        value: this.lowerExpr(
          valueExpr,
          `${path}.p${i}`,
          mode,
          `${owner}.${key}`
        ),
      });
    }

    return this.pureNode({
      kind: 'makeObject',
      title: 'Make Object',
      expr,
      path,
      inputs,
      outType: 'object',
      outName: 'Object',
    });
  }
}
