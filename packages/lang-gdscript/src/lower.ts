import type {
  DataType,
  Diagnostic,
  FunctionGraph,
  GraphDocument,
  GraphNode,
  InputSpec,
  InsertPoint,
  OutputPinMeta,
  ParseOptions,
  Pin,
  SourceRange,
  StatementMeta,
  ValueSource,
} from '@vizscript/core';
import {
  arrayElementType,
  arrayOf,
  arrayOfAll,
  attachComments,
  completeCallPins,
  functionIdCounter,
  GraphBuilderBase,
  isArrayType,
  lineEnd,
  lineIndent,
  linkImports,
  linkSymbolGraphs,
  markUnusedValue,
  truncate,
} from '@vizscript/core';
import type {
  Block,
  Expr,
  FuncDecl,
  IfStmt,
  Span,
  Stmt,
  TypeRef,
  VarDecl,
} from './ast';
import { parseGDScript } from './parser';
import { gdscriptSymbols } from './symbols';

export const LANGUAGE_ID = 'gdscript';

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

/** Element types of Godot's packed arrays. */
const PACKED_ARRAYS: Record<string, DataType> = {
  PackedByteArray: 'number',
  PackedInt32Array: 'number',
  PackedInt64Array: 'number',
  PackedFloat32Array: 'number',
  PackedFloat64Array: 'number',
  PackedStringArray: 'string',
  PackedVector2Array: 'Vector2',
  PackedVector3Array: 'Vector3',
  PackedVector4Array: 'Vector4',
  PackedColorArray: 'Color',
};

/** Maps a GDScript type to a pin type (colors and compatibility). */
export function dataTypeOf(ref: TypeRef | string | undefined): DataType {
  const name = typeof ref === 'string' ? ref : ref?.name;
  if (!name) {
    return 'any';
  }

  if (name === 'int' || name === 'float') {
    return 'number';
  }

  if (name === 'String' || name === 'StringName' || name === 'NodePath') {
    return 'string';
  }

  if (name === 'bool') {
    return 'bool';
  }

  if (name === 'void') {
    return 'void';
  }

  if (name === 'Variant') {
    return 'any';
  }

  if (name === 'Callable') {
    return 'function';
  }

  const typed = name.match(/^Array\[(.+)\]$/);
  if (typed) {
    return arrayOf(dataTypeOf(typed[1]));
  }

  const packed = PACKED_ARRAYS[name];
  if (packed) {
    return arrayOf(packed);
  }

  if (/^(Array|Packed\w+Array)\b/.test(name)) {
    return 'array';
  }

  if (/^Dictionary\b/.test(name)) {
    return 'object';
  }

  return name;
}

type EvalMode = 'eager' | 'lazy';

interface Signature {
  params: string[];
  returnType: DataType;
}

type GraphSource =
  | {
      type: 'class';
      name: string;
      body: Stmt[];
      subtitle: string;
      range: Span;
      /** Prefix of member function names (`Inner.` for inner classes). */
      prefix: string;
    }
  | { type: 'func'; name: string; kind: string; fn: FuncDecl };

function rangeOf(node: Span): SourceRange {
  return { start: node.start, end: node.end };
}

function unwrap(expr: Expr): Expr {
  let current = expr;
  while (current.type === 'Paren') {
    current = current.expr;
  }

  return current;
}

/** `a.b.c` style chains (including `self`, `super` and `$Node`). */
function simpleChain(expr: Expr, text: string): string[] | undefined {
  const e = unwrap(expr);
  switch (e.type) {
    case 'Identifier': {
      return [e.name];
    }

    case 'Self': {
      return ['self'];
    }

    case 'Super': {
      return ['super'];
    }

    case 'NodePath': {
      return [text.slice(e.start, e.end)];
    }

    case 'Attribute': {
      const head = simpleChain(e.object, text);
      return head ? [...head, e.name] : undefined;
    }

    default: {
      return undefined;
    }
  }
}

class DocumentLowering {
  public readonly functions: FunctionGraph[] = [];
  public readonly queue: GraphSource[] = [];
  public readonly signatures = new Map<string, Signature>();
  /** Types of the script's member variables and constants. */
  public readonly memberTypes = new Map<string, DataType>();
  private readonly fnIds = functionIdCounter();

  public constructor(
    public readonly text: string,
    public readonly fileName: string
  ) {}

  public uniqueFunctionId(name: string): string {
    return this.fnIds.next(name);
  }

