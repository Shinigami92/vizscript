import type { DataType, InputSpec, ValueSource } from '@vizscript/core';
import {
  arrayOf,
  CHAIN_OPERATORS,
  chainPinId,
  elementAccess,
  findContainerOperator,
  flattenChain,
  isArrayType,
  lastIndexValue,
  markContainerCandidate,
  styleContainerValue,
  truncate,
} from '@vizscript/core';
import type { Expr } from './ast';
import { CallLowering } from './call-lowering';
import { RUST_CONTAINER_OPS } from './container-ops';
import { dataTypeOf } from './data-type';
import { only, rangeOf, unwrap } from './lower-utils';

const COMPARISONS = new Set(['==', '!=', '<', '<=', '>', '>=']);

/** The type of `left op right`. */
function binaryType(
  op: string,
  logical: boolean,
  left: DataType,
  right: DataType
): DataType {
  if (COMPARISONS.has(op) || logical) {
    return 'bool';
  }

  if (op === '+') {
    return left === 'string'
      ? 'string'
      : left === 'number' || right === 'number'
        ? 'number'
        : 'any';
  }

  return left === 'number' || right === 'number'
    ? 'number'
    : left === 'bool' && right === 'bool'
      ? 'bool'
      : 'any';
}

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
        // A Get of the object and its field (`config` → `.name`), like UE.
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
        // UE's GET node: the container, the index, the element. A range
        // (`&v[1..3]`) is a slice: part of the container.
        const target = this.lowerExpr(expr.object, `${path}.target`, mode);
        const slice = unwrap(expr.index).type === 'Range';
        const access = elementAccess(target.type);
        return this.pureNode({
          kind: 'getProperty',
          title: slice ? '[..]' : access.title,
          range,
          path,
          inputs: [
            {
              pin: this.dataIn(
                'target',
                '',
                rangeOf(expr.object),
                access.targetType
              ),
              value: target,
            },
            {
              pin: this.dataIn(
                'key',
                '',
                rangeOf(expr.index),
                slice ? 'any' : access.keyType
              ),
              value: this.lowerExpr(expr.index, `${path}.key`, mode),
            },
          ],
          outType: slice
            ? isArrayType(target.type) || target.type === 'string'
              ? target.type
              : 'any'
            : access.outType,
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
    const operands = CHAIN_OPERATORS.has(expr.op)
      ? flattenChain<Expr>(
          expr,
          (e) =>
            e.type === 'Binary' && e.op === expr.op
              ? [e.left, e.right]
              : undefined,
          (e) => rangeOf(e).start
        )
      : [expr.left, expr.right];
    const values = operands.map((operand, index) =>
      this.lowerExpr(
        operand,
        `${path}.${chainPinId(index)}`,
        logical && index > 0 ? 'lazy' : mode
      )
    );
    const type = values
      .slice(1)
      .reduce<DataType>(
        (left, right) => binaryType(expr.op, logical, left, right.type),
        values[0]?.type ?? 'any'
      );

    // UE's LAST INDEX: `items.len() - 1` is one node.
    const lastIndex = lastIndexValue(
      this.nodes,
      expr.op,
      values,
      operands.map((operand) => this.src(rangeOf(operand))),
      rangeOf(expr),
      this.src(rangeOf(expr))
    );
    if (lastIndex) {
      return lastIndex;
    }

    const value = this.pureNode({
      kind: 'operator',
      title: expr.op,
      range: rangeOf(expr),
      path,
      inputs: operands.map((operand, index) => ({
        pin: this.dataIn(chainPinId(index), '', rangeOf(operand)),
        value: values[index] as ValueSource,
      })),
      outType: type,
      compact: true,
    });
    // UE's container nodes: `&a | &b` of sets is UNION.
    const found = findContainerOperator(
      RUST_CONTAINER_OPS,
      expr.op,
      values.map((v) => v.type)
    );
    if (found) {
      return styleContainerValue(
        this.nodes,
        value,
        found.op,
        values[found.index]?.type ?? 'any',
        chainPinId(found.index)
      );
    }

    // Its values typed only later: `applyTypes` makes it one then.
    const node =
      'pin' in value
        ? this.nodes.find((n) => n.id === value.pin.node)
        : undefined;
    if (
      node &&
      RUST_CONTAINER_OPS.some(
        (o) => o.form === 'operator' && o.name === expr.op
      )
    ) {
      markContainerCandidate(node, {
        form: 'operator',
        name: expr.op,
        args: operands.length - 1,
        pin: chainPinId(0),
        statement: false,
        code: this.src(rangeOf(expr)),
      });
    }

    return value;
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
