import type {
  DataType,
  InputSpec,
  InsertPoint,
  OutputPinMeta,
  Pin,
  ValueSource,
} from '@vizscript/core';
import {
  arrayOfAll,
  GraphBuilderBase,
  isArrayType,
  truncate,
} from '@vizscript/core';
import type { Expr, FuncDecl, Span } from './ast';
import { dataTypeOf } from './data-type';
import type { EvalMode, GraphSource, LoweringContext } from './lower-utils';
import { rangeOf, simpleChain, unwrap } from './lower-utils';

const COMPARISON_OPERATORS = new Set([
  '==',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  'in',
  'not in',
]);

const LOGICAL_OPERATORS = new Set(['and', 'or', '&&', '||']);

/**
 * The base of `FnGraphBuilder`: calls and other expressions. Control flow
 * and statements build on it, one layer per file.
 */
export abstract class ExpressionLowering extends GraphBuilderBase {
  protected readonly name: string;

  public constructor(
    protected readonly doc: LoweringContext,
    protected readonly source: GraphSource
  ) {
    super(doc.text, doc.uniqueFunctionId(source.name));
    this.name = source.name;
  }

  protected literalType(expr: Expr): DataType {
    const e = unwrap(expr);
    if (e.type !== 'Literal') {
      return 'any';
    }

    switch (e.kind) {
      case 'int':
      case 'float': {
        return 'number';
      }

      case 'bool': {
        return 'bool';
      }

      case 'null': {
        return 'null';
      }

      default: {
        return 'string';
      }
    }
  }

  protected queueFunction(name: string, kind: string, fn: FuncDecl): void {
    this.doc.queue.push({ type: 'func', name, kind, fn });
  }

  // ----------------------------------------------------------- expressions

