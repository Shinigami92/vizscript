import type {
  DataType,
  Diagnostic,
  FunctionGraph,
  GraphDocument,
  GraphNode,
  InputSpec,
  InsertPoint,
  OutputPinMeta,
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
  linkSymbolGraphs,
  markUnusedValue,
  truncate,
} from '@vizscript/core';
import type {
  Block,
  ClassDef,
  Expr,
  FunctionDef,
  IfStmt,
  Param,
  Span,
  Stmt,
} from './ast';
import { parsePython } from './convert';
import { pythonImports } from './imports';
import { pythonSymbols } from './symbols';

export const LANGUAGE_ID = 'python';

const COMPARISONS = new Set([
  '==',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  'in',
  'not in',
  'is',
  'is not',
]);

/** Maps a type annotation (as written) to a pin type. */
export function dataTypeOf(annotation: string | undefined): DataType {
  if (!annotation) {
    return 'any';
  }

  const type = annotation.replaceAll(/\s+/g, '');
  const optional = type.match(/^(?:Optional\[(.+)\]|(.+)\|None|None\|(.+))$/);
  if (optional) {
    return dataTypeOf(optional[1] ?? optional[2] ?? optional[3]);
  }

  if (/^(int|float|complex|Decimal)$/.test(type)) {
    return 'number';
  }

  if (/^(str|LiteralString)$/.test(type)) {
    return 'string';
  }

  if (type === 'bool') {
    return 'bool';
  }

  if (type === 'None') {
    return 'void';
  }

  if (type === 'Any' || type === 'object') {
    return 'any';
  }

  // `list[int]`, `Sequence[Item]`, `tuple[str, ...]` → typed arrays.
  const generic = type.match(
    /^(?:list|List|Sequence|Iterable|Iterator|set|Set|frozenset|(?:collections\.abc\.)?\w*Sequence)\[(.+)\]$/
  );
  if (generic) {
    return arrayOf(dataTypeOf(generic[1]));
  }

  const homogeneous = type.match(/^(?:tuple|Tuple)\[(.+),\.\.\.\]$/);
  if (homogeneous) {
    return arrayOf(dataTypeOf(homogeneous[1]));
  }

  if (
    /^(list|List|tuple|Tuple|Sequence|Iterable|Iterator|set|Set|frozenset)\b/.test(
      type
    )
  ) {
    return 'array';
  }

  if (/^(dict|Dict|Mapping|MutableMapping|TypedDict)\b/.test(type)) {
    return 'object';
  }

  if (/^(Callable|collections\.abc\.Callable)\b/.test(type)) {
    return 'function';
  }

  return type.split('[')[0] ?? type;
}

interface Signature {
  params: string[];
  returnType: DataType;
}

interface LambdaSource {
  params: Param[];
  body: Expr;
  start: number;
  end: number;
}

type GraphSource =
  | { type: 'module'; body: Stmt[] }
  | { type: 'class'; name: string; cls: ClassDef }
  | {
      type: 'function';
      name: string;
      kind: string;
      fn: FunctionDef | LambdaSource;
    };

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

/** `a.b.c` style chains. */
function simpleChain(expr: Expr): string[] | undefined {
  const e = unwrap(expr);
  if (e.type === 'Name') {
    return [e.name];
  }

  if (e.type === 'Attribute') {
    const head = simpleChain(e.object);
    return head ? [...head, e.name] : undefined;
  }

  return undefined;
}

/** Statements that only declare things (no exec node in the graph). */
function isDeclarationOnly(stmt: Stmt): boolean {
  return (
    stmt.type === 'Import' ||
    stmt.type === 'Scope' ||
    stmt.type === 'Pass' ||
    stmt.type === 'FunctionDef' ||
    stmt.type === 'ClassDef' ||
    // Docstrings
    (stmt.type === 'Expr' && unwrap(stmt.value).type === 'Literal')
  );
}

class DocumentLowering {
  public readonly functions: FunctionGraph[] = [];
  public readonly queue: GraphSource[] = [];
  public readonly signatures = new Map<string, Signature>();
  /** Types of module-level variables (from annotations or literals). */
  public readonly globals = new Map<string, DataType>();
  private readonly ids = functionIdCounter();

  public constructor(
    public readonly text: string,
    public readonly fileName: string
  ) {}

