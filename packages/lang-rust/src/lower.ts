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
  inferTypes,
  isArrayType,
  lineIndent,
  linkImports,
  linkSymbolGraphs,
  markUnusedValue,
  truncate,
} from '@vizscript/core';
import type {
  Block,
  Expr,
  FunctionItem,
  IfStmt,
  Item,
  MatchStmt,
  Param,
  Pattern,
  Span,
  Stmt,
  ValueItem,
} from './ast';
import { parseRust } from './convert';
import { rustImports } from './imports';
import { rustSymbols } from './symbols';

export const LANGUAGE_ID = 'rust';

const COMPARISONS = new Set(['==', '!=', '<', '<=', '>', '>=']);
const NUMBER = /^(?:[iu](?:8|16|32|64|128|size)|f32|f64)$/;

/** Splits `A, B<C, D>` at top-level commas. */
function splitTypes(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '<' || char === '(' || char === '[') {
      depth++;
    } else if (char === '>' || char === ')' || char === ']') {
      depth--;
    } else if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  if (current.trim() !== '') {
    parts.push(current);
  }

  return parts;
}

/** Maps a type as written (`&mut Vec<Item>`) to a pin type. */
export function dataTypeOf(
  annotation: string | undefined,
  self?: string
): DataType {
  if (!annotation) {
    return 'any';
  }

  let type = annotation.replaceAll(/\s+/g, ' ').trim();
  // References, raw pointers and lifetimes don't change the value.
  for (;;) {
    const stripped = type
      .replace(/^&\s*(?:'\w+\s*)?(?:mut\s+)?/, '')
      .replace(/^\*\s*(?:const|mut)\s+/, '')
      .replace(/^(?:dyn|impl)\s+(?=(?:Fn|FnMut|FnOnce)\b)/, '');
    if (stripped === type) {
      break;
    }

    type = stripped;
  }

  type = type.replaceAll(' ', '');
  if (type === '()' || type === '!') {
    return 'void';
  }

  if (NUMBER.test(type)) {
    return 'number';
  }

  if (type === 'bool') {
    return 'bool';
  }

  if (/^(?:String|str|char|(?:std::borrow::)?Cow<(?:'\w+,)?str>)$/.test(type)) {
    return 'string';
  }

  if (type === 'Self') {
    return self ?? 'Self';
  }

  const generic = type.match(/^((?:\w+::)*\w+)<(.*)>$/);
  const name = generic?.[1]?.split('::').at(-1);
  const args = generic ? splitTypes(generic[2] ?? '') : [];
  if (name === 'Option' || name === 'Box' || name === 'Rc' || name === 'Arc') {
    return dataTypeOf(args[0], self);
  }

  if (
    name &&
    /^(?:Vec|VecDeque|HashSet|BTreeSet|LinkedList|BinaryHeap)$/.test(name)
  ) {
    return arrayOf(dataTypeOf(args[0], self));
  }

  if (name && /^(?:HashMap|BTreeMap|IndexMap)$/.test(name)) {
    return 'object';
  }

  const slice = type.match(/^\[(.+?)(?:;.+)?\]$/);
  if (slice) {
    return arrayOf(dataTypeOf(slice[1], self));
  }

  if (/^(?:Fn|FnMut|FnOnce)\(|^fn\(/.test(type)) {
    return 'function';
  }

  if (type.startsWith('(')) {
    return 'array';
  }

  const bare = (type.split('<')[0] ?? type).split('::').at(-1) ?? type;
  return bare === 'Self' ? (self ?? 'Self') : bare;
}

interface Signature {
  params: string[];
  returnType: DataType;
}

interface ClosureSource {
  params: Param[];
  body: Expr | Block;
  returns?: Span;
  start: number;
  end: number;
}

type GraphSource =
  | { type: 'module'; items: ValueItem[] }
  | {
      type: 'function';
      name: string;
      kind: string;
      /** Type of `self` (the impl's type). */
      owner?: string;
      fn: FunctionItem | ClosureSource;
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

/** `a.b.c` and `a::b` chains (no calls). */
function simpleChain(expr: Expr): string[] | undefined {
  const e = unwrap(expr);
  if (e.type === 'Name') {
    return [e.name];
  }

  if (e.type === 'Field') {
    const head = simpleChain(e.object);
    return head ? [...head, e.name] : undefined;
  }

  return undefined;
}

/** Expressions that end in a block (no `;` needed as a statement). */
function isBlock(body: Block | Expr): body is Block {
  return 'body' in body && 'open' in body && !('type' in body);
}

/** The value of a block that is just one expression (`{ a }`). */
function only(block: Block | undefined): Expr | undefined {
  const [first] = block?.body ?? [];
  return block?.body.length === 1 && first?.type === 'Expr' && !first.semicolon
    ? first.value
    : undefined;
}

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

class DocumentLowering {
  public readonly functions: FunctionGraph[] = [];
  public readonly queue: GraphSource[] = [];
  public readonly signatures = new Map<string, Signature>();
  /** Types of constants and statics. */
  public readonly globals = new Map<string, DataType>();
  private readonly ids = functionIdCounter();

  public constructor(
    public readonly text: string,
    public readonly fileName: string
  ) {}

  public uniqueFunctionId(name: string): string {
    return this.ids.next(name);
  }

  private signature(fn: FunctionItem, owner?: string): Signature {
    return {
      params: fn.params.map((p) => p.name ?? '_'),
      returnType: fn.returns
        ? dataTypeOf(this.text.slice(fn.returns.start, fn.returns.end), owner)
        : 'void',
    };
  }

  /** Functions of a module (and its inline modules), queued as graphs. */
  private collect(items: ReadonlyArray<Item>, prefix: string): void {
    for (const item of items) {
      switch (item.type) {
        case 'Function': {
          this.signatures.set(`${prefix}${item.name}`, this.signature(item));
          if (item.body) {
            this.queue.push({
              type: 'function',
              name: `${prefix}${item.name}`,
              kind: 'fn',
              fn: item,
            });
          }

          break;
        }

        case 'Impl':
        case 'Trait': {
          const owner = item.type === 'Impl' ? item.target : item.name;
          for (const member of item.items) {
            if (member.type !== 'Function') {
              continue;
            }

            const name = `${prefix}${owner}::${member.name}`;
            this.signatures.set(name, this.signature(member, owner));
            if (member.body) {
              this.queue.push({
                type: 'function',
                name,
                kind: member.self ? 'method' : 'associated fn',
                owner,
                fn: member,
              });
            }
          }

          break;
        }

        case 'Mod': {
          if (item.items) {
            this.collect(item.items, `${prefix}${item.name}::`);
          }

          break;
        }

        case 'Const':
        case 'Static': {
          const type = item.valueType
            ? dataTypeOf(
                this.text.slice(item.valueType.start, item.valueType.end)
              )
            : 'any';
          if (type !== 'any') {
            this.globals.set(item.name, type);
          }

          break;
        }

        default: {
          break;
        }
      }
    }
  }

  public run(items: Item[]): void {
    this.collect(items, '');
    const values = items.filter(
      (i): i is ValueItem => i.type === 'Const' || i.type === 'Static'
    );
    if (values.length > 0) {
      this.queue.unshift({ type: 'module', items: values });
    }

    for (let next = this.queue.shift(); next; next = this.queue.shift()) {
      new FnGraphBuilder(this, next).run();
    }
  }
}

class FnGraphBuilder extends GraphBuilderBase {
  private readonly name: string;
  /** `self.method()` calls resolve against this type. */
  private readonly owner: string | undefined;
  /** The function's value is its last expression (`-> T`). */
  private returnsValue = false;

  public constructor(
    private readonly doc: DocumentLowering,
    private readonly source: GraphSource
  ) {
    const name = source.type === 'module' ? 'Module' : source.name;
    super(doc.text, doc.uniqueFunctionId(name));
    this.name = name;
    this.owner = source.type === 'function' ? source.owner : undefined;
  }

  // ---------------------------------------------------------------- inserts

  private blockInsert(block: Block | undefined): InsertPoint | undefined {
    if (!block || block.open >= block.close) {
      return undefined;
    }

    const first = block.body[0];
    const indent = first
      ? lineIndent(this.text, first.start)
      : `${lineIndent(this.text, block.start)}    `;
    return { at: block.open, indent, mode: 'after' };
  }

  private statementInsert(stmt: Stmt): InsertPoint | undefined {
    // A value without `;` (the block's value) can't be followed.
    if (stmt.type === 'Expr' && !stmt.semicolon) {
      return undefined;
    }

    return {
      at: stmt.end,
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
      this.runModule(source.items);
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

  /** Constants and statics, like the variables of a module. */
  private runModule(items: ValueItem[]): void {
    const entry = this.addNode({
      kind: 'entry',
      title: 'Module',
      subtitle: this.doc.fileName,
      category: 'event',
      purity: 'impure',
      range: { start: 0, end: 0 },
      pins: [this.execOut('then', '')],
      path: 'entry',
      idText: 'entry|Module',
    });
    this.cursor = { node: entry.id, pin: 'then' };
    for (const [index, item] of items.entries()) {
      const path = `body/${index}`;
      this.currentStatement = rangeOf(item);
      const declared = item.valueType
        ? dataTypeOf(this.src(rangeOf(item.valueType)))
        : 'any';
      const valuePin = this.dataIn(
        'value',
        '',
        item.value ? rangeOf(item.value) : undefined,
        declared
      );
      const value = item.value
        ? this.lowerExpr(item.value, `${path}.value`, 'eager', item.name)
        : undefined;
      const type = declared === 'any' ? (value?.type ?? 'any') : declared;
      const keyword = item.type === 'Const' ? 'const' : 'static';
      const node = this.addNode({
        kind: 'setVar',
        title: `Set ${item.name}`,
        subtitle: [
          ...item.modifiers,
          keyword,
          ...(item.mutable ? ['mut'] : []),
        ].join(' '),
        category: 'function',
        purity: 'impure',
        range: rangeOf(item),
        pins: [
          this.execIn(),
          this.execOut('then', ''),
          valuePin,
          this.dataOut('out', '', type, { sourceText: item.name }),
        ],
        path,
        meta: {
          ...this.statementMeta(rangeOf(item), false),
          declares: [item.name],
        },
      });
      this.feed(node.id, valuePin, value);
      this.chain(node);
    }
  }

  private runFunction(
    name: string,
    kind: string,
    fn: FunctionItem | ClosureSource
  ): void {
    const isItem = 'type' in fn;
    const body = isItem ? fn.body : isBlock(fn.body) ? fn.body : undefined;
    const subtitle = isItem
      ? [...fn.modifiers.filter((m) => m !== 'pub'), kind].join(' ')
      : kind;
    const returns = fn.returns ? this.src(rangeOf(fn.returns)) : undefined;
    this.returnsValue = isItem
      ? returns !== undefined && dataTypeOf(returns) !== 'void'
      : returns === undefined || dataTypeOf(returns) !== 'void';
    const entryPins: Pin[] = [this.execOut('then', '', this.blockInsert(body))];
    const entry = this.addNode({
      kind: 'entry',
      title: name.split('::').at(-1) ?? name,
      subtitle: name.includes('::')
        ? `${subtitle} of ${name.split('::').slice(0, -1).join('::')}`
        : subtitle,
      // Like UE's purple function entry.
      category: 'entry',
      purity: 'impure',
      range: {
        start: isItem ? fn.headStart : fn.start,
        end: body ? body.start : fn.start,
      },
      pins: entryPins,
      path: 'entry',
      idText: `entry|${name}`,
    });
    if (isItem && fn.self) {
      const type = this.owner ?? 'Self';
      entryPins.push(
        this.dataOut(
          'self',
          'self',
          type,
          { sourceText: 'self' },
          rangeOf(fn.self)
        )
      );
      this.declare('self', { source: { node: entry.id, pin: 'self' }, type });
    }

    for (const [index, param] of fn.params.entries()) {
      const type = param.type
        ? dataTypeOf(this.src(rangeOf(param.type)), this.owner)
        : 'any';
      const pinId = `param${index}`;
      const label = param.name ?? this.src(rangeOf(param.pattern));
      entryPins.push(
        this.dataOut(
          pinId,
          label,
          type,
          { sourceText: param.name ?? label },
          rangeOf(param)
        )
      );
      if (param.name) {
        this.declare(param.name, {
          source: { node: entry.id, pin: pinId },
          type,
        });
      }
    }

    this.cursor = { node: entry.id, pin: 'then' };
    if (body) {
      this.lowerBlock(body, 'body', this.returnsValue);
      return;
    }

    if (!isItem && !isBlock(fn.body)) {
      // `|x| x + 1`: its expression is returned.
      this.implicitReturn(fn.body, 'body/0', rangeOf(fn.body));
    }
  }

  // ------------------------------------------------------------- statements

  private lowerBlock(block: Block, path: string, tail: boolean): void {
    this.withScope(() => {
      const last = block.body.length - 1;
      for (const [index, stmt] of block.body.entries()) {
        this.lowerStatement(stmt, `${path}/${index}`, tail && index === last);
      }
    });
  }

  private lowerStatement(stmt: Stmt, path: string, tail: boolean): void {
    this.currentStatement = rangeOf(stmt);
    const meta = this.statementMeta(rangeOf(stmt), false);
    if (
      tail &&
      this.returnsValue &&
      (stmt.type === 'If' || stmt.type === 'Match')
    ) {
      // The function's value: deleting it leaves `todo!()`.
      meta['tail'] = true;
    }

    const insert = this.statementInsert(stmt);
    switch (stmt.type) {
      case 'Item': {
        if (stmt.item.type === 'Function' && stmt.item.body) {
          this.doc.queue.push({
            type: 'function',
            name: stmt.item.name,
            kind: 'fn',
            fn: stmt.item,
          });
        }

        return;
      }

      case 'Empty': {
        return;
      }

      case 'Let': {
        this.lowerLet(stmt, path, meta, insert);
        return;
      }

      case 'Assign': {
        this.lowerAssign(stmt, path, meta, insert);
        return;
      }

      case 'Expr': {
        if (tail && !stmt.semicolon && this.returnsValue) {
          this.implicitReturn(stmt.value, path, rangeOf(stmt));
          return;
        }

        this.lowerExpressionStatement(stmt, stmt.value, path, meta, insert);
        return;
      }

      case 'If': {
        this.lowerIf(stmt, path, meta, insert, tail);
        return;
      }

      case 'Match': {
        this.lowerMatch(stmt, path, meta, insert, tail);
        return;
      }

      case 'For': {
        this.lowerFor(stmt, path, meta, insert);
        return;
      }

      case 'While': {
        this.lowerWhile(stmt, path, meta, insert);
        return;
      }

      case 'Loop': {
        const node = this.addNode({
          kind: 'loop',
          title: 'Loop',
          subtitle: stmt.label,
          category: 'flow',
          purity: 'impure',
          range: rangeOf(stmt),
          pins: [
            this.execIn(),
            this.execOut('body', 'Loop Body', this.blockInsert(stmt.body)),
            this.execOut('completed', 'Completed', insert, true),
          ],
          path,
          meta,
        });
        this.chain(node, 'body');
        this.lowerBlock(stmt.body, `${path}/body`, false);
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
              insertInitAt: stmt.start + 'return'.length,
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
          pins: [this.execIn(), valuePin],
          path,
          meta,
        });
        this.feed(node.id, valuePin, value);
        this.chain(node, null);
        return;
      }

      case 'Break':
      case 'Continue': {
        const isBreak = stmt.type === 'Break';
        const pins: Pin[] = [this.execIn()];
        const value =
          isBreak && stmt.value
            ? this.lowerExpr(stmt.value, `${path}.value`, 'eager')
            : undefined;
        const valuePin =
          isBreak && stmt.value
            ? this.dataIn('value', '', rangeOf(stmt.value))
            : undefined;
        if (valuePin) {
          pins.push(valuePin);
        }

        const node = this.addNode({
          kind: isBreak ? 'break' : 'continue',
          title: isBreak ? 'Break' : 'Continue',
          subtitle: stmt.label,
          category: 'flow',
          purity: 'impure',
          range: rangeOf(stmt),
          pins,
          path,
          meta,
        });
        if (valuePin) {
          this.feed(node.id, valuePin, value);
        }

        this.chain(node, null);
        return;
      }

      case 'BlockStmt': {
        // `unsafe { … }` and `{ … }`: their statements run in place.
        this.lowerBlock(stmt.block, `${path}/block`, tail);
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

  /** The function's value: a Return node for the last expression. */
  private implicitReturn(expr: Expr, path: string, range: SourceRange): void {
    const value = unwrap(expr);
    if (value.type === 'If') {
      this.lowerIf(
        value.stmt,
        path,
        this.statementMeta(range, false),
        undefined,
        true
      );
      return;
    }

    if (value.type === 'Match') {
      this.lowerMatch(
        value.stmt,
        path,
        this.statementMeta(range, false),
        undefined,
        true
      );
      return;
    }

    if (value.type === 'Block' && value.label === '') {
      this.lowerBlock(value.block, `${path}/block`, true);
      return;
    }

    this.currentStatement = range;
    const lowered = this.lowerExpr(expr, `${path}.value`, 'eager');
    const pin = this.dataIn('value', '', rangeOf(expr));
    const node = this.addNode({
      kind: 'return',
      title: 'Return',
      subtitle: 'value',
      category: 'return',
      purity: 'impure',
      range,
      pins: [this.execIn(), pin],
      path,
      meta: this.statementMeta(range, false),
    });
    this.feed(node.id, pin, lowered);
    this.chain(node, null);
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
    if (value.type === 'Call' || value.type === 'Macro') {
      this.lowerCall(value, path, 'statement', { meta, insert, stmt });
      return;
    }

    if (value.type === 'Try' || value.type === 'Await') {
      // `send()?;` and `run().await;`: the call is the statement.
      const inner = unwrap(value.value);
      if (inner.type === 'Call' || inner.type === 'Macro') {
        this.lowerCall(inner, path, 'statement', {
          meta,
          insert,
          stmt,
          suffix: value.type === 'Try' ? '?' : '.await',
        });
        return;
      }
    }

    if (value.type === 'If') {
      this.lowerIf(value.stmt, path, meta, insert, false);
      return;
    }

    if (value.type === 'Match') {
      this.lowerMatch(value.stmt, path, meta, insert, false);
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

  private lowerLet(
    stmt: Extract<Stmt, { type: 'Let' }>,
    path: string,
    meta: Record<string, unknown>,
    insert: InsertPoint | undefined
  ): void {
    const name = stmt.pattern.simple;
    const declared = stmt.valueType
      ? dataTypeOf(this.src(rangeOf(stmt.valueType)), this.owner)
      : 'any';
    const value = stmt.value ? unwrap(stmt.value) : undefined;
    if (value?.type === 'Closure' && name) {
      this.queueClosure(name, value);
    }

    const valuePin = this.dataIn(
      'value',
      '',
      stmt.value ? rangeOf(stmt.value) : undefined,
      declared,
      stmt.value
        ? undefined
        : { insertInitAt: stmt.valueType?.end ?? stmt.pattern.end }
    );
    const lowered = stmt.value
      ? this.lowerExpr(stmt.value, `${path}.value`, 'eager', name)
      : undefined;
    const type = declared === 'any' ? (lowered?.type ?? 'any') : declared;
    const title = name
      ? `Set ${name}`
      : `Set ${truncate(this.src(rangeOf(stmt.pattern)), 28)}`;
    const outputs: Pin[] = name
      ? [this.dataOut('out', '', type, { sourceText: name })]
      : stmt.pattern.bindings.map((b, i) =>
          this.dataOut(`out${i}`, b.name, 'any', { sourceText: b.name })
        );
    const pins: Pin[] = [
      this.execIn(),
      this.execOut('then', '', insert),
      valuePin,
      ...outputs,
    ];
    if (stmt.orelse) {
      pins.push(this.execOut('else', 'Else', this.blockInsert(stmt.orelse)));
    }

    const node = this.addNode({
      kind: 'setVar',
      title,
      subtitle: [
        stmt.mutable ? 'let mut' : 'let',
        ...(stmt.valueType ? [`: ${this.src(rangeOf(stmt.valueType))}`] : []),
      ].join(' '),
      category: 'function',
      purity: 'impure',
      range: rangeOf(stmt),
      pins,
      path,
      meta: {
        ...meta,
        declares: stmt.pattern.bindings.map((b) => b.name),
      },
    });
    this.feed(node.id, valuePin, lowered);
    if (valuePin.type === 'any') {
      valuePin.type = type;
    }

    if (stmt.orelse) {
      const cursor = { node: node.id, pin: 'then' };
      this.chain(node, 'else');
      this.lowerBlock(stmt.orelse, `${path}/else`, false);
      this.cursor = cursor;
    } else {
      this.chain(node);
    }

    if (name) {
      this.declare(name, { type });
    } else {
      for (const binding of stmt.pattern.bindings) {
        this.declare(binding.name, { type: 'any' });
      }
    }
  }

  private lowerAssign(
    stmt: Extract<Stmt, { type: 'Assign' }>,
    path: string,
    meta: Record<string, unknown>,
    insert: InsertPoint | undefined
  ): void {
    const target = unwrap(stmt.target);
    const inputs: InputSpec[] = [];
    let title: string;
    let varName: string | undefined;
    const chain = simpleChain(target);
    const rootWired =
      chain?.[0] !== undefined &&
      chain[0] !== 'self' &&
      this.lookup(chain[0])?.source !== undefined;
    if (chain && !(rootWired && chain.length > 1)) {
      varName = chain.join('.');
      title = `Set ${varName}`;
    } else if (target.type === 'Field') {
      title = `Set .${target.name}`;
      inputs.push({
        pin: this.dataIn('target', 'Target', rangeOf(target.object), 'object'),
        value: this.lowerExpr(target.object, `${path}.target`, 'eager'),
      });
    } else if (target.type === 'Index') {
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
          pin: this.dataIn('key', 'Index', rangeOf(target.index)),
          value: this.lowerExpr(target.index, `${path}.key`, 'eager'),
        }
      );
    } else if (target.type === 'Unary' && target.op === '*') {
      title = `Set *${truncate(this.src(rangeOf(target.argument)), 24)}`;
      inputs.push({
        pin: this.dataIn('target', 'Target', rangeOf(target.argument)),
        value: this.lowerExpr(target.argument, `${path}.target`, 'eager'),
      });
    } else {
      title = `Set ${truncate(this.src(rangeOf(target)), 28)}`;
    }

    const value = this.lowerExpr(stmt.value, `${path}.value`, 'eager', varName);
    const valuePin = this.dataIn('value', '', rangeOf(stmt.value));
    inputs.push({ pin: valuePin, value });
    const known = varName
      ? (this.lookup(varName)?.type ?? this.doc.globals.get(varName))
      : undefined;
    const type = known && known !== 'any' ? known : value.type;
    if (valuePin.type === 'any' && known && known !== 'any') {
      valuePin.type = known;
    }

    this.simpleNode(stmt, path, meta, insert, {
      kind: 'setVar',
      title,
      subtitle: stmt.op,
      category: 'function',
      inputs,
      outputs: [
        this.dataOut('out', '', type, varName ? { sourceText: varName } : {}),
      ],
    });
  }

  /** A condition input: a `let` pattern binds names (`if let Some(x)`). */
  private lowerCondition(
    condition: Expr,
    path: string
  ): {
    pin: Pin;
    value: ValueSource | undefined;
    title: string;
    subtitle?: string;
    bindings: Pattern['bindings'];
  } {
    const cond = unwrap(condition);
    if (cond.type === 'Let') {
      return {
        pin: this.dataIn('condition', 'Value', rangeOf(cond.value)),
        value: this.lowerExpr(cond.value, `${path}.test`, 'eager'),
        title: 'If Let',
        subtitle: truncate(this.src(rangeOf(cond.pattern)), 28),
        bindings: cond.pattern.bindings,
      };
    }

    if (cond.type === 'LetChain') {
      return {
        pin: this.dataIn('condition', 'Condition', rangeOf(cond), 'bool'),
        value: this.pureNode({
          kind: 'unknown',
          title: truncate(this.src(rangeOf(cond)), 32),
          subtitle: 'let chain',
          range: rangeOf(cond),
          path: `${path}.test`,
          inputs: [],
          outType: 'bool',
          category: 'unknown',
        }),
        title: 'If Let',
        bindings: cond.parts.flatMap((p) =>
          p.type === 'Let' ? p.pattern.bindings : []
        ),
      };
    }

    return {
      pin: this.dataIn('condition', 'Condition', rangeOf(cond), 'bool'),
      value: this.lowerExpr(cond, `${path}.test`, 'eager'),
      title: 'Branch',
      bindings: [],
    };
  }

  /** Outputs for the names a pattern binds (`Some(x)` → `x`). */
  private bindingOutputs(
    bindings: Pattern['bindings'],
    prefix: string,
    visibleIn: SourceRange
  ): Pin[] {
    return bindings.map((b, i) =>
      this.dataOut(`${prefix}${i}`, b.name, 'any', {
        sourceText: b.name,
        visibleIn,
      })
    );
  }

  private declareBindings(
    nodeId: string,
    bindings: Pattern['bindings'],
    prefix: string
  ): void {
    for (const [i, b] of bindings.entries()) {
      this.declare(b.name, {
        source: { node: nodeId, pin: `${prefix}${i}` },
        type: 'any',
      });
    }
  }

  private lowerIf(
    stmt: IfStmt,
    path: string,
    meta: Record<string, unknown>,
    insert: InsertPoint | undefined,
    tail: boolean
  ): void {
    const parts = [
      { condition: stmt.condition, body: stmt.body, span: stmt as Span },
      ...stmt.elifs.map((e) => ({
        condition: e.condition,
        body: e.body,
        span: e as Span,
      })),
    ];
    let first: GraphNode | undefined;
    for (const [index, part] of parts.entries()) {
      const isElif = index > 0;
      const next = parts[index + 1] ? undefined : stmt.orelse;
      const branchPath = isElif ? `${path}/elif${index}` : path;
      const condition = this.lowerCondition(part.condition, branchPath);
      const pins: Pin[] = [
        this.execIn(),
        condition.pin,
        this.execOut('true', 'True', this.blockInsert(part.body)),
        this.execOut('false', 'False', this.blockInsert(next)),
        ...this.bindingOutputs(condition.bindings, 'bind', rangeOf(part.body)),
      ];
      if (!isElif && !tail) {
        pins.push(this.execOut('completed', 'Completed', insert, true));
      }

      const elifMeta: StatementMeta = {
        stmt: rangeOf(part.span),
        locked: true,
      };
      const node = this.addNode({
        kind: 'branch',
        title: condition.title,
        subtitle: isElif
          ? ['else if', condition.subtitle].filter(Boolean).join(' ')
          : condition.subtitle,
        category: 'flow',
        purity: 'impure',
        range: rangeOf(part.span),
        pins,
        path: branchPath,
        meta: isElif ? (elifMeta as unknown as Record<string, unknown>) : meta,
      });
      this.feed(node.id, condition.pin, condition.value);
      this.chain(node, 'true');
      this.withScope(() => {
        this.declareBindings(node.id, condition.bindings, 'bind');
        this.lowerBlock(part.body, `${branchPath}/then`, tail);
      });
      this.cursor = { node: node.id, pin: 'false' };
      first ??= node;
    }

    if (stmt.orelse) {
      this.lowerBlock(stmt.orelse, `${path}/else`, tail);
    }

    this.cursor = first && !tail ? { node: first.id, pin: 'completed' } : null;
  }

  private lowerMatch(
    stmt: MatchStmt,
    path: string,
    meta: Record<string, unknown>,
    insert: InsertPoint | undefined,
    tail: boolean
  ): void {
    const valuePin = this.dataIn('value', 'Subject', rangeOf(stmt.subject));
    const value = this.lowerExpr(stmt.subject, `${path}.value`, 'eager');
    const pins: Pin[] = [this.execIn(), valuePin];
    for (const [i, arm] of stmt.arms.entries()) {
      const label = this.src(rangeOf(arm.pattern));
      const guard = arm.guard ? ` if ${this.src(rangeOf(arm.guard))}` : '';
      pins.push(
        this.execOut(
          `case${i}`,
          truncate(`${label}${guard}`, 24),
          isBlock(arm.body) ? this.blockInsert(arm.body) : undefined
        ),
        ...this.bindingOutputs(arm.pattern.bindings, `case${i}_`, rangeOf(arm))
      );
    }

    if (!tail) {
      pins.push(this.execOut('completed', 'Completed', insert, true));
    }

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
    for (const [i, arm] of stmt.arms.entries()) {
      this.cursor = { node: node.id, pin: `case${i}` };
      this.withScope(() => {
        this.declareBindings(node.id, arm.pattern.bindings, `case${i}_`);
        const armPath = `${path}/case${i}`;
        if (isBlock(arm.body)) {
          this.lowerBlock(arm.body, armPath, tail);
        } else if (tail && this.returnsValue) {
          this.implicitReturn(arm.body, `${armPath}/0`, rangeOf(arm.body));
        } else {
          this.currentStatement = rangeOf(arm.body);
          this.lowerExpressionStatement(
            arm.body,
            arm.body,
            `${armPath}/0`,
            { ...this.statementMeta(rangeOf(arm.body), false), locked: true },
            undefined
          );
        }
      });
    }

    this.cursor = tail ? null : { node: node.id, pin: 'completed' };
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
    const name = stmt.pattern.simple;
    const elementName = this.src(rangeOf(stmt.pattern));
    const elementType = name ? arrayElementType(iterable.type) : 'any';
    const iter = unwrap(stmt.iter);
    const isRange = iter.type === 'Range';
    const pins: Pin[] = [
      this.execIn(),
      iterPin,
      this.execOut('body', 'Loop Body', this.blockInsert(stmt.body)),
    ];
    if (name) {
      pins.push(
        this.dataOut('element', name, isRange ? 'number' : elementType, {
          sourceText: name,
          visibleIn: rangeOf(stmt.body),
        })
      );
    } else {
      pins.push(
        ...this.bindingOutputs(
          stmt.pattern.bindings,
          'element',
          rangeOf(stmt.body)
        )
      );
    }

    pins.push(this.execOut('completed', 'Completed', insert, true));
    const node = this.addNode({
      kind: 'forEach',
      title: isRange ? 'For Loop' : 'For Each',
      subtitle: stmt.label ?? (name ? undefined : truncate(elementName, 24)),
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
      if (name) {
        this.declare(name, {
          source: { node: node.id, pin: 'element' },
          type: isRange ? 'number' : elementType,
        });
      } else {
        this.declareBindings(node.id, stmt.pattern.bindings, 'element');
      }

      this.lowerBlock(stmt.body, `${path}/body`, false);
    });
    this.cursor = { node: node.id, pin: 'completed' };
  }

  private lowerWhile(
    stmt: Extract<Stmt, { type: 'While' }>,
    path: string,
    meta: Record<string, unknown>,
    insert: InsertPoint | undefined
  ): void {
    const condition = this.lowerCondition(stmt.condition, path);
    const node = this.addNode({
      kind: 'loop',
      title: condition.title === 'If Let' ? 'While Let' : 'While Loop',
      subtitle:
        [stmt.label, condition.subtitle].filter(Boolean).join(' ') || undefined,
      category: 'flow',
      purity: 'impure',
      range: rangeOf(stmt),
      pins: [
        this.execIn(),
        condition.pin,
        this.execOut('body', 'Loop Body', this.blockInsert(stmt.body)),
        ...this.bindingOutputs(condition.bindings, 'bind', rangeOf(stmt.body)),
        this.execOut('completed', 'Completed', insert, true),
      ],
      path,
      meta,
    });
    this.feed(node.id, condition.pin, condition.value);
    this.chain(node, 'body');
    this.withScope(() => {
      this.declareBindings(node.id, condition.bindings, 'bind');
      this.lowerBlock(stmt.body, `${path}/body`, false);
    });
    this.cursor = { node: node.id, pin: 'completed' };
  }

  private queueClosure(
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

  // ------------------------------------------------------------ expressions

  private callTitle(
    callee: Expr,
    path: string,
    evalMode: 'eager' | 'lazy',
    inputs: InputSpec[]
  ): { title: string; signature?: Signature; chain?: string[] } {
    const chain = simpleChain(callee);
    const root = chain?.[0];
    // A variable as receiver (`cart.first()`) becomes the Target pin.
    const rootIsVariable =
      root !== undefined && root !== 'self' && this.lookup(root) !== undefined;
    if (chain && (!rootIsVariable || chain.length === 1)) {
      const title = chain.join('.');
      const owner = root === 'self' || root === 'Self' ? this.owner : undefined;
      const member = chain.slice(1).join('.');
      const signature =
        owner && member
          ? this.doc.signatures.get(`${owner}::${member}`)
          : this.doc.signatures.get(
              title.replace(/^Self::/, `${this.owner ?? 'Self'}::`)
            );
      if (root === 'self' && chain.length > 1) {
        // `self.save()`: the target is the function's `self`.
        const entry = this.lookup('self');
        if (entry?.source) {
          inputs.push({
            pin: this.dataIn('target', 'Target', undefined, entry.type),
            value: { pin: entry.source, type: entry.type },
          });
        }
      }

      return { title, ...(signature ? { signature } : {}), chain };
    }

    if (callee.type === 'Field') {
      inputs.push({
        pin: this.dataIn('target', 'Target', rangeOf(callee.object), 'object'),
        value: this.lowerExpr(callee.object, `${path}.target`, evalMode),
      });
      return { title: callee.name };
    }

    inputs.push({
      pin: this.dataIn('function', 'Function', rangeOf(callee), 'function'),
      value: this.lowerExpr(callee, `${path}.callee`, evalMode),
    });
    return { title: 'Call' };
  }

  private lowerCall(
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
          `${title} callback`
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

  private macroType(expr: Extract<Expr, { type: 'Macro' }>): DataType {
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

  private makeArray(
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

  private lowerMacroValue(
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

  /** `if c { a } else { b }` as a value: a Select when both are values. */
  private lowerIfValue(
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

  private lowerBinary(
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

  private lowerAwait(
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

export function parseRustDocument(
  text: string,
  fileName = 'main.rs',
  options: ParseOptions = {}
): GraphDocument {
  const { items, diagnostics, comments } = parseRust(text);
  const lowering = new DocumentLowering(
    text,
    fileName.split('/').at(-1) ?? fileName
  );
  lowering.run(items);
  const doc: GraphDocument = {
    language: LANGUAGE_ID,
    functions: lowering.functions,
    diagnostics: diagnostics.map((d): Diagnostic => ({
      message: d.message,
      range: { start: d.start, end: d.end },
      severity: 'error',
    })),
    symbols: [...rustImports(text), ...rustSymbols(items, text)],
  };
  attachComments(doc, text, comments);
  linkSymbolGraphs(doc);
  linkImports(doc, options.imports);
  completeCallPins(doc, text, {
    placeholder: 'todo!()',
    imports: options.imports,
  });
  inferTypes(doc);
  return doc;
}