  protected lowerCall(
    expr: Extract<Expr, { type: 'Call' }>,
    path: string,
    mode: 'statement' | 'hoist' | 'pure',
    statement?: {
      statementMeta: Record<string, unknown>;
      insert: InsertPoint | undefined;
      stmt: Span;
    }
  ): ValueSource {
    const evalMode: EvalMode = mode === 'pure' ? 'lazy' : 'eager';
    const callee = unwrap(expr.callee);
    const inputs: InputSpec[] = [];
    let title: string;
    let knownName: string | undefined;

    const chain = simpleChain(callee, this.text);
    const rootWired =
      chain?.[0] !== undefined && this.lookup(chain[0])?.source !== undefined;
    if (chain && !(rootWired && chain.length > 1)) {
      title = chain.join('.');
      knownName =
        chain.length === 1
          ? chain[0]
          : chain.length === 2 && chain[0] === 'self'
            ? chain[1]
            : undefined;
    } else if (callee.type === 'Attribute') {
      title = callee.name;
      inputs.push({
        pin: this.dataIn('target', 'Target', rangeOf(callee.object), 'object'),
        value: this.lowerExpr(callee.object, `${path}.target`, evalMode),
      });
    } else {
      title = 'Call';
      inputs.push({
        pin: this.dataIn('function', 'Function', rangeOf(callee), 'function'),
        value: this.lowerExpr(callee, `${path}.callee`, evalMode),
      });
    }

    const signature = knownName
      ? this.doc.signatures.get(knownName)
      : undefined;
    for (const [index, arg] of expr.args.entries()) {
      inputs.push({
        pin: this.dataIn(
          `arg${index}`,
          signature?.params[index] ?? '',
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

    const constructed =
      chain && chain.length >= 2 && chain.at(-1) === 'new'
        ? chain.at(-2)
        : undefined;
    const returnType: DataType =
      signature?.returnType ?? (constructed ? dataTypeOf(constructed) : 'any');

    const impure = mode !== 'pure';
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
            nameHint:
              chain?.at(-1) === 'new'
                ? (constructed ?? 'value')
                : (chain?.at(-1) ?? 'value'),
          },
        }
      : { sourceText: this.src(rangeOf(expr)) };
    if (returnType !== 'void') {
      pins.push(this.dataOut('return', '', returnType, outMeta, rangeOf(expr)));
    }

    const node = this.addNode({
      kind: 'call',
      title,
      category: impure ? 'function' : 'pure',
      purity: impure ? 'impure' : 'pure',
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
    rawExpr: Expr,
    path: string,
    mode: EvalMode,
    nameHint?: string
  ): ValueSource {
    const expr = unwrap(rawExpr);
    const range = rangeOf(expr);
    const raw = this.src(range);

    switch (expr.type) {
      case 'Literal': {
        switch (expr.kind) {
          case 'int':
          case 'float': {
            return this.literal('number', raw, raw, 'number');
          }

          case 'bool': {
            return this.literal('boolean', raw, raw, 'bool');
          }

          case 'null': {
            return this.literal('null', 'null', raw, 'null');
          }

          default: {
            return this.literal(
              'string',
              expr.value,
              raw,
              expr.kind === 'stringName'
                ? 'StringName'
                : expr.kind === 'nodePath'
                  ? 'NodePath'
                  : 'string'
            );
          }
        }
      }

      case 'Identifier': {
        const entry = this.lookup(expr.name);
        if (entry?.source) {
          return { pin: entry.source, type: entry.type };
        }

        return this.getVar(
          expr.name,
          rangeOf(expr),
          path,
          entry?.type ?? this.doc.memberTypes.get(expr.name) ?? 'any'
        );
      }

      case 'Self': {
        return this.getVar('self', rangeOf(expr), path, 'object');
      }

      case 'Super': {
        return this.getVar('super', rangeOf(expr), path, 'object');
      }

      case 'NodePath': {
        return this.getVar(raw, rangeOf(expr), path, 'Node');
      }

      case 'Unary': {
        const argument = unwrap(expr.argument);
        if (
          (expr.op === '-' || expr.op === '+') &&
          argument.type === 'Literal' &&
          (argument.kind === 'int' || argument.kind === 'float')
        ) {
          return this.literal('number', raw, raw, 'number');
        }

        return this.pureNode({
          kind: 'operator',
          title: expr.op,
          range: rangeOf(expr),
          path,
          inputs: [
            {
              pin: this.dataIn('a', '', rangeOf(argument)),
              value: this.lowerExpr(argument, `${path}.a`, mode),
            },
          ],
          outType: expr.op === 'not' || expr.op === '!' ? 'bool' : 'number',
          compact: true,
        });
      }

      case 'Binary': {
        const logical = LOGICAL_OPERATORS.has(expr.op);
        const left = this.lowerExpr(expr.left, `${path}.a`, mode);
        const right = this.lowerExpr(
          expr.right,
          `${path}.b`,
          logical ? 'lazy' : mode
        );
        let type: DataType;
        if (COMPARISON_OPERATORS.has(expr.op) || logical) {
          type = 'bool';
        } else if (expr.op === '+' || expr.op === '%') {
          type =
            left.type === 'string'
              ? 'string'
              : left.type === 'number' && right.type === 'number'
                ? 'number'
                : isArrayType(left.type) && expr.op === '+'
                  ? left.type
                  : 'any';
        } else {
          type =
            left.type === 'number' && right.type === 'number'
              ? 'number'
              : left.type === 'number'
                ? 'number'
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

      case 'Ternary': {
        const yes = this.lowerExpr(expr.consequent, `${path}.true`, 'lazy');
        const no = this.lowerExpr(expr.alternate, `${path}.false`, 'lazy');
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

      case 'Cast':
      case 'Is': {
        const isCast = expr.type === 'Cast';
        const negated = expr.type === 'Is' && expr.negated;
        return this.pureNode({
          kind: 'operator',
          title: `${isCast ? 'as' : negated ? 'is not' : 'is'} ${expr.target.name}`,
          range: rangeOf(expr),
          path,
          inputs: [
            {
              pin: this.dataIn('a', '', rangeOf(expr.expr)),
              value: this.lowerExpr(expr.expr, `${path}.a`, mode),
            },
          ],
          outType: isCast ? dataTypeOf(expr.target) : 'bool',
          compact: true,
        });
      }

      case 'Attribute': {
        const chain = simpleChain(expr, this.text);
        const root = chain?.[0];
        if (chain && root !== undefined && !this.lookup(root)?.source) {
          return this.getVar(chain.join('.'), rangeOf(expr), path, 'any');
        }

        return this.pureNode({
          kind: 'getProperty',
          title: `.${expr.name}`,
          range: rangeOf(expr),
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

      case 'Subscript': {
        return this.pureNode({
          kind: 'getProperty',
          title: '[ ]',
          range: rangeOf(expr),
          path,
          inputs: [
            {
              pin: this.dataIn('target', '', rangeOf(expr.object), 'object'),
              value: this.lowerExpr(expr.object, `${path}.target`, mode),
            },
            {
              pin: this.dataIn('key', '', rangeOf(expr.index)),
              value: this.lowerExpr(expr.index, `${path}.key`, mode),
            },
          ],
          outType: 'any',
          compact: true,
        });
      }

      case 'Call': {
        return this.lowerCall(expr, path, mode === 'eager' ? 'hoist' : 'pure');
      }

      case 'Await': {
        const value = this.lowerExpr(expr.argument, `${path}.value`, mode);
        if (mode === 'lazy') {
          return this.pureNode({
            kind: 'await',
            title: 'await',
            range: rangeOf(expr),
            path,
            inputs: [
              { pin: this.dataIn('signal', '', rangeOf(expr.argument)), value },
            ],
            outType: 'any',
            compact: true,
          });
        }

        const pin = this.dataIn('signal', 'Signal', rangeOf(expr.argument));
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

      case 'Array': {
        return this.pureNode({
          kind: 'makeArray',
          title: 'Make Array',
          range: rangeOf(expr),
          path,
          inputs: expr.elements.map((element, i) => ({
            pin: this.dataIn(`e${i}`, `[${i}]`, rangeOf(element)),
            value: this.lowerExpr(element, `${path}.e${i}`, mode),
          })),
          outType: arrayOfAll(expr.elements.map((e) => this.literalType(e))),
          outName: 'Array',
        });
      }

      case 'Dictionary': {
        return this.pureNode({
          kind: 'makeObject',
          title: 'Make Dictionary',
          range: rangeOf(expr),
          path,
          inputs: expr.entries.map((entry, i) => {
            const key = unwrap(entry.key);
            const label =
              key.type === 'Literal' &&
              key.kind !== 'int' &&
              key.kind !== 'float'
                ? key.value
                : truncate(this.src(rangeOf(key)), 16);
            return {
              pin: this.dataIn(`p${i}`, label, rangeOf(entry.value)),
              value: this.lowerExpr(
                entry.value,
                `${path}.p${i}`,
                mode,
                `${nameHint ?? 'dictionary'}.${label}`
              ),
            };
          }),
          outType: 'object',
          outName: 'Dictionary',
        });
      }

      case 'Lambda': {
        const name = expr.fn.name ?? nameHint ?? 'lambda';
        this.queueFunction(name, 'lambda', expr.fn);
        return this.pureNode({
          kind: 'functionRef',
          title: `ƒ ${name}`,
          range: rangeOf(expr),
          path,
          inputs: [],
          outType: 'function',
          compact: true,
        });
      }

      case 'Paren':
      case 'Error': {
        return this.pureNode({
          kind: 'unknown',
          title: truncate(raw, 32),
          subtitle: expr.type,
          range: rangeOf(expr),
          path,
          inputs: [],
          outType: 'any',
          category: 'unknown',
        });
      }
    }
  }
}
