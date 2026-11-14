import type {
  DataType,
  InputSpec,
  InsertPoint,
  OutputPinMeta,
  Pin,
  SourceRange,
  ValueSource,
} from '@vizscript/core';
import {
  arrayOf,
  arrayOfAll,
  GraphBuilderBase,
  truncate,
} from '@vizscript/core';
import type { Expr, Span } from './ast';
import { dataTypeOf } from './data-type';
import type { GraphSource, LoweringContext, Signature } from './lower-utils';
import { rangeOf, simpleChain, unwrap } from './lower-utils';

/** Macros that only build a value (shown as pure nodes). */
const VALUE_MACROS = new Set(['format', 'vec', 'format_args', 'concat']);

/** Macros whose first argument is a format string. */
const FORMAT_MACROS = new Set([
  'println',
  'print',
  'eprintln',
  'eprint',
  'format',
  'format_args',
  'panic',
  'todo',
  'unimplemented',
  'unreachable',
]);

/**
 * The base of `FnGraphBuilder`: calls and macros. Expressions, control flow
 * and statements build on it, one layer per file.
 */
export abstract class CallLowering extends GraphBuilderBase {
  protected readonly name: string;
  /** `self.method()` calls resolve against this type. */
  protected readonly owner: string | undefined;

  public constructor(
    protected readonly doc: LoweringContext,
    protected readonly source: GraphSource
  ) {
    const name = source.type === 'module' ? 'Module' : source.name;
    super(doc.text, doc.uniqueFunctionId(name));
    this.name = name;
    this.owner = source.type === 'function' ? source.owner : undefined;
  }

  protected abstract lowerExpr(
    rawExpr: Expr,
    path: string,
    mode: 'eager' | 'lazy',
    nameHint?: string
  ): ValueSource;

  protected queueClosure(
    name: string,
    closure: Extract<Expr, { type: 'Closure' }>
  ): void {
    this.doc.queue.push({
      type: 'function',
      name,
      kind: closure.isAsync ? 'async closure' : 'closure',
      ...(this.owner ? { owner: this.owner } : {}),
      fn: {
        params: closure.params,
        body: closure.body,
        ...(closure.returns ? { returns: closure.returns } : {}),
        start: closure.start,
        end: closure.end,
      },
    });
  }

  // ------------------------------------------------------------------ calls

  protected callTitle(
    callee: Expr,
    path: string,
    evalMode: 'eager' | 'lazy',
    inputs: InputSpec[]
  ): { title: string; signature?: Signature; chain?: string[] } {
    const chain = simpleChain(callee);
    if (chain?.length === 1) {
      // `total(items)`; paths (`Item::new`, `Self::check`) and tuple
      // structs (`Some(x)`) are not called on a value.
      const title = chain[0] ?? '';
      const signature = this.doc.signatures.get(
        title.replace(/^Self::/, `${this.owner ?? 'Self'}::`)
      );
      if (!title.includes('::') && !/^[A-Z]/.test(title)) {
        // An unwired `self` that writes `value.` before the name.
        inputs.push({
          pin: this.dataIn('target', 'self', undefined, 'object', {
            insertInitAt: rangeOf(callee).start,
            insertPrefix: '',
            insertSuffix: '.',
          }),
          value: undefined,
        });
      }

      return { title, ...(signature ? { signature } : {}), chain };
    }

    if (callee.type === 'Field') {
      // `self.save()`: a method of the own type.
      const onSelf = chain?.length === 2 && chain[0] === 'self';
      const signature =
        onSelf && this.owner
          ? this.doc.signatures.get(`${this.owner}::${callee.name}`)
          : undefined;
      inputs.push({
        pin: this.dataIn('target', 'self', rangeOf(callee.object), 'object'),
        value: this.lowerExpr(callee.object, `${path}.target`, evalMode),
      });
      return {
        title: callee.name,
        ...(signature ? { signature } : {}),
        ...(chain ? { chain } : {}),
      };
    }

    inputs.push({
      pin: this.dataIn('function', 'Function', rangeOf(callee), 'function'),
      value: this.lowerExpr(callee, `${path}.callee`, evalMode),
    });
    return { title: 'Call' };
  }