  public uniqueFunctionId(name: string): string {
    return this.ids.next(name);
  }

  public run(body: Stmt[]): void {
    const collect = (stmts: ReadonlyArray<Stmt>, prefix: string): void => {
      for (const stmt of stmts) {
        if (stmt.type === 'FunctionDef') {
          this.signatures.set(`${prefix}${stmt.name}`, {
            params: stmt.params
              .map((p) => p.name)
              .filter((name) => name !== 'self' && name !== 'cls'),
            returnType: dataTypeOf(
              stmt.returns
                ? this.text.slice(stmt.returns.start, stmt.returns.end)
                : undefined
            ),
          });
        } else if (stmt.type === 'ClassDef') {
          this.signatures.set(`${prefix}${stmt.name}`, {
            params: [],
            returnType: stmt.name,
          });
          collect(stmt.body.body, `${prefix}${stmt.name}.`);
        }
      }
    };

    collect(body, '');
    for (const stmt of body) {
      const target = stmt.type === 'Assign' ? stmt.targets[0] : undefined;
      if (
        stmt.type !== 'Assign' ||
        stmt.targets.length !== 1 ||
        target?.type !== 'Name'
      ) {
        continue;
      }

      const value = stmt.value ? unwrap(stmt.value) : undefined;
      const type = stmt.annotation
        ? dataTypeOf(
            this.text.slice(stmt.annotation.start, stmt.annotation.end)
          )
        : value?.type === 'Literal' &&
            (value.kind === 'int' || value.kind === 'float')
          ? 'number'
          : value?.type === 'Literal' && value.kind === 'string'
            ? 'string'
            : value?.type === 'Literal' && value.kind === 'bool'
              ? 'bool'
              : 'any';
      if (type !== 'any') {
        this.globals.set(target.name, type);
      }
    }

    this.queue.push({ type: 'module', body });
    for (let next = this.queue.shift(); next; next = this.queue.shift()) {
      new FnGraphBuilder(this, next).run();
    }
  }
}

class FnGraphBuilder extends GraphBuilderBase {
  private readonly name: string;
  /** `self.method()` calls resolve against this class. */
  private readonly className: string | undefined;

