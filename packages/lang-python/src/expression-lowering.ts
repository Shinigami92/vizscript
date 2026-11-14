import { conversionCall } from '@vizscript/core';
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
import type { Expr, Span } from './ast';
import { CONVERSIONS } from './conversions';
import type { DocumentContext, GraphSource, Signature } from './lower-utils';
import { COMPARISONS, rangeOf, simpleChain, unwrap } from './lower-utils';

/** Lowers expressions into pure nodes, hoisted calls and literals. */
export abstract class ExpressionLowering extends GraphBuilderBase {
  protected readonly name: string;
  /** `self.method()` calls resolve against this class. */
  protected readonly className: string | undefined;

  public constructor(
    protected readonly doc: DocumentContext,
    protected readonly source: GraphSource
  ) {
    const name = source.type === 'module' ? 'Module' : source.name;
    super(doc.text, doc.uniqueFunctionId(name));
    this.name = name;
    this.className =
      source.type === 'class'
        ? source.name
        : source.type === 'function' && source.name.includes('.')
          ? source.name.split('.').slice(0, -1).join('.')
          : undefined;
  }

  protected literalType(expr: Expr): DataType {
    const e = unwrap(expr);
    switch (e.type) {
      case 'FString': {
        return 'string';
      }

      case 'Collection': {
        return 'array';
      }

      case 'Dict': {
        return 'object';
      }

      case 'Literal': {
        return e.kind === 'int' || e.kind === 'float'
          ? 'number'
          : e.kind === 'bool'
            ? 'bool'
            : e.kind === 'none'
              ? 'null'
              : e.kind === 'bytes'
                ? 'bytes'
                : 'string';
      }

      default: {
        return 'any';
      }
    }
  }