  public run(
    body: Stmt[],
    className: string | undefined,
    extendsName: string | undefined
  ): void {
    for (const stmt of body) {
      if (stmt.type === 'Var') {
        const value = stmt.value ? unwrap(stmt.value) : undefined;
        const literal =
          value?.type === 'Literal'
            ? value.kind === 'int' || value.kind === 'float'
              ? 'number'
              : value.kind === 'bool'
                ? 'bool'
                : value.kind === 'null'
                  ? 'any'
                  : 'string'
            : 'any';
        this.memberTypes.set(
          stmt.name,
          stmt.typeRef ? dataTypeOf(stmt.typeRef) : literal
        );
      }

      if (stmt.type === 'Func' && stmt.name) {
        this.signatures.set(stmt.name, {
          params: stmt.params.map((p) => p.name),
          returnType: dataTypeOf(stmt.returnType),
        });
      }
    }

    const name = className ?? this.fileName.replace(/\.gd$/i, '');
    this.queue.push({
      type: 'class',
      name,
      body,
      subtitle: extendsName ? `extends ${extendsName}` : 'script',
      range: { start: 0, end: this.text.length },
      prefix: '',
    });
    for (let next = this.queue.shift(); next; next = this.queue.shift()) {
      new FnGraphBuilder(this, next).run();
    }
  }
}

/** Lowers one function (or the members of a class) into a FunctionGraph. */
class FnGraphBuilder extends GraphBuilderBase {
  private readonly name: string;

  public constructor(
    private readonly doc: DocumentLowering,
    private readonly source: GraphSource
  ) {
    super(doc.text, doc.uniqueFunctionId(source.name));
    this.name = source.name;
  }

  /** New statements go on a new line at the start of an indented block. */
  private blockInsert(block: Block | undefined): InsertPoint | undefined {
    const first = block?.body[0];
    if (!block || block.inline || !first) {
      return undefined;
    }

    return {
      at: lineEnd(this.text, block.colonEnd),
      indent: lineIndent(this.text, first.start),
      mode: 'after',
    };
  }

