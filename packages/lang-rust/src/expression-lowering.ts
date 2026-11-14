import type { DataType, InputSpec, ValueSource } from '@vizscript/core';
import {
  arrayElementType,
  arrayOf,
  isArrayType,
  truncate,
} from '@vizscript/core';
import type { Expr } from './ast';
import { CallLowering } from './call-lowering';
import { dataTypeOf } from './data-type';
import { only, rangeOf, simpleChain, unwrap } from './lower-utils';

const COMPARISONS = new Set(['==', '!=', '<', '<=', '>', '>=']);

/** Values: names, operators, literals, structs, closures and `if` values. */
export abstract class ExpressionLowering extends CallLowering {
  protected lowerExpr(
    rawExpr: Expr,
    path: string,
    mode: 'eager' | 'lazy',
    nameHint?: string
  ): ValueSource {
    const expr = unwrap(rawExpr);
    const range = rangeOf(expr);
    const raw = this.src(range);

    switch (expr.type) {
      case 'Literal': {
        return this.lowerLiteral(expr, raw);
      }

      case 'Name': {
        const entry = this.lookup(expr.name);
        if (entry?.source) {
          return { pin: entry.source, type: entry.type };
        }

        return this.getVar(
          expr.name,
          range,
          path,
          entry?.type ?? this.doc.globals.get(expr.name) ?? 'any'
        );
      }

      case 'Field': {
        const chain = simpleChain(expr);
        const root = chain?.[0];
        if (
          chain &&
          root !== undefined &&
          root !== 'self' &&
          !this.lookup(root)?.source
        ) {
          return this.getVar(chain.join('.'), range, path, 'any');
        }

        return this.pureNode({
          kind: 'getProperty',
          title: `.${expr.name}`,
          range,
          path,
          inputs: [
            {
              pin: this.dataIn('target', '', rangeOf(expr.object), 'object'),
              value: this.lowerExpr(expr.object, `${path}.target`, mode),
            },
          ],
          outType: 'any',
          compact: true,
        });
      }

      case 'Index': {
        const target = this.lowerExpr(expr.object, `${path}.target`, mode);
        return this.pureNode({
          kind: 'getProperty',
          title: '[ ]',
          range,
          path,
          inputs: [
            {
              pin: this.dataIn('target', '', rangeOf(expr.object), 'object'),
              value: target,
            },
            {
              pin: this.dataIn('key', '', rangeOf(expr.index)),
              value: this.lowerExpr(expr.index, `${path}.key`, mode),
            },
          ],
          outType: isArrayType(target.type)
            ? arrayElementType(target.type)
            : 'any',
          compact: true,
        });
      }

      case 'Call': {
        return this.lowerCall(expr, path, mode === 'eager' ? 'hoist' : 'pure');
      }

      case 'Macro': {
        return this.lowerMacroValue(expr, path, mode, nameHint);
      }

      case 'Binary': {
        return this.lowerBinary(expr, path, mode);
      }

      case 'Unary': {
        const argument = unwrap(expr.argument);
        if (
          expr.op === '-' &&
          argument.type === 'Literal' &&
          (argument.kind === 'int' || argument.kind === 'float')
        ) {
          return this.literal('number', raw, raw, 'number');
        }

        const value = this.lowerExpr(argument, `${path}.a`, mode);
        return this.pureNode({
          kind: 'operator',
          title: expr.op,
          range,
          path,
          inputs: [{ pin: this.dataIn('a', '', rangeOf(argument)), value }],
          outType:
            expr.op === '!'
              ? value.type === 'number'
                ? 'number'
                : 'bool'
              : expr.op === '*'
                ? value.type
                : 'number',
          compact: true,
        });
      }

      case 'Ref': {
        const value = this.lowerExpr(expr.argument, `${path}.a`, mode);
        return this.pureNode({
          kind: 'operator',
          title: expr.mutable ? '&mut' : '&',
          range,
          path,
          inputs: [
            { pin: this.dataIn('a', '', rangeOf(expr.argument)), value },
          ],
          outType: value.type,
          compact: true,
        });
      }

      case 'Cast': {
        const target = this.src(rangeOf(expr.target));
        return this.pureNode({
          kind: 'operator',
          title: `as ${truncate(target, 16)}`,
          range,
          path,
          inputs: [
            {
              pin: this.dataIn('a', '', rangeOf(expr.value)),
              value: this.lowerExpr(expr.value, `${path}.a`, mode),
            },
          ],
          outType: dataTypeOf(target, this.owner),
          compact: true,
        });
      }

      case 'Range': {
        const inputs: InputSpec[] = [];
        if (expr.from) {
          inputs.push({
            pin: this.dataIn('a', 'From', rangeOf(expr.from), 'number'),
            value: this.lowerExpr(expr.from, `${path}.a`, mode),
          });
        }

        if (expr.to) {
          inputs.push({
            pin: this.dataIn('b', 'To', rangeOf(expr.to), 'number'),
            value: this.lowerExpr(expr.to, `${path}.b`, mode),
          });
        }

        return this.pureNode({
          kind: 'operator',
          title: expr.op,
          subtitle: 'range',
          range,
          path,
          inputs,
          outType: arrayOf('number'),
        });
      }

      case 'Try': {
        const value = this.lowerExpr(expr.value, `${path}.a`, mode);
        return this.pureNode({
          kind: 'operator',
          title: '?',
          range,
          path,
          inputs: [{ pin: this.dataIn('a', '', rangeOf(expr.value)), value }],
          outType: 'any',
          compact: true,
        });
      }

      case 'Await': {
        return this.lowerAwait(expr, path, mode);
      }

      case 'Struct': {
        const inputs: InputSpec[] = expr.fields.map((field, i) => {
          const value: Expr = field.value ?? {
            type: 'Name',
            name: field.name,
            start: field.nameSpan.start,
            end: field.nameSpan.end,
          };
          return {
            pin: this.dataIn(`p${i}`, field.name, rangeOf(value), 'any', {
              propertyKey: field.name,
              property: rangeOf(field),
              ...(field.value ? {} : { shorthand: true }),
            }),
            value: this.lowerExpr(value, `${path}.p${i}`, mode, field.name),
          };
        });
        if (expr.base) {
          inputs.push({
            pin: this.dataIn('base', '..', rangeOf(expr.base)),
            value: this.lowerExpr(expr.base, `${path}.base`, mode),
          });
        }

        const type = expr.name === 'Self' ? (this.owner ?? 'Self') : expr.name;
        return this.pureNode({
          kind: 'makeObject',
          title: `Make ${truncate(expr.name, 24)}`,
          range,
          path,
          inputs,
          outType: dataTypeOf(type, this.owner),
          outName: type.split('::').at(-1) ?? type,
        });
      }

      case 'Array': {
        return this.makeArray(
          expr.items,
          expr.repeat === true,
          'Array',
          range,
          path,
          mode
        );
      }

      case 'Tuple': {
        return this.pureNode({
          kind: 'makeArray',
          title: 'Make Tuple',
          range,
          path,
          inputs: expr.items.map((item, i) => ({
            pin: this.dataIn(`e${i}`, `.${i}`, rangeOf(item)),
            value: this.lowerExpr(item, `${path}.e${i}`, mode),
          })),
          outType: 'array',
          outName: 'Tuple',
        });
      }

      case 'Closure': {
        const name = nameHint ?? 'closure';
        this.queueClosure(name, expr);
        return this.pureNode({
          kind: 'functionRef',
          title: `ƒ ${name}`,
          range,
          path,
          inputs: [],
          outType: 'function',
          compact: true,
        });
      }

      case 'If': {
        return this.lowerIfValue(expr, path, mode);
      }

      case 'Match': {
        return this.pureNode({
          kind: 'select',
          title: 'Match',
          subtitle: `${expr.stmt.arms.length} arms`,
          range,
          path,
          inputs: [
            {
              pin: this.dataIn('value', 'Subject', rangeOf(expr.stmt.subject)),
              value: this.lowerExpr(expr.stmt.subject, `${path}.value`, mode),
            },
          ],
          outType: 'any',
        });
      }

      case 'Let':
      case 'LetChain':
      case 'Block':
      case 'Paren':
      case 'Opaque': {
        return this.pureNode({
          kind: 'unknown',
          title: truncate(raw.replaceAll(/\s+/g, ' '), 32),
          subtitle:
            expr.type === 'Opaque'
              ? expr.nodeName
              : expr.type === 'Block'
                ? expr.label || 'block'
                : undefined,
          range,
          path,
          inputs: [],
          outType: 'any',
          category: 'unknown',
        });
      }
    }
  }