  protected lowerCall(
    expr: Extract<Expr, { type: 'Call' }>,
    path: string,
    mode: 'statement' | 'hoist' | 'pure',
    statement?: {
      meta: Record<string, unknown>;
      insert: InsertPoint | undefined;
      stmt: Span;
    }
  ): ValueSource {
    const evalMode = mode === 'pure' ? 'lazy' : 'eager';
    const callee = unwrap(expr.callee);
    const inputs: InputSpec[] = [];
    let title: string;
    let signature: Signature | undefined;

    const chain = simpleChain(callee);
    const root = chain?.[0];
    const rootWired =
      root !== undefined && this.lookup(root)?.source !== undefined;
    if (chain && (!rootWired || chain.length === 1 || root === 'self')) {
      title = chain.join('.');
      signature =
        root === 'self' && this.className
          ? this.doc.signatures.get(
              `${this.className}.${chain.slice(1).join('.')}`
            )
          : this.doc.signatures.get(title);
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

    let positional = 0;
    for (const [i, arg] of expr.args.entries()) {
      const label = arg.keyword
        ? `${arg.keyword}=`
        : (arg.star ?? signature?.params[positional++] ?? '');
      inputs.push({
        pin: this.dataIn(`arg${i}`, label, rangeOf(arg.value)),
        value: this.lowerExpr(
          arg.value,
          `${path}.arg${i}`,
          evalMode,
          `${title} callback`
        ),
      });
    }

    // `str(x)`: a pure compact node, like UE's autocast.
    const converts =
      mode === 'statement'
        ? undefined
        : conversionCall(CONVERSIONS, title, inputs.length);
    const returnType: DataType = converts ?? signature?.returnType ?? 'any';
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
      : { sourceText: this.src(rangeOf(expr)) };
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
      meta: statement?.meta,
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

      case 'FString': {
        return this.pureNode({
          kind: 'template',
          title: 'Format Text',
          subtitle: truncate(expr.format, 32),
          range,
          path,
          inputs: expr.parts.map((part, i) => ({
            pin: this.dataIn(`part${i}`, `{${i}}`, rangeOf(part)),
            value: this.lowerExpr(part, `${path}.part${i}`, mode),
          })),
          outType: 'string',
          outName: 'Result',
        });
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

      case 'Attribute': {
        const chain = simpleChain(expr);
        const root = chain?.[0];
        if (
          chain &&
          root !== undefined &&
          (!this.lookup(root)?.source || root === 'self')
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

      case 'Subscript': {
        const sliced = expr.index.type === 'Opaque';
        const inputs: InputSpec[] = [
          {
            pin: this.dataIn('target', '', rangeOf(expr.object), 'object'),
            value: this.lowerExpr(expr.object, `${path}.target`, mode),
          },
        ];
        if (!sliced) {
          inputs.push({
            pin: this.dataIn('key', '', rangeOf(expr.index)),
            value: this.lowerExpr(expr.index, `${path}.key`, mode),
          });
        }

        return this.pureNode({
          kind: 'getProperty',
          title: sliced
            ? `[${truncate(this.src(rangeOf(expr.index)), 12)}]`
            : '[ ]',
          range,
          path,
          inputs,
          outType: 'any',
          compact: true,
        });
      }

      case 'Call': {
        return this.lowerCall(expr, path, mode === 'eager' ? 'hoist' : 'pure');
      }

      case 'Binary': {
        return this.lowerBinary(expr, path, mode);
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
          range,
          path,
          inputs: [
            {
              pin: this.dataIn('a', '', rangeOf(argument)),
              value: this.lowerExpr(argument, `${path}.a`, mode),
            },
          ],
          outType: expr.op === 'not' ? 'bool' : 'number',
          compact: true,
        });
      }

      case 'Conditional': {
        const yes = this.lowerExpr(expr.consequent, `${path}.true`, 'lazy');
        const no = this.lowerExpr(expr.alternate, `${path}.false`, 'lazy');
        return this.pureNode({
          kind: 'select',
          title: 'Select',
          range,
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

      case 'Collection': {
        const label = { list: 'List', tuple: 'Tuple', set: 'Set' }[expr.kind];
        return this.pureNode({
          kind: 'makeArray',
          title: `Make ${label}`,
          range,
          path,
          inputs: expr.items.map((item, i) => ({
            pin: this.dataIn(
              `e${i}`,
              item.type === 'Starred' ? '*' : `[${i}]`,
              rangeOf(item)
            ),
            value: this.lowerExpr(
              item.type === 'Starred' ? item.value : item,
              `${path}.e${i}`,
              mode
            ),
          })),
          outType:
            expr.kind === 'tuple'
              ? 'array'
              : arrayOfAll(expr.items.map((item) => this.literalType(item))),
          outName: label,
        });
      }

      case 'Dict': {
        return this.pureNode({
          kind: 'makeObject',
          title: 'Make Dict',
          range,
          path,
          inputs: expr.entries.map((entry, i) => {
            const key = entry.key ? unwrap(entry.key) : undefined;
            const label = !key
              ? '**'
              : key.type === 'Literal' && key.kind === 'string'
                ? key.value
                : truncate(this.src(rangeOf(key)), 16);
            return {
              pin: this.dataIn(`p${i}`, label, rangeOf(entry.value)),
              value: this.lowerExpr(
                entry.value,
                `${path}.p${i}`,
                mode,
                `${nameHint ?? 'dict'}.${label}`
              ),
            };
          }),
          outType: 'object',
          outName: 'Dict',
        });
      }

      case 'Comprehension': {
        const label = {
          list: 'List',
          set: 'Set',
          dict: 'Dict',
          generator: 'Generator',
        }[expr.kind];
        return this.pureNode({
          kind: 'makeArray',
          title: `${label} Comprehension`,
          subtitle: truncate(raw, 32),
          range,
          path,
          inputs: expr.sources.map((source, i) => ({
            pin: this.dataIn(
              `source${i}`,
              expr.sources.length > 1 ? `in ${i + 1}` : 'in',
              rangeOf(source)
            ),
            value: this.lowerExpr(source, `${path}.source${i}`, 'lazy'),
          })),
          outType: expr.kind === 'dict' ? 'object' : 'array',
        });
      }

      case 'Lambda': {
        const name = nameHint ?? 'lambda';
        this.doc.queue.push({
          type: 'function',
          name,
          kind: 'lambda',
          fn: {
            params: expr.params,
            body: expr.body,
            start: expr.start,
            end: expr.end,
          },
        });
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

      case 'Await': {
        return this.lowerAwait(expr, path, mode);
      }

      case 'Starred': {
        return this.lowerExpr(expr.value, path, mode);
      }

      case 'Paren':
      case 'Opaque': {
        return this.pureNode({
          kind: 'unknown',
          title: truncate(raw, 32),
          subtitle: expr.type === 'Opaque' ? expr.nodeName : undefined,
          range,
          path,
          inputs: [],
          outType: 'any',
          category: 'unknown',
        });
      }
    }
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

      case 'none': {
        return this.literal('null', 'None', raw, 'null');
      }

      default: {
        const value = this.literal(
          'string',
          expr.value,
          raw,
          expr.kind === 'bytes' ? 'bytes' : 'string'
        );
        // Implicitly concatenated strings can't be edited as one value.
        if ('literal' in value && /["']\s+[rRbBuU]*["']/.test(raw)) {
          value.literal.editable = false;
        }

        return value;
      }
    }
  }

  protected lowerBinary(
    expr: Extract<Expr, { type: 'Binary' }>,
    path: string,
    mode: 'eager' | 'lazy'
  ): ValueSource {
    const logical = expr.op === 'and' || expr.op === 'or';
    const left = this.lowerExpr(expr.left, `${path}.a`, mode);
    const right = this.lowerExpr(
      expr.right,
      `${path}.b`,
      logical ? 'lazy' : mode
    );
    let type: DataType;
    if (COMPARISONS.has(expr.op)) {
      type = 'bool';
    } else if (logical) {
      type = left.type === right.type ? left.type : 'any';
    } else if (expr.op === '+' || expr.op === '*' || expr.op === '%') {
      type =
        left.type === 'string'
          ? 'string'
          : left.type === 'number' && right.type === 'number'
            ? 'number'
            : isArrayType(left.type)
              ? left.type
              : 'any';
    } else {
      type =
        left.type === 'number' || right.type === 'number' ? 'number' : 'any';
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
    const value = this.lowerExpr(expr.argument, `${path}.value`, mode);
    if (mode === 'lazy') {
      return this.pureNode({
        kind: 'await',
        title: 'await',
        range,
        path,
        inputs: [
          { pin: this.dataIn('awaitable', '', rangeOf(expr.argument)), value },
        ],
        outType: 'any',
        compact: true,
      });
    }

    const pin = this.dataIn('awaitable', 'Awaitable', rangeOf(expr.argument));
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
}