  protected lowerCall(
    expr: Extract<Expr, { type: 'Call' } | { type: 'Macro' }>,
    path: string,
    mode: 'statement' | 'hoist' | 'pure',
    statement?: {
      meta: Record<string, unknown>;
      insert: InsertPoint | undefined;
      stmt: Span;
      /** `?` or `.await` after the call. */
      suffix?: string;
    }
  ): ValueSource {
    const evalMode = mode === 'pure' ? 'lazy' : 'eager';
    const inputs: InputSpec[] = [];
    let title: string;
    let signature: Signature | undefined;
    let nameHint = 'value';
    let calleeChain: string[] | undefined;
    let args: Expr[];
    if (expr.type === 'Macro') {
      const bare = expr.name.split('::').at(-1) ?? expr.name;
      title = `${expr.name}!`;
      nameHint = bare;
      args = expr.args ?? [];
      if (!expr.args && expr.close > expr.open) {
        // Tokens that aren't expressions (`matches!(x, Some(_))`).
        title = `${expr.name}!`;
      }
    } else {
      const callee = this.callTitle(
        unwrap(expr.callee),
        path,
        evalMode,
        inputs
      );
      title = callee.title;
      calleeChain = callee.chain;
      signature = callee.signature;
      nameHint = callee.chain?.at(-1) ?? 'value';
      args = expr.args;
    }

    const isFormat =
      expr.type === 'Macro' &&
      FORMAT_MACROS.has(expr.name.split('::').at(-1) ?? '');
    for (const [i, arg] of args.entries()) {
      const label = isFormat
        ? i === 0
          ? 'Format'
          : `{${i - 1}}`
        : (signature?.params[i] ?? '');
      inputs.push({
        pin: this.dataIn(`arg${i}`, label === '_' ? '' : label, rangeOf(arg)),
        value: this.lowerExpr(
          arg,
          `${path}.arg${i}`,
          evalMode,
          `${expr.type === 'Macro' ? title : (calleeChain?.join('.') ?? title)} callback`
        ),
      });
    }

    // `String::new()`, `Vec::with_capacity(n)`: a value of the type.
    const constructed = title.match(
      /^(?:\w+::)*([A-Z]\w*)::(?:new|default|from|with_capacity)$/
    )?.[1];
    const returnType: DataType =
      statement?.suffix === '?'
        ? 'any'
        : (signature?.returnType ??
          (expr.type === 'Macro'
            ? this.macroType(expr)
            : constructed
              ? dataTypeOf(
                  constructed === 'Vec' ? 'Vec<_>' : constructed,
                  this.owner
                )
              : 'any'));
    const impure = mode !== 'pure';
    const pins: Pin[] = impure
      ? [this.execIn(), this.execOut('then', '', statement?.insert)]
      : [];
    pins.push(...inputs.map((i) => i.pin));
    const outMeta: OutputPinMeta = impure
      ? {
          bind: {
            expr: statement?.suffix ? rangeOf(statement.stmt) : rangeOf(expr),
            stmt: this.currentStatement ?? rangeOf(expr),
            isStatement: mode === 'statement',
            nameHint,
          },
        }
      : { sourceText: this.src(rangeOf(expr)) };
    if (returnType !== 'void') {
      pins.push(this.dataOut('return', '', returnType, outMeta, rangeOf(expr)));
    }

    const node = this.addNode({
      kind: 'call',
      title,
      subtitle: statement?.suffix,
      category: impure ? 'function' : 'pure',
      purity: impure ? 'impure' : 'pure',
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

  protected macroType(expr: Extract<Expr, { type: 'Macro' }>): DataType {
    const bare = expr.name.split('::').at(-1) ?? expr.name;
    if (
      /^(?:e?print(?:ln)?|assert\w*|debug_assert\w*|write(?:ln)?)$/.test(bare)
    ) {
      return bare.startsWith('write') ? 'any' : 'void';
    }

    if (bare === 'format' || bare === 'concat' || bare === 'stringify') {
      return 'string';
    }

    return 'any';
  }

  protected makeArray(
    items: Expr[],
    repeat: boolean,
    label: string,
    range: SourceRange,
    path: string,
    mode: 'eager' | 'lazy'
  ): ValueSource {
    const inputs: InputSpec[] = repeat
      ? items.slice(0, 2).map((item, i) => ({
          pin: this.dataIn(
            `e${i}`,
            i === 0 ? 'Value' : 'Count',
            rangeOf(item),
            i === 0 ? 'any' : 'number'
          ),
          value: this.lowerExpr(item, `${path}.e${i}`, mode),
        }))
      : items.map((item, i) => ({
          pin: this.dataIn(`e${i}`, `[${i}]`, rangeOf(item)),
          value: this.lowerExpr(item, `${path}.e${i}`, mode),
        }));
    const element = repeat
      ? arrayOf(inputs[0]?.value?.type ?? 'any')
      : arrayOfAll(inputs.map((i) => i.value?.type ?? 'any'));
    return this.pureNode({
      kind: 'makeArray',
      title: `Make ${label}`,
      subtitle: repeat ? 'repeat' : undefined,
      range,
      path,
      inputs,
      outType: element,
      outName: label,
    });
  }

  protected lowerMacroValue(
    expr: Extract<Expr, { type: 'Macro' }>,
    path: string,
    mode: 'eager' | 'lazy',
    nameHint: string | undefined
  ): ValueSource {
    const bare = expr.name.split('::').at(-1) ?? expr.name;
    const range = rangeOf(expr);
    if (bare === 'todo' && (expr.args?.length ?? 0) === 0) {
      // The placeholder of an empty input (like `undefined` in TypeScript)
      // is an inline value, not a call, and says nothing about the type.
      const raw = this.src(range);
      return this.literal('undefined', raw, raw, 'any');
    }

    if (bare === 'vec' && expr.args) {
      return this.makeArray(
        expr.args,
        expr.repeat === true,
        'Vec',
        range,
        path,
        mode
      );
    }

    if ((bare === 'format' || bare === 'format_args') && expr.args) {
      const [format, ...rest] = expr.args;
      const formatText =
        format && unwrap(format).type === 'Literal'
          ? this.src(rangeOf(format))
          : '';
      return this.pureNode({
        kind: 'template',
        title: 'Format Text',
        subtitle: truncate(formatText, 32),
        range,
        path,
        inputs: [
          ...(format
            ? [
                {
                  pin: this.dataIn(
                    'format',
                    'Format',
                    rangeOf(format),
                    'string'
                  ),
                  value: this.lowerExpr(format, `${path}.format`, mode),
                },
              ]
            : []),
          ...rest.map((part, i) => ({
            pin: this.dataIn(`part${i}`, `{${i}}`, rangeOf(part)),
            value: this.lowerExpr(part, `${path}.part${i}`, mode, nameHint),
          })),
        ],
        outType: 'string',
        outName: 'Result',
      });
    }

    if (VALUE_MACROS.has(bare) || !expr.args) {
      return this.pureNode({
        kind: 'unknown',
        title: truncate(this.src(range).replaceAll(/\s+/g, ' '), 32),
        subtitle: 'macro',
        range,
        path,
        inputs: [],
        outType: 'any',
        category: 'unknown',
      });
    }

    return this.lowerCall(expr, path, mode === 'eager' ? 'hoist' : 'pure');
  }
}