  /** `if c { a } else { b }` as a value: a Select when both are values. */
  protected lowerIfValue(
    expr: Extract<Expr, { type: 'If' }>,
    path: string,
    mode: 'eager' | 'lazy'
  ): ValueSource {
    const stmt = expr.stmt;
    const yes = only(stmt.body);
    const no = only(stmt.orelse);
    const condition = unwrap(stmt.condition);
    if (
      yes &&
      no &&
      stmt.elifs.length === 0 &&
      condition.type !== 'Let' &&
      condition.type !== 'LetChain'
    ) {
      const a = this.lowerExpr(yes, `${path}.true`, 'lazy');
      const b = this.lowerExpr(no, `${path}.false`, 'lazy');
      return this.pureNode({
        kind: 'select',
        title: 'Select',
        range: rangeOf(expr),
        path,
        inputs: [
          {
            pin: this.dataIn(
              'condition',
              'Condition',
              rangeOf(condition),
              'bool'
            ),
            value: this.lowerExpr(condition, `${path}.test`, mode),
          },
          { pin: this.dataIn('true', 'True', rangeOf(yes)), value: a },
          { pin: this.dataIn('false', 'False', rangeOf(no)), value: b },
        ],
        outType: a.type === b.type ? a.type : 'any',
      });
    }

    return this.pureNode({
      kind: 'unknown',
      title: truncate(this.src(rangeOf(expr)).replaceAll(/\s+/g, ' '), 32),
      subtitle: 'if',
      range: rangeOf(expr),
      path,
      inputs: [],
      outType: 'any',
      category: 'unknown',
    });
  }