  public constructor(
    private readonly doc: DocumentLowering,
    private readonly source: GraphSource
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

  // ---------------------------------------------------------------- inserts

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

  // ----------------------------------------------------------------- graphs

  public run(): void {
    const source = this.source;
    let range: SourceRange;
    if (source.type === 'module') {
      range = { start: 0, end: this.text.length };
      this.runModule(source.body);
    } else if (source.type === 'class') {
      range = rangeOf(source.cls);
      this.runClass(source.name, source.cls);
    } else {
      range = rangeOf(source.fn);
      this.runFunction(source.name, source.kind, source.fn);
    }

    this.doc.functions.push({
      id: this.fnId,
      name: this.name,
      range,
      ...this.graph(),
    });
  }

  private runModule(body: Stmt[]): void {
    const firstExecutable = body.find((s) => !isDeclarationOnly(s));
    const entry = this.addNode({
      kind: 'entry',
      title: 'Module',
      subtitle: this.doc.fileName,
      category: 'event',
      purity: 'impure',
      range: { start: 0, end: 0 },
      pins: [
        this.execOut(
          'then',
          '',
          firstExecutable
            ? { at: firstExecutable.start, indent: '', mode: 'before' }
            : undefined
        ),
      ],
      path: 'entry',
      idText: 'entry|Module',
    });
    this.cursor = { node: entry.id, pin: 'then' };
    this.lowerStatements(body, 'body', false, false);
  }

  private runClass(name: string, cls: ClassDef): void {
    const bases = cls.bases.map((b) => this.src(rangeOf(b))).join(', ');
    const entry = this.addNode({
      kind: 'entry',
      title: name,
      subtitle: [
        bases ? `class (${truncate(bases, 30)})` : 'class',
        ...cls.decorators.map((d) => truncate(this.src(rangeOf(d)), 20)),
      ].join(' '),
      category: 'event',
      purity: 'impure',
      range: { start: cls.start, end: cls.body.start },
      pins: [this.execOut('then', '', this.blockInsert(cls.body))],
      path: 'entry',
      idText: `entry|${name}`,
    });
    this.cursor = { node: entry.id, pin: 'then' };
    this.lowerBlock(cls.body, 'body');
  }

  private runFunction(
    name: string,
    kind: string,
    fn: FunctionDef | LambdaSource
  ): void {
    const isDef = 'type' in fn;
    const subtitle = isDef
      ? [
          fn.isAsync ? 'async' : '',
          kind,
          ...fn.decorators.map((d) => truncate(this.src(rangeOf(d)), 20)),
        ]
          .filter(Boolean)
          .join(' ')
      : kind;
    const entryPins: Pin[] = [
      this.execOut('then', '', isDef ? this.blockInsert(fn.body) : undefined),
    ];
    const entry = this.addNode({
      kind: 'entry',
      title: name,
      subtitle,
      category: 'event',
      purity: 'impure',
      range: { start: fn.start, end: fn.body.start },
      pins: entryPins,
      path: 'entry',
      idText: `entry|${name}`,
    });
    for (const [index, param] of fn.params.entries()) {
      const type = this.paramType(param);
      const bare = param.name.replace(/^\*+/, '');
      const pinId = `param${index}`;
      entryPins.push(
        this.dataOut(
          pinId,
          param.name,
          type,
          { sourceText: bare },
          rangeOf(param)
        )
      );
      this.declare(bare, { source: { node: entry.id, pin: pinId }, type });
    }

    this.cursor = { node: entry.id, pin: 'then' };
    if (isDef) {
      this.lowerBlock(fn.body, 'body');
      return;
    }

    // Lambda: its body expression is returned.
    const value = this.lowerExpr(fn.body, 'body/0', 'eager');
    const pin = this.dataIn('value', '', rangeOf(fn.body));
    const node = this.addNode({
      kind: 'return',
      title: 'Return',
      category: 'return',
      purity: 'impure',
      range: rangeOf(fn.body),
      pins: [this.execIn(), pin],
      path: 'body/0',
    });
    this.feed(node.id, pin, value);
    this.chain(node, null);
  }

  private paramType(param: Param): DataType {
    if (param.name.startsWith('**')) {
      return 'object';
    }

    if (param.name.startsWith('*')) {
      return 'array';
    }

    if (param.annotation) {
      return dataTypeOf(this.src(rangeOf(param.annotation)));
    }

    if (param.name === 'self' || param.name === 'cls') {
      return this.className ?? 'object';
    }

    return param.defaultValue ? this.literalType(param.defaultValue) : 'any';
  }

  private literalType(expr: Expr): DataType {
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

  private queueFunction(name: string, kind: string, fn: FunctionDef): void {
    this.doc.queue.push({ type: 'function', name, kind, fn });
  }

  private prefix(): string {
    return this.source.type === 'class' ? `${this.source.name}.` : '';
  }

  // ------------------------------------------------------------- statements

  private lowerStatements(
    stmts: ReadonlyArray<Stmt>,
    path: string,
    inline: boolean,
    sole: boolean
  ): void {
    this.withScope(() => {
      for (const [index, stmt] of stmts.entries()) {
        this.lowerStatement(stmt, `${path}/${index}`, inline, sole);
      }
    });
  }

  private lowerBlock(block: Block, path: string): void {
    const sole = !block.inline && block.body.length === 1;
    this.lowerStatements(block.body, path, block.inline, sole);
  }

  private lowerStatement(
    stmt: Stmt,
    path: string,
    inline: boolean,
    sole: boolean
  ): void {
    this.currentStatement = rangeOf(stmt);
    const meta = this.statementMeta(rangeOf(stmt), inline, sole);
    const insert = this.statementInsert(stmt, inline);
    switch (stmt.type) {
      case 'FunctionDef': {
        this.queueFunction(
          `${this.prefix()}${stmt.name}`,
          this.source.type === 'class' ? 'method' : 'def',
          stmt
        );
        return;
      }

      case 'ClassDef': {
        this.queueClass(`${this.prefix()}${stmt.name}`, stmt);
        return;
      }

      case 'Import':
      case 'Scope':
      case 'Pass': {
        return;
      }

      case 'Expr': {
        this.lowerExpressionStatement(stmt, stmt.value, path, meta, insert);
        return;
      }

      case 'Assign': {
        this.lowerAssign(stmt, path, meta, insert);
        return;
      }

      case 'AugAssign': {
        const chain = simpleChain(stmt.target);
        const name =
          chain?.join('.') ?? truncate(this.src(rangeOf(stmt.target)), 24);
        const value = this.lowerExpr(stmt.value, `${path}.value`, 'eager');
        this.simpleNode(stmt, path, meta, insert, {
          kind: 'setVar',
          title: `Set ${name}`,
          subtitle: stmt.op,
          category: 'function',
          inputs: [
            { pin: this.dataIn('value', '', rangeOf(stmt.value)), value },
          ],
          outputs: [
            this.dataOut(
              'out',
              '',
              value.type,
              chain ? { sourceText: name } : {}
            ),
          ],
        });
        return;
      }

      case 'If': {
        this.lowerIf(stmt, path, meta, insert);
        return;
      }

      case 'For': {
        this.lowerFor(stmt, path, meta, insert);
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
        const pins: Pin[] = [
          this.execIn(),
          condPin,
          this.execOut('body', 'Loop Body', this.blockInsert(stmt.body)),
        ];
        if (stmt.orelse) {
          pins.push(
            this.execOut('else', 'Else', this.blockInsert(stmt.orelse))
          );
        }

        pins.push(this.execOut('completed', 'Completed', insert, true));
        const node = this.addNode({
          kind: 'loop',
          title: 'While Loop',
          category: 'flow',
          purity: 'impure',
          range: rangeOf(stmt),
          pins,
          path,
          meta,
        });
        this.feed(node.id, condPin, condition);
        this.chain(node, 'body');
        this.lowerBlock(stmt.body, `${path}/body`);
        if (stmt.orelse) {
          this.cursor = { node: node.id, pin: 'else' };
          this.lowerBlock(stmt.orelse, `${path}/else`);
        }

        this.cursor = { node: node.id, pin: 'completed' };
        return;
      }

      case 'With': {
        this.lowerWith(stmt, path, meta, insert);
        return;
      }

      case 'Try': {
        this.lowerTry(stmt, path, meta, insert);
        return;
      }

      case 'Match': {
        const valuePin = this.dataIn('value', 'Subject', rangeOf(stmt.subject));
        const value = this.lowerExpr(stmt.subject, `${path}.value`, 'eager');
        const pins: Pin[] = [this.execIn(), valuePin];
        for (const [i, kase] of stmt.cases.entries()) {
          pins.push(
            this.execOut(
              `case${i}`,
              truncate(this.src(rangeOf(kase.pattern)), 20),
              this.blockInsert(kase.body)
            )
          );
        }

        pins.push(this.execOut('completed', 'Completed', insert, true));
        const node = this.addNode({
          kind: 'switch',
          title: 'Match',
          category: 'flow',
          purity: 'impure',
          range: rangeOf(stmt),
          pins,
          path,
          meta,
        });
        this.feed(node.id, valuePin, value);
        this.chain(node, null);
        for (const [i, kase] of stmt.cases.entries()) {
          this.cursor = { node: node.id, pin: `case${i}` };
          this.lowerBlock(kase.body, `${path}/case${i}`);
        }

        this.cursor = { node: node.id, pin: 'completed' };
        return;
      }

      case 'Return':
      case 'Raise': {
        const isReturn = stmt.type === 'Return';
        const valueExpr = isReturn ? stmt.value : stmt.exception;
        const valuePin = valueExpr
          ? this.dataIn(
              isReturn ? 'value' : 'error',
              isReturn ? '' : 'Exception',
              rangeOf(valueExpr),
              'any',
              isReturn ? { optional: true } : undefined
            )
          : isReturn
            ? // `return`: a value can be wired in after the keyword.
              this.dataIn('value', '', undefined, 'any', {
                insertInitAt: rangeOf(stmt).start + 'return'.length,
                insertPrefix: ' ',
              })
            : undefined;
        const value = valueExpr
          ? this.lowerExpr(valueExpr, `${path}.value`, 'eager')
          : undefined;
        const node = this.addNode({
          kind: isReturn ? 'return' : 'throw',
          title: isReturn ? 'Return' : 'Raise',
          category: isReturn ? 'return' : 'flow',
          purity: 'impure',
          range: rangeOf(stmt),
          pins: valuePin ? [this.execIn(), valuePin] : [this.execIn()],
          path,
          meta,
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
          meta,
        });
        this.chain(node, null);
        return;
      }

      case 'Assert': {
        const inputs: InputSpec[] = [
          {
            pin: this.dataIn(
              'condition',
              'Condition',
              rangeOf(stmt.test),
              'bool'
            ),
            value: this.lowerExpr(stmt.test, `${path}.test`, 'eager'),
          },
        ];
        if (stmt.message) {
          inputs.push({
            pin: this.dataIn('message', 'Message', rangeOf(stmt.message)),
            value: this.lowerExpr(stmt.message, `${path}.message`, 'eager'),
          });
        }

        this.simpleNode(stmt, path, meta, insert, {
          kind: 'call',
          title: 'Assert',
          category: 'function',
          inputs,
        });
        return;
      }

      case 'Delete': {
        const targets = stmt.targets.map((t) => this.src(rangeOf(t)));
        this.simpleNode(stmt, path, meta, insert, {
          kind: 'setVar',
          title: `Delete ${truncate(targets.join(', '), 24)}`,
          category: 'function',
          inputs: [],
        });
        return;
      }

      case 'Yield': {
        const inputs: InputSpec[] = stmt.value
          ? [
              {
                pin: this.dataIn('value', '', rangeOf(stmt.value)),
                value: this.lowerExpr(stmt.value, `${path}.value`, 'eager'),
              },
            ]
          : [];
        this.simpleNode(stmt, path, meta, insert, {
          kind: 'await',
          title: 'Yield',
          category: 'latent',
          inputs,
        });
        return;
      }

      case 'Error': {
        this.simpleNode(stmt, path, meta, insert, {
          kind: 'unknown',
          title: truncate(this.src(rangeOf(stmt)), 32),
          subtitle: 'Syntax error',
          category: 'unknown',
          inputs: [],
        });
      }
    }
  }

  /** Classes with only methods get no graph of their own. */
  private queueClass(name: string, cls: ClassDef): void {
    if (cls.body.body.some((s) => !isDeclarationOnly(s))) {
      this.doc.queue.push({ type: 'class', name, cls });
      return;
    }

    for (const member of cls.body.body) {
      if (member.type === 'FunctionDef') {
        this.queueFunction(`${name}.${member.name}`, 'method', member);
      } else if (member.type === 'ClassDef') {
        this.queueClass(`${name}.${member.name}`, member);
      }
    }
  }

  /** An exec-chained node with `exec`/`then` pins plus the given inputs. */
  private simpleNode(
    stmt: Span,
    path: string,
    meta: Record<string, unknown>,
    insert: InsertPoint | undefined,
    options: {
      kind: GraphNode['kind'];
      title: string;
      subtitle?: string;
      category: GraphNode['category'];
      inputs: InputSpec[];
      outputs?: Pin[];
    }
  ): GraphNode {
    const node = this.addNode({
      kind: options.kind,
      title: options.title,
      subtitle: options.subtitle,
      category: options.category,
      purity: 'impure',
      range: rangeOf(stmt),
      pins: [
        this.execIn(),
        this.execOut('then', '', insert),
        ...options.inputs.map((i) => i.pin),
        ...(options.outputs ?? []),
      ],
      path,
      meta,
    });
    this.feedAll(node.id, options.inputs);
    this.chain(node);
    return node;
  }

  private lowerExpressionStatement(
    stmt: Span,
    rawValue: Expr,
    path: string,
    meta: Record<string, unknown>,
    insert: InsertPoint | undefined
  ): void {
    const value = unwrap(rawValue);
    if (value.type === 'Literal' && value.kind === 'string') {
      return; // docstring
    }

    if (value.type === 'Call') {
      this.lowerCall(value, path, 'statement', { meta, insert, stmt });
      return;
    }

    if (value.type === 'Await') {
      const awaited = this.lowerExpr(value.argument, `${path}.value`, 'eager');
      const pin = this.dataIn(
        'awaitable',
        'Awaitable',
        rangeOf(value.argument)
      );
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
              expr: rangeOf(value),
              stmt: rangeOf(stmt),
              isStatement: true,
              nameHint: 'result',
            },
          }),
        ],
        path,
        meta,
      });
      this.feed(node.id, pin, awaited);
      this.chain(node);
      return;
    }

    const before = this.nodes.length;
    const evaluated = this.lowerExpr(value, `${path}.value`, 'lazy');
    if (markUnusedValue(this.nodes, before, evaluated, meta)) {
      return;
    }

    this.simpleNode(stmt, path, meta, insert, {
      kind: 'unknown',
      title: 'Evaluate',
      category: 'unknown',
      inputs: [
        { pin: this.dataIn('value', '', rangeOf(value)), value: evaluated },
      ],
    });
  }

  private lowerAssign(
    stmt: Extract<Stmt, { type: 'Assign' }>,
    path: string,
    meta: Record<string, unknown>,
    insert: InsertPoint | undefined
  ): void {
    const targets = stmt.targets.map((t) => unwrap(t));
    const first = targets.length === 1 ? targets[0] : undefined;
    const declared = stmt.annotation
      ? dataTypeOf(this.src(rangeOf(stmt.annotation)))
      : 'any';
    const value = stmt.value ? unwrap(stmt.value) : undefined;

    if (value?.type === 'Lambda' && first?.type === 'Name') {
      // `f = lambda x: ...` defines a function graph.
      this.doc.queue.push({
        type: 'function',
        name: `${this.prefix()}${first.name}`,
        kind: 'lambda',
        fn: {
          params: value.params,
          body: value.body,
          start: value.start,
          end: value.end,
        },
      });
    }

    const inputs: InputSpec[] = [];
    let title: string;
    let varName: string | undefined;
    const chain = first ? simpleChain(first) : undefined;
    const rootWired =
      chain?.[0] !== undefined && this.lookup(chain[0])?.source !== undefined;
    if (chain && !(rootWired && chain.length > 1 && chain[0] !== 'self')) {
      varName = chain.join('.');
      title = `Set ${varName}`;
    } else if (first?.type === 'Attribute') {
      title = `Set .${first.name}`;
      inputs.push({
        pin: this.dataIn('target', 'Target', rangeOf(first.object), 'object'),
        value: this.lowerExpr(first.object, `${path}.target`, 'eager'),
      });
    } else if (first?.type === 'Subscript') {
      const sliced = first.index.type === 'Opaque';
      title = sliced
        ? `Set [${truncate(this.src(rangeOf(first.index)), 12)}]`
        : 'Set [ ]';
      inputs.push({
        pin: this.dataIn('target', 'Target', rangeOf(first.object), 'object'),
        value: this.lowerExpr(first.object, `${path}.target`, 'eager'),
      });
      if (!sliced) {
        inputs.push({
          pin: this.dataIn('key', 'Key', rangeOf(first.index)),
          value: this.lowerExpr(first.index, `${path}.key`, 'eager'),
        });
      }
    } else {
      title = `Set ${truncate(targets.map((t) => this.src(rangeOf(t))).join(' = '), 28)}`;
    }

    const valuePin = this.dataIn(
      'value',
      '',
      value ? rangeOf(value) : undefined,
      declared,
      value
        ? undefined
        : { insertInitAt: stmt.annotation?.end ?? targets[0]?.end ?? stmt.end }
    );
    const lowered = value
      ? this.lowerExpr(value, `${path}.value`, 'eager', varName)
      : undefined;
    inputs.push({ pin: valuePin, value: lowered });
    const type = declared === 'any' ? (lowered?.type ?? 'any') : declared;
    this.simpleNode(stmt, path, meta, insert, {
      kind: 'setVar',
      title,
      subtitle: stmt.annotation
        ? `: ${this.src(rangeOf(stmt.annotation))}`
        : undefined,
      category: 'function',
      inputs,
      outputs: [
        this.dataOut('out', '', type, varName ? { sourceText: varName } : {}),
      ],
    });
    if (valuePin.type === 'any') {
      valuePin.type = type;
    }

    if (first?.type === 'Name') {
      this.declare(first.name, { type });
    }
  }

  private lowerIf(
    stmt: IfStmt,
    path: string,
    meta: Record<string, unknown>,
    insert: InsertPoint | undefined
  ): void {
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
      const isElif = index > 0;
      const next = parts[index + 1] ? undefined : stmt.orelse;
      const branchPath = isElif ? `${path}/elif${index}` : path;
      const condPin = this.dataIn(
        'condition',
        'Condition',
        rangeOf(part.test),
        'bool'
      );
      const condition = this.lowerExpr(
        part.test,
        `${branchPath}.test`,
        'eager'
      );
      const pins: Pin[] = [
        this.execIn(),
        condPin,
        this.execOut('true', 'True', this.blockInsert(part.body)),
        this.execOut('false', 'False', this.blockInsert(next)),
      ];
      if (!isElif) {
        pins.push(this.execOut('completed', 'Completed', insert, true));
      }

      const elifMeta: StatementMeta = {
        stmt: rangeOf(part.span),
        locked: true,
      };
      const node = this.addNode({
        kind: 'branch',
        title: 'Branch',
        subtitle: isElif ? 'elif' : undefined,
        category: 'flow',
        purity: 'impure',
        range: rangeOf(part.span),
        pins,
        path: branchPath,
        meta: isElif ? (elifMeta as unknown as Record<string, unknown>) : meta,
      });
      this.feed(node.id, condPin, condition);
      this.chain(node, 'true');
      this.lowerBlock(part.body, `${branchPath}/then`);
      this.cursor = { node: node.id, pin: 'false' };
      first ??= node;
    }

    if (stmt.orelse) {
      this.lowerBlock(stmt.orelse, `${path}/else`);
    }

    if (first) {
      this.cursor = { node: first.id, pin: 'completed' };
    }
  }

  private lowerFor(
    stmt: Extract<Stmt, { type: 'For' }>,
    path: string,
    meta: Record<string, unknown>,
    insert: InsertPoint | undefined
  ): void {
    const iterPin = this.dataIn(
      'array',
      'Iterable',
      rangeOf(stmt.iter),
      'array'
    );
    const iterable = this.lowerExpr(stmt.iter, `${path}.iter`, 'eager');
    const target = unwrap(stmt.target);
    const elementName = this.src(rangeOf(target));
    const elementType =
      target.type === 'Name' ? arrayElementType(iterable.type) : 'any';
    const pins: Pin[] = [
      this.execIn(),
      iterPin,
      this.execOut('body', 'Loop Body', this.blockInsert(stmt.body)),
      this.dataOut('element', truncate(elementName, 20), elementType, {
        sourceText: elementName,
      }),
    ];
    if (stmt.orelse) {
      pins.push(this.execOut('else', 'Else', this.blockInsert(stmt.orelse)));
    }

    pins.push(this.execOut('completed', 'Completed', insert, true));
    const node = this.addNode({
      kind: 'forEach',
      title: 'For Each',
      subtitle: stmt.isAsync ? 'async' : undefined,
      category: 'flow',
      purity: 'impure',
      range: rangeOf(stmt),
      pins,
      path,
      meta,
    });
    this.feed(node.id, iterPin, iterable);
    this.chain(node, 'body');
    this.withScope(() => {
      // `for x in ...` wires x; tuple targets stay readable getters.
      if (target.type === 'Name') {
        this.declare(target.name, {
          source: { node: node.id, pin: 'element' },
          type: elementType,
        });
      }

      this.lowerBlock(stmt.body, `${path}/body`);
    });
    if (stmt.orelse) {
      this.cursor = { node: node.id, pin: 'else' };
      this.lowerBlock(stmt.orelse, `${path}/else`);
    }

    this.cursor = { node: node.id, pin: 'completed' };
  }

  private lowerWith(
    stmt: Extract<Stmt, { type: 'With' }>,
    path: string,
    meta: Record<string, unknown>,
    insert: InsertPoint | undefined
  ): void {
    const many = stmt.items.length > 1;
    const inputs: InputSpec[] = stmt.items.map((item, i) => ({
      pin: this.dataIn(
        `context${i}`,
        many ? `Context ${i + 1}` : 'Context',
        rangeOf(item.context)
      ),
      value: this.lowerExpr(item.context, `${path}.context${i}`, 'eager'),
    }));
    const outputs: Pin[] = [];
    for (const [i, item] of stmt.items.entries()) {
      if (item.target) {
        const name = this.src(rangeOf(item.target));
        outputs.push(this.dataOut(`as${i}`, name, 'any', { sourceText: name }));
      }
    }

    const node = this.addNode({
      kind: 'try',
      title: 'With',
      subtitle: stmt.isAsync ? 'async' : undefined,
      category: 'flow',
      purity: 'impure',
      range: rangeOf(stmt),
      pins: [
        this.execIn(),
        ...inputs.map((i) => i.pin),
        this.execOut('body', 'Body', this.blockInsert(stmt.body)),
        ...outputs,
        this.execOut('completed', 'Completed', insert, true),
      ],
      path,
      meta,
    });
    this.feedAll(node.id, inputs);
    this.chain(node, 'body');
    this.withScope(() => {
      for (const [i, item] of stmt.items.entries()) {
        const target = item.target ? unwrap(item.target) : undefined;
        if (target?.type === 'Name') {
          this.declare(target.name, {
            source: { node: node.id, pin: `as${i}` },
            type: 'any',
          });
        }
      }

      this.lowerBlock(stmt.body, `${path}/body`);
    });
    this.cursor = { node: node.id, pin: 'completed' };
  }

  private lowerTry(
    stmt: Extract<Stmt, { type: 'Try' }>,
    path: string,
    meta: Record<string, unknown>,
    insert: InsertPoint | undefined
  ): void {
    const pins: Pin[] = [
      this.execIn(),
      this.execOut('try', 'Try', this.blockInsert(stmt.body)),
    ];
    for (const [i, handler] of stmt.handlers.entries()) {
      const exception = handler.exception
        ? this.src(rangeOf(handler.exception))
        : undefined;
      pins.push(
        this.execOut(
          `except${i}`,
          exception ? `Except ${truncate(exception, 18)}` : 'Except',
          this.blockInsert(handler.body)
        )
      );
      if (handler.name) {
        pins.push(
          this.dataOut(
            `error${i}`,
            handler.name,
            exception && /^\w+$/.test(exception) ? exception : 'any',
            { sourceText: handler.name }
          )
        );
      }
    }

    if (stmt.orelse) {
      pins.push(this.execOut('else', 'Else', this.blockInsert(stmt.orelse)));
    }

    if (stmt.finalbody) {
      pins.push(
        this.execOut('finally', 'Finally', this.blockInsert(stmt.finalbody))
      );
    }

    pins.push(this.execOut('completed', 'Completed', insert, true));
    const node = this.addNode({
      kind: 'try',
      title: 'Try',
      category: 'flow',
      purity: 'impure',
      range: rangeOf(stmt),
      pins,
      path,
      meta,
    });
    this.chain(node, 'try');
    this.lowerBlock(stmt.body, `${path}/try`);
    for (const [i, handler] of stmt.handlers.entries()) {
      this.cursor = { node: node.id, pin: `except${i}` };
      this.withScope(() => {
        if (handler.name) {
          this.declare(handler.name, {
            source: { node: node.id, pin: `error${i}` },
            type: 'any',
          });
        }

        this.lowerBlock(handler.body, `${path}/except${i}`);
      });
    }

    if (stmt.orelse) {
      this.cursor = { node: node.id, pin: 'else' };
      this.lowerBlock(stmt.orelse, `${path}/else`);
    }

    if (stmt.finalbody) {
      this.cursor = { node: node.id, pin: 'finally' };
      this.lowerBlock(stmt.finalbody, `${path}/finally`);
    }

    this.cursor = { node: node.id, pin: 'completed' };
  }

  // ------------------------------------------------------------ expressions

  private lowerCall(
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

    const returnType: DataType = signature?.returnType ?? 'any';
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

  private lowerExpr(
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

  private lowerLiteral(
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

  private lowerBinary(
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

  private lowerAwait(
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

export function parsePythonDocument(
  text: string,
  fileName = 'script.py'
): GraphDocument {
  const { body, diagnostics, comments } = parsePython(text);
  const lowering = new DocumentLowering(
    text,
    fileName.split('/').at(-1) ?? fileName
  );
  lowering.run(body);
  const doc: GraphDocument = {
    language: LANGUAGE_ID,
    functions: lowering.functions,
    diagnostics: diagnostics.map((d): Diagnostic => ({
      message: d.message,
      range: { start: d.start, end: d.end },
      severity: 'error',
    })),
    symbols: [...pythonImports(text), ...pythonSymbols(body, text)],
  };
  attachComments(doc, text, comments);
  linkSymbolGraphs(doc);
  completeCallPins(doc, text, { placeholder: 'None', keywordArguments: true });
  return doc;
}