  private statementInsert(
    stmt: Span,
    inline: boolean
  ): InsertPoint | undefined {
    if (inline) {
      return undefined;
    }

    return {
      at: lineEnd(this.text, stmt.end),
      indent: lineIndent(this.text, stmt.start),
      mode: 'after',
    };
  }

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
      const subtitle = VIRTUAL_METHODS.has(shortName)
        ? 'event'
        : `${fn.isStatic ? 'static ' : ''}${source.kind}`;
      entry = this.addNode({
        kind: 'entry',
        title: source.name,
        subtitle,
        category: 'event',
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

  private literalType(expr: Expr): DataType {
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

  private queueFunction(name: string, kind: string, fn: FuncDecl): void {
    this.doc.queue.push({ type: 'func', name, kind, fn });
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

  private lowerBlock(block: Block, path: string): void {
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
        const arrayPin = this.dataIn(
          'array',
          'Array',
          rangeOf(stmt.iterable),
          'array'
        );
        const iterable = this.lowerExpr(
          stmt.iterable,
          `${path}.iterable`,
          'eager'
        );
        // `for x: T in` names the type; else it comes from a typed array.
        const elementType = stmt.variableType
          ? dataTypeOf(stmt.variableType)
          : arrayElementType(iterable.type);
        const node = this.addNode({
          kind: 'forEach',
          title: 'For Each',
          category: 'flow',
          purity: 'impure',
          range: rangeOf(stmt),
          pins: [
            this.execIn(),
            arrayPin,
            this.execOut('body', 'Loop Body', this.blockInsert(stmt.body)),
            this.dataOut('element', stmt.variable, elementType, {
              sourceText: stmt.variable,
            }),
            this.execOut(
              'completed',
              'Completed',
              this.statementInsert(stmt, inline),
              true
            ),
          ],
          path,
          meta: this.statementMeta(stmt, inline, sole),
        });
        this.feed(node.id, arrayPin, iterable);
        this.chain(node, 'body');
        this.withScope(() => {
          this.declare(stmt.variable, {
            source: { node: node.id, pin: 'element' },
            type: elementType,
          });
          this.lowerBlock(stmt.body, `${path}/body`);
        });
        this.cursor = { node: node.id, pin: 'completed' };
        return;
      }

      case 'While': {
        const condPin = this.dataIn(
          'condition',
          'Condition',
          rangeOf(stmt.test),
          'bool'
        );
        const condition = this.lowerExpr(stmt.test, `${path}.test`, 'lazy');
        const node = this.addNode({
          kind: 'loop',
          title: 'While Loop',
          category: 'flow',
          purity: 'impure',
          range: rangeOf(stmt),
          pins: [
            this.execIn(),
            condPin,
            this.execOut('body', 'Loop Body', this.blockInsert(stmt.body)),
            this.execOut(
              'completed',
              'Completed',
              this.statementInsert(stmt, inline),
              true
            ),
          ],
          path,
          meta: this.statementMeta(stmt, inline, sole),
        });
        this.feed(node.id, condPin, condition);
        this.chain(node, 'body');
        this.lowerBlock(stmt.body, `${path}/body`);
        this.cursor = { node: node.id, pin: 'completed' };
        return;
      }

      case 'Match': {
        const valuePin = this.dataIn('value', 'Value', rangeOf(stmt.subject));
        const value = this.lowerExpr(stmt.subject, `${path}.value`, 'eager');
        const pins: Pin[] = [this.execIn(), valuePin];
        for (const [index, branch] of stmt.branches.entries()) {
          pins.push(
            this.execOut(
              `case${index}`,
              truncate(this.src(rangeOf(branch.patterns)), 20),
              this.blockInsert(branch.body)
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
          title: 'Match',
          category: 'flow',
          purity: 'impure',
          range: rangeOf(stmt),
          pins,
          path,
          meta: this.statementMeta(stmt, inline, sole),
        });
        this.feed(node.id, valuePin, value);
        this.chain(node, null);
        for (const [index, branch] of stmt.branches.entries()) {
          this.cursor = { node: node.id, pin: `case${index}` };
          this.lowerBlock(branch.body, `${path}/case${index}`);
        }

        this.cursor = { node: node.id, pin: 'completed' };
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
        this.dataOut('out', '', type, { sourceText: stmt.name }),
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
        varName ? { sourceText: varName } : {}
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

  private lowerIf(
    stmt: IfStmt,
    path: string,
    inline: boolean,
    sole: boolean
  ): void {
    const branch = (
      test: Expr,
      body: Block,
      next: Block | undefined,
      span: Span,
      branchPath: string,
      isElif: boolean
    ): GraphNode => {
      const condPin = this.dataIn(
        'condition',
        'Condition',
        rangeOf(test),
        'bool'
      );
      const condition = this.lowerExpr(test, `${branchPath}.test`, 'eager');
      const pins: Pin[] = [
        this.execIn(),
        condPin,
        this.execOut('true', 'True', this.blockInsert(body)),
        this.execOut('false', 'False', this.blockInsert(next)),
      ];
      if (!isElif) {
        pins.push(
          this.execOut(
            'completed',
            'Completed',
            this.statementInsert(stmt, inline),
            true
          )
        );
      }

      const meta: StatementMeta = isElif
        ? { stmt: rangeOf(span), locked: true }
        : (this.statementMeta(stmt, inline, sole) as unknown as StatementMeta);
      const node = this.addNode({
        kind: 'branch',
        title: 'Branch',
        subtitle: isElif ? 'elif' : undefined,
        category: 'flow',
        purity: 'impure',
        range: rangeOf(span),
        pins,
        path: branchPath,
        meta: meta as unknown as Record<string, unknown>,
      });
      this.feed(node.id, condPin, condition);
      this.chain(node, 'true');
      this.lowerBlock(body, `${branchPath}/then`);
      this.cursor = { node: node.id, pin: 'false' };
      return node;
    };

    const parts = [
      { test: stmt.test, body: stmt.body, span: stmt as Span },
      ...stmt.elifs.map((e) => ({
        test: e.test,
        body: e.body,
        span: e as Span,
      })),
    ];
    let first: GraphNode | undefined;
    for (const [index, part] of parts.entries()) {
      const next = parts[index + 1]?.body ? undefined : stmt.orelse;
      const node = branch(
        part.test,
        part.body,
        next,
        part.span,
        index === 0 ? path : `${path}/elif${index}`,
        index > 0
      );
      first ??= node;
    }

    if (stmt.orelse) {
      this.lowerBlock(stmt.orelse, `${path}/else`);
    }

    if (first) {
      this.cursor = { node: first.id, pin: 'completed' };
    }
  }

  // ----------------------------------------------------------- expressions

  private lowerCall(
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

  private lowerExpr(
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

export function parseGDScriptDocument(
  text: string,
  fileName = 'script.gd',
  options: ParseOptions = {}
): GraphDocument {
  const { script, diagnostics, comments } = parseGDScript(text);
  const lowering = new DocumentLowering(
    text,
    fileName.split('/').at(-1) ?? fileName
  );
  lowering.run(script.body, script.className, script.extendsName);
  const doc: GraphDocument = {
    language: LANGUAGE_ID,
    functions: lowering.functions,
    diagnostics: diagnostics.map((d): Diagnostic => ({
      message: d.message,
      range: { start: d.start, end: d.end },
      severity: 'error',
    })),
    symbols: gdscriptSymbols(script.body, text),
  };
  attachComments(doc, text, comments);
  linkSymbolGraphs(doc);
  linkImports(doc, options.imports);
  completeCallPins(doc, text, {
    placeholder: 'null',
    imports: options.imports,
  });
  return doc;
}