  protected lowerLiteral(
    expr: Extract<Expr, { type: 'Literal' }>,
    raw: string
  ): ValueSource {
    switch (expr.kind) {
      case 'int':
      case 'float': {
        return this.literal('number', raw, raw, 'number');
      }

      case 'bool': {
        return this.literal('boolean', raw, raw, 'bool');
      }

      case 'unit': {
        return this.literal('null', '()', raw, 'void');
      }

      case 'bytes': {
        const value = this.literal('string', expr.value, raw, 'bytes');
        return value;
      }

      default: {
        return this.literal('string', expr.value, raw, 'string');
      }
    }
  }

  protected lowerBinary(
    expr: Extract<Expr, { type: 'Binary' }>,
    path: string,
    mode: 'eager' | 'lazy'
  ): ValueSource {
    const logical = expr.op === '&&' || expr.op === '||';
    const left = this.lowerExpr(expr.left, `${path}.a`, mode);
    const right = this.lowerExpr(
      expr.right,
      `${path}.b`,
      logical ? 'lazy' : mode
    );
    let type: DataType;
    if (COMPARISONS.has(expr.op) || logical) {
      type = 'bool';
    } else if (expr.op === '+') {
      type =
        left.type === 'string'
          ? 'string'
          : left.type === 'number' || right.type === 'number'
            ? 'number'
            : 'any';
    } else {
      type =
        left.type === 'number' || right.type === 'number'
          ? 'number'
          : left.type === 'bool' && right.type === 'bool'
            ? 'bool'
            : 'any';
    }

    return this.pureNode({
      kind: 'operator',
      title: expr.op,
      range: rangeOf(expr),
      path,
      inputs: [
        { pin: this.dataIn('a', '', rangeOf(expr.left)), value: left },
        { pin: this.dataIn('b', '', rangeOf(expr.right)), value: right },
      ],
      outType: type,
      compact: true,
    });
  }

  protected lowerAwait(
    expr: Extract<Expr, { type: 'Await' }>,
    path: string,
    mode: 'eager' | 'lazy'
  ): ValueSource {
    const range = rangeOf(expr);
    const value = this.lowerExpr(expr.value, `${path}.value`, mode);
    if (mode === 'lazy') {
      return this.pureNode({
        kind: 'await',
        title: '.await',
        range,
        path,
        inputs: [
          { pin: this.dataIn('future', '', rangeOf(expr.value)), value },
        ],
        outType: 'any',
        compact: true,
      });
    }

    const pin = this.dataIn('future', 'Future', rangeOf(expr.value));
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
        this.dataOut(
          'result',
          'Result',
          'any',
          {
            bind: {
              expr: range,
              stmt: this.currentStatement ?? range,
              isStatement: false,
              nameHint: 'result',
            },
          },
          range
        ),
      ],
      path,
    });
    this.feed(node.id, pin, value);
    this.chain(node);
    return { pin: { node: node.id, pin: 'result' }, type: 'any' };
  }
}
