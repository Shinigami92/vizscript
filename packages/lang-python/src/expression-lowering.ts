import {
  conversionCall,
  elementAccess,
  findContainerOp,
  findContainerOperator,
  isTypeConstant,
  lastIndexValue,
  markContainerCandidate,
  styleContainerValue,
} from '@vizscript/core';
import type {
  DataType,
  InputPinMeta,
  InputSpec,
  InsertPoint,
  OutputPinMeta,
  Pin,
  ValueSource,
} from '@vizscript/core';
import {
  arrayOfAll,
  CHAIN_OPERATORS,
  chainPinId,
  flattenChain,
  formatLiteral,
  GraphBuilderBase,
  isArrayType,
  truncate,
} from '@vizscript/core';
import type { Expr, Span } from './ast';
import { PYTHON_CONTAINER_OPS } from './container-ops';
import { CONVERSIONS } from './conversions';
import type { DocumentContext, GraphSource, Signature } from './lower-utils';
import { COMPARISONS, rangeOf, simpleChain, unwrap } from './lower-utils';

/** The type of `left op right`. */
function binaryType(
  op: string,
  logical: boolean,
  left: DataType,
  right: DataType
): DataType {
  if (COMPARISONS.has(op)) {
    return 'bool';
  }

  if (logical) {
    return left === right ? left : 'any';
  }

  if (op === '+' || op === '*' || op === '%') {
    return left === 'string'
      ? 'string'
      : left === 'number' && right === 'number'
        ? 'number'
        : isArrayType(left)
          ? left
          : 'any';
  }

  return left === 'number' || right === 'number' ? 'number' : 'any';
}

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
    // A free call gets an unwired `self` that writes `value.` before the
    // function's name (UE's Target pin); classes (constructors) get none.
    let freeTarget: Pin | undefined;
    if (chain) {
      signature =
        root === 'self' && this.className
          ? this.doc.signatures.get(
              `${this.className}.${chain.slice(1).join('.')}`
            )
          : this.doc.signatures.get(chain.join('.'));
    }

    if (chain?.length === 1) {
      title = chain[0] ?? '';
      if (!/^[A-Z]/.test(title)) {
        freeTarget = this.dataIn('target', 'self', undefined, 'object', {
          insertInitAt: rangeOf(callee).start,
          insertPrefix: '',
          insertSuffix: '.',
        });
      }
    } else if (callee.type === 'Attribute') {
      title = callee.name;
      inputs.push({
        pin: this.dataIn('target', 'self', rangeOf(callee.object), 'object'),
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
      // `*args` values are named by their parameter (`args[0]`) later.
      const param = arg.keyword || arg.star ? undefined : positional++;
      const named = param === undefined ? '' : (signature?.params[param] ?? '');
      // An argument passed by name is named after its parameter.
      const label = arg.keyword ?? (named.startsWith('*') ? '' : named);
      // `*args` can be one value again, a positional one spread (`**` and
      // keywords stay as they are).
      const meta: InputPinMeta =
        arg.keyword !== undefined
          ? { keyword: arg.keyword }
          : arg.star === '**'
            ? { spread: '**' }
            : arg.star === '*'
              ? { spread: '*', spreadable: '*' }
              : { spreadable: '*' };
      inputs.push({
        pin: this.dataIn(`arg${i}`, label, rangeOf(arg.value), 'any', meta),
        value: this.lowerExpr(
          arg.value,
          `${path}.arg${i}`,
          evalMode,
          `${chain?.join('.') ?? title} callback`
        ),
      });
    }

    // `str(x)`: a pure compact node, like UE's autocast.
    const converts =
      mode === 'statement'
        ? undefined
        : conversionCall(CONVERSIONS, title, inputs.length);
    const returnType: DataType = converts ?? signature?.returnType ?? 'any';
    // UE's container nodes (LENGTH, ADD …): a known operation on a typed
    // list, dict or set (`items.append(x)`, `len(items)`); reads are pure.
    const method = callee.type === 'Attribute';
    const container =
      (method || freeTarget) && expr.args.every((a) => !a.keyword && !a.star)
        ? inputs[0]
        : undefined;
    const op = container
      ? findContainerOp(
          PYTHON_CONTAINER_OPS,
          method ? 'method' : 'function',
          title,
          container.value?.type,
          method ? expr.args.length : expr.args.length - 1
        )
      : undefined;
    if (freeTarget && converts === undefined) {
      inputs.unshift({ pin: freeTarget, value: undefined });
    }

    // `String()`: its value goes into the parentheses once it is given.
    if (converts !== undefined && inputs.length === 0) {
      inputs.push({
        pin: this.dataIn('arg0', '', undefined, 'any', {
          insertInitAt: rangeOf(expr).end - 1,
          insertPrefix: '',
        }),
        value: undefined,
      });
    }

    const impure =
      mode !== 'pure' &&
      converts === undefined &&
      (op === undefined || op.mutates === true || mode === 'statement');
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
    // Its container typed only later (`pythonTypes`): `applyTypes` makes it
    // a container node then.
    if (container && !op && converts === undefined) {
      markContainerCandidate(node, {
        form: method ? 'method' : 'function',
        name: title,
        args: method ? expr.args.length : expr.args.length - 1,
        pin: container.pin.id,
        statement: mode === 'statement',
        code: this.src(rangeOf(expr)),
      });
    }

    if (impure) {
      this.chain(node);
    }

    const value: ValueSource = {
      pin: { node: node.id, pin: 'return' },
      type: returnType,
    };
    return op && container?.value
      ? styleContainerValue(
          this.nodes,
          value,
          op,
          container.value.type,
          container.pin.id
        )
      : value;
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
        // UE's Format pin first: the text between the quotes, edited on
        // the node.
        const quoted = expr.format.match(/^[A-Za-z]*("""|'''|"|')([\s\S]*)\1$/);
        return this.pureNode({
          kind: 'template',
          title: 'Format Text',
          range,
          path,
          inputs: [
            {
              pin: this.dataIn('format', 'Format', undefined, 'string', {
                format: true,
              }),
              value: {
                literal: formatLiteral(quoted?.[2] ?? expr.format),
                type: 'string',
              },
            },
            ...expr.parts.map((part, i) => ({
              pin: this.dataIn(`part${i}`, `{${i}}`, rangeOf(part)),
              value: this.lowerExpr(part, `${path}.part${i}`, mode),
            })),
          ],
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
        // A member of the own object is a variable (`self.items`); other
        // reads are a Get of the object and its property (`math` → `.pi`).
        const chain = simpleChain(expr);
        if (
          chain?.length === 2 &&
          (chain[0] === 'self' || isTypeConstant(chain))
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
        const target = this.lowerExpr(expr.object, `${path}.target`, mode);
        if (sliced) {
          return this.pureNode({
            kind: 'getProperty',
            title: `[${truncate(this.src(rangeOf(expr.index)), 12)}]`,
            range,
            path,
            inputs: [
              {
                pin: this.dataIn(
                  'target',
                  '',
                  rangeOf(expr.object),
                  elementAccess(target.type).targetType
                ),
                value: target,
              },
            ],
            outType: 'any',
            compact: true,
          });
        }

        // UE's GET node: the container, the index, the element.
        const access = elementAccess(target.type);
        return this.pureNode({
          kind: 'getProperty',
          title: access.title,
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
              pin: this.dataIn('key', '', rangeOf(expr.index), access.keyType),
              value: this.lowerExpr(expr.index, `${path}.key`, mode),
            },
          ],
          outType: access.outType,
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
            pin:
              item.type === 'Starred'
                ? this.dataIn(`e${i}`, '', rangeOf(item.value), 'any', {
                    spread: '*',
                    spreadable: '*',
                  })
                : this.dataIn(`e${i}`, `[${i}]`, rangeOf(item), 'any', {
                    spreadable: '*',
                  }),
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
              ? ''
              : key.type === 'Literal' && key.kind === 'string'
                ? key.value
                : truncate(this.src(rangeOf(key)), 16);
            const property = key
              ? {
                  start: rangeOf(entry.key ?? key).start,
                  end: rangeOf(entry.value).end,
                }
              : undefined;
            return {
              pin: this.dataIn(
                `p${i}`,
                label,
                rangeOf(entry.value),
                'any',
                property ? { property } : { spread: '**' }
              ),
              value: this.lowerExpr(
                entry.value,
                `${path}.p${i}`,
                mode,
                `${nameHint ?? 'dict'}.${label || '**'}`
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

    // UE draws `x not in items` as CONTAINS wired into NOT.
    const notIn =
      expr.op === 'not in'
        ? this.notInValue({
            ops: PYTHON_CONTAINER_OPS,
            range: rangeOf(expr),
            path,
            operands: operands.map((operand, index) => ({
              range: rangeOf(operand),
              value: values[index] as ValueSource,
            })),
          })
        : undefined;
    if (notIn) {
      return notIn;
    }

    // UE's LAST INDEX: `len(items) - 1` is one node.
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
    // UE's container nodes: `x in items` is CONTAINS, `a | b` of sets UNION.
    const found = findContainerOperator(
      PYTHON_CONTAINER_OPS,
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
      PYTHON_CONTAINER_OPS.some(
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
