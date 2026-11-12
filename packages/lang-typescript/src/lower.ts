import { parse } from '@babel/parser';
import type * as t from '@babel/types';
import type {
  DataType,
  Diagnostic,
  FunctionGraph,
  GraphDocument,
  GraphEdge,
  GraphNode,
  NodeCategory,
  NodeKind,
  NodePurity,
  Pin,
  PinLiteral,
  PinRef,
  SourceRange,
} from '@vizscript/core';
import type {
  ExecOutPinMeta,
  InputPinMeta,
  InsertPoint,
  OutputPinMeta,
  StatementMeta,
} from '@vizscript/core';
import {
  arrayElementType,
  arrayOfAll,
  attachComments,
  completeCallPins,
  createEdge,
  isArrayType,
  lineIndent,
  linkSymbolGraphs,
  markUnusedValue,
  NodeIdFactory,
  refinesType,
  truncate,
} from '@vizscript/core';
import { patternAnnotation, typeFromAnnotation } from './annotations';
import { typeScriptSymbols } from './symbols';

export const LANGUAGE_ID = 'typescript';

type AnyFunction =
  | t.FunctionDeclaration
  | t.FunctionExpression
  | t.ArrowFunctionExpression
  | t.ObjectMethod
  | t.ClassMethod
  | t.ClassPrivateMethod;

interface PendingFunction {
  name: string;
  kind: string;
  fn: AnyFunction;
}

/** A value feeding an input pin: either a wire or an inline literal. */
type ValueSource =
  | { pin: PinRef; type: DataType }
  | { literal: PinLiteral; type: DataType };

type EvalMode = 'eager' | 'lazy';

interface ScopeEntry {
  source?: PinRef;
  type: DataType;
}

interface InputSpec {
  pin: Pin;
  value: ValueSource | undefined;
}

/** Top-level statements that do not produce exec nodes. */
const DECLARATION_ONLY = new Set<string>([
  'ImportDeclaration',
  'ExportAllDeclaration',
  'FunctionDeclaration',
  'ClassDeclaration',
  'TSTypeAliasDeclaration',
  'TSInterfaceDeclaration',
  'TSModuleDeclaration',
  'TSEnumDeclaration',
  'TSDeclareFunction',
  'EmptyStatement',
]);

const COMPARISON_OPERATORS = new Set([
  '==',
  '!=',
  '===',
  '!==',
  '<',
  '<=',
  '>',
  '>=',
  'in',
  'instanceof',
]);

/** Name of an export specifier (`export { a as "b" }`). */
function exportName(node: t.Identifier | t.StringLiteral): string {
  return node.type === 'Identifier' ? node.name : node.value;
}

function rangeOf(node: t.Node): SourceRange {
  return { start: node.start ?? 0, end: node.end ?? 0 };
}

function unwrap(expr: t.Expression): t.Expression {
  let current: t.Expression = expr;
  for (;;) {
    switch (current.type) {
      case 'TSAsExpression':
      case 'TSSatisfiesExpression':
      case 'TSNonNullExpression':
      case 'TSTypeAssertion':
      case 'TSInstantiationExpression':
      case 'ParenthesizedExpression': {
        current = current.expression;
        break;
      }

      default: {
        return current;
      }
    }
  }
}

function patternName(pattern: t.Node, text: string): string {
  if (pattern.type === 'Identifier') {
    return pattern.name;
  }

  if (pattern.type === 'AssignmentPattern') {
    return patternName(pattern.left, text);
  }

  if (pattern.type === 'RestElement') {
    return `...${patternName(pattern.argument, text)}`;
  }

  if (pattern.type === 'TSParameterProperty') {
    return patternName(pattern.parameter, text);
  }

  const r = rangeOf(pattern);
  return truncate(text.slice(r.start, r.end), 24);
}

/** Returns `['a', 'b', 'c']` for chains like `a.b.c` without computed keys. */
function simpleChain(expr: t.Node): string[] | undefined {
  const e = expr.type === 'Super' ? expr : unwrap(expr as t.Expression);
  if (e.type === 'Identifier') {
    return [e.name];
  }

  if (e.type === 'ThisExpression') {
    return ['this'];
  }

  if (e.type === 'Super') {
    return ['super'];
  }

  if (
    (e.type === 'MemberExpression' || e.type === 'OptionalMemberExpression') &&
    !e.computed &&
    e.property.type === 'Identifier'
  ) {
    const head = simpleChain(e.object);
    return head ? [...head, e.property.name] : undefined;
  }

  return undefined;
}

class DocumentLowering {
  public readonly functions: FunctionGraph[] = [];
  public readonly queue: PendingFunction[] = [];
  public readonly functionParams = new Map<string, string[]>();
  public readonly functionReturnTypes = new Map<string, DataType>();
  private readonly fnIds = new Map<string, number>();

  public constructor(
    public readonly text: string,
    public readonly fileName: string
  ) {}

  public uniqueFunctionId(name: string): string {
    const count = this.fnIds.get(name) ?? 0;
    this.fnIds.set(name, count + 1);
    return count === 0 ? `fn:${name}` : `fn:${name}~${count}`;
  }

  private collectSignatures(program: t.Program): void {
    const visit = (stmt: t.Statement): void => {
      if (stmt.type === 'ExportNamedDeclaration' && stmt.declaration) {
        visit(stmt.declaration);
        return;
      }

      if (
        stmt.type === 'ExportDefaultDeclaration' &&
        stmt.declaration.type === 'FunctionDeclaration'
      ) {
        visit(stmt.declaration);
        return;
      }

      if (stmt.type === 'FunctionDeclaration' && stmt.id) {
        this.functionParams.set(
          stmt.id.name,
          stmt.params.map((p) => patternName(p, this.text))
        );
        this.functionReturnTypes.set(
          stmt.id.name,
          typeFromAnnotation(stmt.returnType)
        );
      }

      if (stmt.type === 'VariableDeclaration') {
        for (const decl of stmt.declarations) {
          const init = decl.init ? unwrap(decl.init) : undefined;
          if (
            decl.id.type === 'Identifier' &&
            init &&
            (init.type === 'ArrowFunctionExpression' ||
              init.type === 'FunctionExpression')
          ) {
            this.functionParams.set(
              decl.id.name,
              init.params.map((p) => patternName(p, this.text))
            );
            this.functionReturnTypes.set(
              decl.id.name,
              typeFromAnnotation(init.returnType)
            );
          }
        }
      }
    };

    for (const stmt of program.body) {
      visit(stmt);
    }
  }

  public run(program: t.Program): void {
    this.collectSignatures(program);
    new FnGraphBuilder(this, 'Module', 'module', program).run();
    for (let next = this.queue.shift(); next; next = this.queue.shift()) {
      new FnGraphBuilder(this, next.name, next.kind, next.fn).run();
    }
  }
}

/** Lowers one function (or the module top level) into a FunctionGraph. */
class FnGraphBuilder {
  private readonly nodes: GraphNode[] = [];
  private readonly edges: GraphEdge[] = [];
  private readonly ids: NodeIdFactory;
  private readonly fnId: string;
  private readonly scopes: Array<Map<string, ScopeEntry>> = [new Map()];
  private readonly text: string;
  private cursor: PinRef | null = null;
  private currentStatement: SourceRange | null = null;
  /** Set while lowering the declaration of an `export` statement. */
  private exportKeyword: 'export' | 'export default' | null = null;

  public constructor(
    private readonly doc: DocumentLowering,
    private readonly name: string,
    private readonly kind: string,
    private readonly fn: AnyFunction | t.Program
  ) {
    this.text = doc.text;
    this.fnId = doc.uniqueFunctionId(name);
    this.ids = new NodeIdFactory(this.fnId);
  }

  // ---------------------------------------------------------------- helpers

  private source(range: SourceRange): string {
    return this.text.slice(range.start, range.end);
  }

  private addNode(options: {
    kind: NodeKind;
    title: string;
    subtitle?: string;
    category: NodeCategory;
    purity: NodePurity;
    range: SourceRange;
    pins: Pin[];
    path: string;
    compact?: boolean;
    meta?: Record<string, unknown>;
    idText?: string;
  }): GraphNode {
    const node: GraphNode = {
      id: this.ids.create(
        options.kind,
        options.idText ?? `${options.title}|${this.source(options.range)}`
      ),
      kind: options.kind,
      category: options.category,
      purity: options.purity,
      title: options.title,
      range: options.range,
      pins: options.pins,
      path: options.path,
    };
    if (options.subtitle) {
      node.subtitle = options.subtitle;
    }

    if (options.compact) {
      node.compact = true;
    }

    if (options.meta) {
      node.meta = options.meta;
    }

    this.nodes.push(node);
    return node;
  }

  private connect(kind: 'exec' | 'data', from: PinRef, to: PinRef): void {
    this.edges.push(createEdge(kind, from, to));
  }

  /** Wires the node's `exec` input to the current cursor and advances it. */
  private chain(node: GraphNode, thenPin: string | null = 'then'): void {
    if (this.cursor) {
      this.connect('exec', this.cursor, { node: node.id, pin: 'exec' });
    }

    this.cursor = thenPin ? { node: node.id, pin: thenPin } : null;
  }

  private feed(nodeId: string, pin: Pin, value: ValueSource | undefined): void {
    if (!value) {
      return;
    }

    if ('literal' in value) {
      pin.literal = value.literal;
    } else {
      this.connect('data', value.pin, { node: nodeId, pin: pin.id });
    }

    if (refinesType(pin.type, value.type)) {
      pin.type = value.type;
    }
  }

  private feedAll(nodeId: string, inputs: ReadonlyArray<InputSpec>): void {
    for (const input of inputs) {
      this.feed(nodeId, input.pin, input.value);
    }
  }

  private lookup(name: string): ScopeEntry | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const entry = this.scopes[i]?.get(name);
      if (entry) {
        return entry;
      }
    }

    return undefined;
  }

  private declare(name: string, entry: ScopeEntry): void {
    this.scopes.at(-1)?.set(name, entry);
  }

  private withScope(fn: () => void): void {
    this.scopes.push(new Map());
    try {
      fn();
    } finally {
      this.scopes.pop();
    }
  }

  private execIn(): Pin {
    return { id: 'exec', name: '', direction: 'in', kind: 'exec', type: 'any' };
  }

  private execOut(
    id: string,
    name: string,
    insert?: InsertPoint,
    continuation = false
  ): Pin {
    const meta: ExecOutPinMeta = {};
    if (insert) {
      meta.insert = insert;
    }

    if (continuation) {
      meta.continuation = true;
    }

    return {
      id,
      name,
      direction: 'out',
      kind: 'exec',
      type: 'any',
      meta: meta as Record<string, unknown>,
    };
  }

  private dataIn(
    id: string,
    name: string,
    range?: SourceRange,
    type: DataType = 'any',
    meta?: InputPinMeta
  ): Pin {
    const pin: Pin = { id, name, direction: 'in', kind: 'data', type };
    if (range) {
      pin.range = range;
    }

    if (meta) {
      pin.meta = meta as Record<string, unknown>;
    }

    return pin;
  }

  private dataOut(
    id: string,
    name: string,
    type: DataType,
    meta: OutputPinMeta,
    range?: SourceRange
  ): Pin {
    const pin: Pin = {
      id,
      name,
      direction: 'out',
      kind: 'data',
      type,
      meta: meta as Record<string, unknown>,
    };
    if (range) {
      pin.range = range;
    }

    return pin;
  }

  /** Insertion point at the start of a `{ ... }` block. */
  private blockInsert(block: t.Node): InsertPoint | undefined {
    if (block.type !== 'BlockStatement') {
      return undefined;
    }

    const first = block.body[0];
    const indent = first
      ? lineIndent(this.text, first.start ?? 0)
      : `${lineIndent(this.text, block.start ?? 0)}  `;
    return { at: (block.start ?? 0) + 1, indent, mode: 'after' };
  }

  private statementInsert(
    stmt: t.Node,
    inline: boolean
  ): InsertPoint | undefined {
    if (inline) {
      return undefined;
    }

    return {
      at: stmt.end ?? 0,
      indent: lineIndent(this.text, stmt.start ?? 0),
      mode: 'after',
    };
  }

  private statementMeta(
    stmt: t.Node,
    inline: boolean
  ): Record<string, unknown> {
    const meta: StatementMeta = { stmt: rangeOf(stmt) };
    if (inline) {
      meta.inline = true;
    }

    return meta as unknown as Record<string, unknown>;
  }

  // ------------------------------------------------------------- functions

  public run(): void {
    const fn = this.fn;
    const entryPins: Pin[] = [];
    let entryInsert: InsertPoint | undefined;
    let subtitle: string;
    let entryRange: SourceRange;
    let returnType: DataType = 'any';

    if (fn.type === 'Program') {
      subtitle = this.doc.fileName || 'module';
      entryRange = { start: 0, end: 0 };
      // New statements go before the first executable top-level statement.
      const firstExecutable = fn.body.find(
        (s) => !DECLARATION_ONLY.has(s.type)
      );
      const lastImport = fn.body.findLast(
        (s) => s.type === 'ImportDeclaration'
      );
      entryInsert = firstExecutable
        ? { at: firstExecutable.start ?? 0, indent: '', mode: 'before' }
        : {
            at: lastImport?.end ?? fn.end ?? this.text.length,
            indent: '',
            mode: 'after',
          };
    } else {
      subtitle = !fn.async
        ? this.kind
        : this.kind.startsWith('export')
          ? this.kind.replace('function', 'async function')
          : `async ${this.kind}`;
      entryRange = { start: fn.start ?? 0, end: fn.body.start ?? 0 };
      entryInsert = this.blockInsert(fn.body);
      returnType = typeFromAnnotation(fn.returnType);
    }

    entryPins.push(this.execOut('then', '', entryInsert));
    const entry = this.addNode({
      kind: 'entry',
      title: this.name,
      subtitle,
      category: 'event',
      purity: 'impure',
      range: entryRange,
      pins: entryPins,
      path: 'entry',
      idText: `entry|${this.name}`,
    });

    if (fn.type !== 'Program') {
      for (const [index, param] of fn.params.entries()) {
        this.declareParam(entry, entryPins, param, index);
      }
    }

    this.cursor = { node: entry.id, pin: 'then' };

    if (fn.type === 'Program') {
      this.lowerStatements(fn.body, 'body', false);
    } else if (fn.body.type === 'BlockStatement') {
      this.lowerStatements(fn.body.body, 'body', false);
    } else {
      // Arrow function with an expression body: implicit return.
      const body = fn.body;
      this.currentStatement = rangeOf(body);
      const value = this.lowerExpr(body, 'body/0', 'eager');
      const pin = this.dataIn('value', '', rangeOf(body), returnType);
      const node = this.addNode({
        kind: 'return',
        title: 'Return',
        category: 'return',
        purity: 'impure',
        range: rangeOf(body),
        pins: [this.execIn(), pin],
        path: 'body/0',
      });
      this.feed(node.id, pin, value);
      this.chain(node, null);
    }

    this.doc.functions.push({
      id: this.fnId,
      name: this.name,
      range: rangeOf(fn),
      nodes: this.nodes,
      edges: this.edges,
    });
  }

  private declareParam(
    entry: GraphNode,
    entryPins: Pin[],
    param: t.Node,
    index: number
  ): void {
    const name = patternName(param, this.text);
    const type = typeFromAnnotation(patternAnnotation(param));
    const pinId = `param${index}`;
    entryPins.push(
      this.dataOut(
        pinId,
        name,
        type,
        { sourceText: name.replace(/^\.\.\./, '') },
        rangeOf(param)
      )
    );

    let identifier: t.Node = param;
    if (identifier.type === 'TSParameterProperty') {
      identifier = identifier.parameter;
    }

    if (identifier.type === 'AssignmentPattern') {
      identifier = identifier.left;
    }

    if (identifier.type === 'RestElement') {
      identifier = identifier.argument;
    }

    if (identifier.type === 'Identifier') {
      this.declare(identifier.name, {
        source: { node: entry.id, pin: pinId },
        type:
          param.type === 'RestElement' && !isArrayType(type) ? 'array' : type,
      });
    }
  }

  private queueFunction(name: string, kind: string, fn: AnyFunction): void {
    this.doc.queue.push({ name, kind, fn });
  }

  private queueClass(
    cls: t.ClassDeclaration | t.ClassExpression,
    name: string
  ): void {
    for (const member of cls.body.body) {
      if (
        member.type !== 'ClassMethod' &&
        member.type !== 'ClassPrivateMethod'
      ) {
        continue;
      }

      const key =
        member.key.type === 'Identifier'
          ? member.key.name
          : member.key.type === 'PrivateName'
            ? `#${member.key.id.name}`
            : truncate(this.source(rangeOf(member.key)), 20);
      const kind =
        member.kind === 'constructor'
          ? 'constructor'
          : member.kind === 'get'
            ? 'getter'
            : member.kind === 'set'
              ? 'setter'
              : 'method';
      this.queueFunction(`${name}.${key}`, kind, member);
    }
  }

  // ------------------------------------------------------------ statements

  private lowerStatements(
    stmts: ReadonlyArray<t.Statement>,
    path: string,
    inSwitchCase: boolean
  ): void {
    this.withScope(() => {
      for (const [index, stmt] of stmts.entries()) {
        if (
          inSwitchCase &&
          stmt.type === 'BreakStatement' &&
          !stmt.label &&
          index === stmts.length - 1
        ) {
          continue;
        }

        this.lowerStatement(stmt, `${path}/${index}`, false);
      }
    });
  }

  /** Lowers the body of a control structure (block or single statement). */
  private lowerBody(body: t.Statement, path: string): void {
    if (body.type === 'BlockStatement') {
      this.lowerStatements(body.body, path, false);
    } else {
      this.withScope(() => this.lowerStatement(body, `${path}/0`, true));
    }
  }

  private lowerStatement(
    stmt: t.Statement,
    path: string,
    inline: boolean
  ): void {
    this.currentStatement = rangeOf(stmt);
    switch (stmt.type) {
      case 'ExpressionStatement': {
        this.lowerExpressionStatement(stmt, path, inline);
        return;
      }

      case 'VariableDeclaration': {
        this.lowerVariableDeclaration(stmt, path, inline);
        return;
      }

      case 'ReturnStatement':
      case 'ThrowStatement': {
        const isReturn = stmt.type === 'ReturnStatement';
        const argument = stmt.argument;
        const value = argument
          ? this.lowerExpr(argument, `${path}.value`, 'eager')
          : undefined;
        const pins: Pin[] = [this.execIn()];
        const valuePin = argument
          ? this.dataIn(
              isReturn ? 'value' : 'error',
              isReturn ? '' : 'Error',
              rangeOf(argument),
              'any',
              isReturn ? { optional: true } : undefined
            )
          : isReturn && typeof stmt.start === 'number'
            ? // `return;`: a value can be wired in after the keyword.
              this.dataIn('value', '', undefined, 'any', {
                insertInitAt: stmt.start + 'return'.length,
                insertPrefix: ' ',
              })
            : undefined;
        if (valuePin) {
          pins.push(valuePin);
        }

        const node = this.addNode({
          kind: isReturn ? 'return' : 'throw',
          title: isReturn ? 'Return' : 'Throw',
          category: isReturn ? 'return' : 'flow',
          purity: 'impure',
          range: rangeOf(stmt),
          pins,
          path,
          meta: this.statementMeta(stmt, inline),
        });
        if (valuePin) {
          this.feed(node.id, valuePin, value);
        }

        this.chain(node, null);
        return;
      }

      case 'IfStatement': {
        this.lowerIf(stmt, path, inline);
        return;
      }

      case 'BlockStatement': {
        this.lowerStatements(stmt.body, `${path}/block`, false);
        return;
      }

      case 'ForStatement':
      case 'WhileStatement':
      case 'DoWhileStatement': {
        this.lowerLoop(stmt, path, inline);
        return;
      }

      case 'ForOfStatement':
      case 'ForInStatement': {
        this.lowerForEach(stmt, path, inline);
        return;
      }

      case 'SwitchStatement': {
        this.lowerSwitch(stmt, path, inline);
        return;
      }

      case 'TryStatement': {
        this.lowerTry(stmt, path, inline);
        return;
      }

      case 'BreakStatement':
      case 'ContinueStatement': {
        const isBreak = stmt.type === 'BreakStatement';
        const node = this.addNode({
          kind: isBreak ? 'break' : 'continue',
          title: isBreak ? 'Break' : 'Continue',
          subtitle: stmt.label?.name,
          category: 'flow',
          purity: 'impure',
          range: rangeOf(stmt),
          pins: [this.execIn()],
          path,
          meta: this.statementMeta(stmt, inline),
        });
        this.chain(node, null);
        return;
      }

      case 'LabeledStatement': {
        this.lowerStatement(stmt.body, path, inline);
        return;
      }

      case 'FunctionDeclaration': {
        this.queueFunction(
          stmt.id?.name ?? 'anonymous',
          this.exportKeyword ? `${this.exportKeyword} function` : 'function',
          stmt
        );
        return;
      }

      case 'ClassDeclaration': {
        this.queueClass(stmt, stmt.id?.name ?? 'AnonymousClass');
        return;
      }

      case 'ExportNamedDeclaration':
      case 'ExportDefaultDeclaration':
      case 'ExportAllDeclaration':
      case 'TSExportAssignment': {
        this.lowerExport(stmt, path, inline);
        return;
      }

      case 'ImportDeclaration':
      case 'EmptyStatement':
      case 'DebuggerStatement':
      case 'TSTypeAliasDeclaration':
      case 'TSInterfaceDeclaration':
      case 'TSModuleDeclaration':
      case 'TSEnumDeclaration':
      case 'TSDeclareFunction':
      case 'TSImportEqualsDeclaration':
      case 'TSNamespaceExportDeclaration': {
        return;
      }

      default: {
        this.lowerUnknownStatement(stmt, path, inline);
      }
    }
  }

  /**
   * Exports are the module's outputs, like the result pins of a Blueprint
   * function: `export default x` and `export { a, b }` become Export nodes,
   * exported declarations keep their own nodes and are labelled `export`.
   */
  private lowerExport(
    stmt:
      | t.ExportNamedDeclaration
      | t.ExportDefaultDeclaration
      | t.ExportAllDeclaration
      | t.TSExportAssignment,
    path: string,
    inline: boolean
  ): void {
    if (stmt.type === 'ExportAllDeclaration') {
      if (stmt.exportKind !== 'type') {
        this.exportNode(
          stmt,
          path,
          inline,
          'Export * from',
          stmt.source.value,
          []
        );
      }

      return;
    }

    if (stmt.type === 'TSExportAssignment') {
      this.exportNode(stmt, path, inline, 'Export =', undefined, [
        {
          pin: this.dataIn('value', '', rangeOf(stmt.expression)),
          value: this.lowerExpr(stmt.expression, `${path}.value`, 'eager'),
        },
      ]);
      return;
    }

    if (stmt.type === 'ExportDefaultDeclaration') {
      const decl = stmt.declaration;
      if (decl.type === 'FunctionDeclaration' && decl.id) {
        this.queueFunction(decl.id.name, 'export default function', decl);
        return;
      }

      if (decl.type === 'ClassDeclaration' && decl.id) {
        this.queueClass(decl, decl.id.name);
        return;
      }

      if (
        decl.type === 'TSInterfaceDeclaration' ||
        decl.type === 'TSDeclareFunction'
      ) {
        return;
      }

      // Expressions (also anonymous functions/classes) feed the export.
      const expr =
        decl.type === 'FunctionDeclaration'
          ? ({ ...decl, type: 'FunctionExpression' } as t.FunctionExpression)
          : decl.type === 'ClassDeclaration'
            ? ({ ...decl, type: 'ClassExpression' } as t.ClassExpression)
            : decl;
      this.exportNode(stmt, path, inline, 'Export default', undefined, [
        {
          pin: this.dataIn('value', 'default', rangeOf(decl)),
          value: this.lowerExpr(expr, `${path}.value`, 'eager', 'default'),
        },
      ]);
      return;
    }

    if (stmt.declaration) {
      this.exportKeyword = 'export';
      try {
        this.lowerStatement(stmt.declaration, path, inline);
      } finally {
        this.exportKeyword = null;
      }

      return;
    }

    if (stmt.exportKind === 'type') {
      return;
    }

    const specifiers = stmt.specifiers.filter(
      (s) => !(s.type === 'ExportSpecifier' && s.exportKind === 'type')
    );
    if (specifiers.length === 0) {
      return;
    }

    if (stmt.source) {
      // `export { a } from './x'` re-exports without local values.
      const names = specifiers.map((s) => exportName(s.exported)).join(', ');
      this.exportNode(
        stmt,
        path,
        inline,
        'Re-export',
        truncate(`${names} from ${stmt.source.value}`, 36),
        []
      );
      return;
    }

    const inputs: InputSpec[] = [];
    for (const [i, spec] of specifiers.entries()) {
      if (spec.type !== 'ExportSpecifier') {
        continue;
      }

      inputs.push({
        pin: this.dataIn(
          `e${i}`,
          exportName(spec.exported),
          rangeOf(spec.local)
        ),
        value: this.lowerExpr(spec.local, `${path}.e${i}`, 'eager'),
      });
    }

    this.exportNode(stmt, path, inline, 'Export', undefined, inputs);
  }

  private exportNode(
    stmt: t.Node,
    path: string,
    inline: boolean,
    title: string,
    subtitle: string | undefined,
    inputs: InputSpec[]
  ): void {
    const node = this.addNode({
      kind: 'export',
      title,
      subtitle,
      category: 'return',
      purity: 'impure',
      range: rangeOf(stmt),
      pins: [
        this.execIn(),
        this.execOut('then', '', this.statementInsert(stmt, inline)),
        ...inputs.map((i) => i.pin),
      ],
      path,
      meta: this.statementMeta(stmt, inline),
    });
    this.feedAll(node.id, inputs);
    this.chain(node);
  }

  private lowerUnknownStatement(
    stmt: t.Node,
    path: string,
    inline: boolean,
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
      title: value ? 'Evaluate' : truncate(this.source(rangeOf(stmt)), 32),
      subtitle: value ? undefined : stmt.type,
      category: 'unknown',
      purity: 'impure',
      range: rangeOf(stmt),
      pins,
      path,
      meta: this.statementMeta(stmt, inline),
    });
    if (valuePin) {
      this.feed(node.id, valuePin, value);
    }

    this.chain(node);
  }

  private lowerExpressionStatement(
    stmt: t.ExpressionStatement,
    path: string,
    inline: boolean
  ): void {
    const expr = unwrap(stmt.expression);
    const statementMeta = this.statementMeta(stmt, inline);
    const insert = this.statementInsert(stmt, inline);

    switch (expr.type) {
      case 'CallExpression':
      case 'OptionalCallExpression':
      case 'NewExpression': {
        this.lowerCall(expr, path, 'statement', {
          statementMeta,
          insert,
          stmt,
        });
        return;
      }

      case 'AwaitExpression': {
        const value = this.lowerExpr(expr.argument, `${path}.value`, 'eager');
        const pin = this.dataIn('promise', 'Promise', rangeOf(expr.argument));
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

      case 'AssignmentExpression': {
        this.lowerAssignment(expr, stmt, path, statementMeta, insert);
        return;
      }

      case 'UpdateExpression': {
        const target = expr.argument;
        const chain = simpleChain(target);
        const name =
          chain?.join('.') ?? truncate(this.source(rangeOf(target)), 24);
        const node = this.addNode({
          kind: 'setVar',
          title: expr.prefix
            ? `${expr.operator}${name}`
            : `${name}${expr.operator}`,
          category: 'function',
          purity: 'impure',
          range: rangeOf(stmt),
          pins: [this.execIn(), this.execOut('then', '', insert)],
          path,
          meta: statementMeta,
        });
        this.chain(node);
        return;
      }

      default: {
        const before = this.nodes.length;
        const value = this.lowerExpr(expr, `${path}.value`, 'lazy');
        if (!markUnusedValue(this.nodes, before, value, statementMeta)) {
          this.lowerUnknownStatement(stmt, path, inline, value, rangeOf(expr));
        }
      }
    }
  }

  private lowerAssignment(
    expr: t.AssignmentExpression,
    stmt: t.Node,
    path: string,
    statementMeta: Record<string, unknown>,
    insert: InsertPoint | undefined
  ): void {
    const left = expr.left;
    const pins: Pin[] = [this.execIn(), this.execOut('then', '', insert)];
    const inputs: InputSpec[] = [];
    let title: string;
    let varName: string | undefined;

    const chain = simpleChain(left);
    const rootWired =
      chain?.[0] !== undefined && this.lookup(chain[0])?.source !== undefined;

    if (chain && !(rootWired && chain.length > 1)) {
      varName = chain.join('.');
      title = `Set ${varName}`;
    } else if (
      left.type === 'MemberExpression' ||
      left.type === 'OptionalMemberExpression'
    ) {
      const property = left.computed
        ? `[${truncate(this.source(rangeOf(left.property)), 16)}]`
        : this.source(rangeOf(left.property));
      title = `Set .${property}`;
      inputs.push({
        pin: this.dataIn('target', 'Target', rangeOf(left.object), 'object'),
        value: this.lowerExpr(left.object, `${path}.target`, 'eager'),
      });
    } else {
      title = `Set ${truncate(this.source(rangeOf(left)), 24)}`;
    }

    inputs.push({
      pin: this.dataIn('value', '', rangeOf(expr.right)),
      value: this.lowerExpr(expr.right, `${path}.value`, 'eager', varName),
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
      subtitle: expr.operator === '=' ? undefined : expr.operator,
      category: 'function',
      purity: 'impure',
      range: rangeOf(stmt),
      pins,
      path,
      meta: statementMeta,
    });
    this.feedAll(node.id, inputs);
    this.chain(node);
  }

  private lowerVariableDeclaration(
    stmt: t.VariableDeclaration,
    path: string,
    inline: boolean
  ): void {
    const statementMeta = this.statementMeta(stmt, inline);
    const last = stmt.declarations.length - 1;
    for (const [index, decl] of stmt.declarations.entries()) {
      const name = patternName(decl.id, this.text);
      const declaredType = typeFromAnnotation(patternAnnotation(decl.id));
      const init = decl.init ? unwrap(decl.init) : undefined;

      if (
        init &&
        decl.id.type === 'Identifier' &&
        (init.type === 'ArrowFunctionExpression' ||
          init.type === 'FunctionExpression')
      ) {
        // `const fn = () => {}` defines a function graph, like a declaration.
        this.queueFunction(
          name,
          this.exportKeyword ? `${this.exportKeyword} function` : 'function',
          init
        );
        continue;
      }

      if (
        init &&
        decl.id.type === 'Identifier' &&
        init.type === 'ClassExpression'
      ) {
        this.queueClass(init, name);
        continue;
      }

      const value = decl.init
        ? this.lowerExpr(decl.init, `${path}.${index}`, 'eager', name)
        : undefined;
      const type =
        declaredType === 'any' ? (value?.type ?? 'any') : declaredType;

      const valuePin = this.dataIn(
        'value',
        '',
        decl.init ? rangeOf(decl.init) : undefined,
        declaredType,
        decl.init ? undefined : { insertInitAt: decl.id.end ?? 0 }
      );

      const node = this.addNode({
        kind: 'setVar',
        title: `Set ${name}`,
        subtitle: this.exportKeyword
          ? `${this.exportKeyword} ${stmt.kind}`
          : stmt.kind,
        category: 'function',
        purity: 'impure',
        range: stmt.declarations.length === 1 ? rangeOf(stmt) : rangeOf(decl),
        pins: [
          this.execIn(),
          this.execOut(
            'then',
            '',
            index === last ? this.statementInsert(stmt, inline) : undefined
          ),
          valuePin,
          this.dataOut(
            'out',
            '',
            type,
            decl.id.type === 'Identifier' ? { sourceText: name } : {}
          ),
        ],
        path: `${path}.${index}`,
        // Names this declaration binds (also from destructuring patterns).
        meta: { ...statementMeta, declares: bindingNames(decl.id) },
      });
      this.feed(node.id, valuePin, value);
      if (valuePin.type === 'any') {
        valuePin.type = type;
      }

      this.chain(node);

      if (decl.id.type === 'Identifier') {
        this.declare(decl.id.name, { type });
      }
    }
  }

  private lowerIf(stmt: t.IfStatement, path: string, inline: boolean): void {
    const condition = this.lowerExpr(stmt.test, `${path}.test`, 'eager');
    const condPin = this.dataIn(
      'condition',
      'Condition',
      rangeOf(stmt.test),
      'bool'
    );
    const node = this.addNode({
      kind: 'branch',
      title: 'Branch',
      category: 'flow',
      purity: 'impure',
      range: rangeOf(stmt),
      pins: [
        this.execIn(),
        condPin,
        this.execOut('true', 'True', this.blockInsert(stmt.consequent)),
        this.execOut(
          'false',
          'False',
          stmt.alternate ? this.blockInsert(stmt.alternate) : undefined
        ),
        this.execOut(
          'completed',
          'Completed',
          this.statementInsert(stmt, inline),
          true
        ),
      ],
      path,
      meta: this.statementMeta(stmt, inline),
    });
    this.feed(node.id, condPin, condition);
    this.chain(node, 'true');
    this.lowerBody(stmt.consequent, `${path}/then`);

    if (stmt.alternate) {
      this.cursor = { node: node.id, pin: 'false' };
      this.lowerBody(stmt.alternate, `${path}/else`);
    }

    this.cursor = { node: node.id, pin: 'completed' };
  }

  private lowerLoop(
    stmt: t.ForStatement | t.WhileStatement | t.DoWhileStatement,
    path: string,
    inline: boolean
  ): void {
    const title =
      stmt.type === 'ForStatement'
        ? 'For Loop'
        : stmt.type === 'WhileStatement'
          ? 'While Loop'
          : 'Do While';
    let subtitle: string | undefined;
    if (stmt.type === 'ForStatement') {
      const header = [stmt.init, stmt.test, stmt.update]
        .map((part) => (part ? this.source(rangeOf(part)) : ''))
        .join('; ');
      subtitle = truncate(header, 36);
    }

    this.withScope(() => {
      if (
        stmt.type === 'ForStatement' &&
        stmt.init?.type === 'VariableDeclaration'
      ) {
        for (const decl of stmt.init.declarations) {
          if (decl.id.type === 'Identifier') {
            this.declare(decl.id.name, { type: 'number' });
          }
        }
      }

      const pins: Pin[] = [this.execIn()];
      const inputs: InputSpec[] = [];
      if (stmt.test) {
        inputs.push({
          pin: this.dataIn(
            'condition',
            'Condition',
            rangeOf(stmt.test),
            'bool'
          ),
          value: this.lowerExpr(stmt.test, `${path}.test`, 'lazy'),
        });
        pins.push(...inputs.map((i) => i.pin));
      }

      pins.push(
        this.execOut('body', 'Loop Body', this.blockInsert(stmt.body)),
        this.execOut(
          'completed',
          'Completed',
          this.statementInsert(stmt, inline),
          true
        )
      );

      const node = this.addNode({
        kind: 'loop',
        title,
        subtitle,
        category: 'flow',
        purity: 'impure',
        range: rangeOf(stmt),
        pins,
        path,
        meta: this.statementMeta(stmt, inline),
      });
      this.feedAll(node.id, inputs);
      this.chain(node, 'body');
      this.lowerBody(stmt.body, `${path}/body`);
      this.cursor = { node: node.id, pin: 'completed' };
    });
  }

  private lowerForEach(
    stmt: t.ForOfStatement | t.ForInStatement,
    path: string,
    inline: boolean
  ): void {
    const isOf = stmt.type === 'ForOfStatement';
    const left = stmt.left;
    const pattern =
      left.type === 'VariableDeclaration' ? left.declarations[0]?.id : left;
    const elementName = pattern ? patternName(pattern, this.text) : 'element';
    const isAwait = stmt.type === 'ForOfStatement' && stmt.await;
    const iterable = this.lowerExpr(stmt.right, `${path}.right`, 'eager');
    const arrayPin = this.dataIn(
      'array',
      isOf ? 'Array' : 'Object',
      rangeOf(stmt.right),
      isOf ? 'array' : 'object'
    );
    // `for (const x of names)` with `names: string[]` gives a typed element.
    const elementType = isOf ? arrayElementType(iterable.type) : 'string';
    const node = this.addNode({
      kind: 'forEach',
      title: isOf ? 'For Each' : 'For Each Key',
      subtitle: isAwait ? 'await' : undefined,
      category: 'flow',
      purity: 'impure',
      range: rangeOf(stmt),
      pins: [
        this.execIn(),
        arrayPin,
        this.execOut('body', 'Loop Body', this.blockInsert(stmt.body)),
        this.dataOut('element', elementName, elementType, {
          sourceText: elementName,
        }),
        this.execOut(
          'completed',
          'Completed',
          this.statementInsert(stmt, inline),
          true
        ),
      ],
      path,
      meta: this.statementMeta(stmt, inline),
    });
    this.feed(node.id, arrayPin, iterable);
    this.chain(node, 'body');
    this.withScope(() => {
      if (pattern?.type === 'Identifier') {
        this.declare(pattern.name, {
          source: { node: node.id, pin: 'element' },
          type: elementType,
        });
      }

      this.lowerBody(stmt.body, `${path}/body`);
    });
    this.cursor = { node: node.id, pin: 'completed' };
  }

  private lowerSwitch(
    stmt: t.SwitchStatement,
    path: string,
    inline: boolean
  ): void {
    const valuePin = this.dataIn(
      'value',
      'Selection',
      rangeOf(stmt.discriminant)
    );
    const value = this.lowerExpr(stmt.discriminant, `${path}.value`, 'eager');
    const pins: Pin[] = [this.execIn(), valuePin];
    for (const [index, kase] of stmt.cases.entries()) {
      const name = kase.test
        ? truncate(this.source(rangeOf(kase.test)), 20)
        : 'Default';
      const colon = this.text.indexOf(
        ':',
        kase.test?.end ?? (kase.start ?? 0) + 'default'.length
      );
      const first = kase.consequent[0];
      const indent = first
        ? lineIndent(this.text, first.start ?? 0)
        : `${lineIndent(this.text, kase.start ?? 0)}  `;
      pins.push(
        this.execOut(
          `case${index}`,
          name,
          colon > 0 ? { at: colon + 1, indent, mode: 'after' } : undefined
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
      title: 'Switch',
      category: 'flow',
      purity: 'impure',
      range: rangeOf(stmt),
      pins,
      path,
      meta: this.statementMeta(stmt, inline),
    });
    this.feed(node.id, valuePin, value);
    this.chain(node, null);
    for (const [index, kase] of stmt.cases.entries()) {
      this.cursor = { node: node.id, pin: `case${index}` };
      this.lowerStatements(kase.consequent, `${path}/case${index}`, true);
    }

    this.cursor = { node: node.id, pin: 'completed' };
  }

  private lowerTry(stmt: t.TryStatement, path: string, inline: boolean): void {
    const pins: Pin[] = [
      this.execIn(),
      this.execOut('try', 'Try', this.blockInsert(stmt.block)),
    ];
    const handler = stmt.handler;
    const param = handler?.param;
    const errorName = param ? patternName(param, this.text) : 'error';
    if (handler) {
      pins.push(
        this.execOut('catch', 'Catch', this.blockInsert(handler.body)),
        this.dataOut('error', errorName, 'any', { sourceText: errorName })
      );
    }

    const finalizer = stmt.finalizer;
    if (finalizer) {
      pins.push(
        this.execOut('finally', 'Finally', this.blockInsert(finalizer))
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
      kind: 'try',
      title: 'Try',
      category: 'flow',
      purity: 'impure',
      range: rangeOf(stmt),
      pins,
      path,
      meta: this.statementMeta(stmt, inline),
    });
    this.chain(node, 'try');
    this.lowerStatements(stmt.block.body, `${path}/try`, false);

    if (handler) {
      this.cursor = { node: node.id, pin: 'catch' };
      this.withScope(() => {
        if (param?.type === 'Identifier') {
          this.declare(param.name, {
            source: { node: node.id, pin: 'error' },
            type: 'any',
          });
        }

        this.lowerStatements(handler.body.body, `${path}/catch`, false);
      });
    }

    if (finalizer) {
      this.cursor = { node: node.id, pin: 'finally' };
      this.lowerStatements(finalizer.body, `${path}/finally`, false);
    }

    this.cursor = { node: node.id, pin: 'completed' };
  }

  // ----------------------------------------------------------- expressions

  private lowerCall(
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

    const returnType: DataType =
      (knownName ? this.doc.functionReturnTypes.get(knownName) : undefined) ??
      (isNew && chain ? (chain.at(-1) ?? 'object') : 'any');

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
      : { sourceText: this.source(rangeOf(expr)) };
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

  private literal(
    kind: PinLiteral['kind'],
    value: string,
    raw: string,
    type: DataType
  ): ValueSource {
    return { literal: { kind, value, raw, editable: true }, type };
  }

  private pureNode(options: {
    kind: NodeKind;
    title: string;
    subtitle?: string;
    expr: t.Node;
    path: string;
    inputs: InputSpec[];
    outType: DataType;
    compact?: boolean;
    outName?: string;
    category?: NodeCategory;
  }): ValueSource {
    const range = rangeOf(options.expr);
    const node = this.addNode({
      kind: options.kind,
      title: options.title,
      subtitle: options.subtitle,
      category: options.category ?? 'pure',
      purity: 'pure',
      range,
      pins: [
        ...options.inputs.map((i) => i.pin),
        this.dataOut(
          'value',
          options.outName ?? '',
          options.outType,
          this.currentStatement
            ? {
                sourceText: this.source(range),
                scope: { ...this.currentStatement },
              }
            : { sourceText: this.source(range) },
          range
        ),
      ],
      path: options.path,
      compact: options.compact,
    });
    this.feedAll(node.id, options.inputs);
    return { pin: { node: node.id, pin: 'value' }, type: options.outType };
  }

  private getVar(
    name: string,
    expr: t.Node,
    path: string,
    type: DataType
  ): ValueSource {
    return this.pureNode({
      kind: 'getVar',
      title: name,
      expr,
      path,
      inputs: [],
      outType: type,
      compact: true,
      category: 'variable',
    });
  }

  private lowerExpr(
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
        if (expr.name === 'undefined') {
          return this.literal('undefined', 'undefined', raw, 'void');
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

  private lowerObject(
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

/** Variables bound by a declaration target, e.g. `{ a, b: [c] = [] }`. */
function bindingNames(pattern: t.Node | null | undefined): string[] {
  switch (pattern?.type) {
    case 'Identifier': {
      return [pattern.name];
    }

    case 'ObjectPattern': {
      return pattern.properties.flatMap((p) =>
        bindingNames(p.type === 'RestElement' ? p.argument : p.value)
      );
    }

    case 'ArrayPattern': {
      return pattern.elements.flatMap((e) => bindingNames(e));
    }

    case 'AssignmentPattern': {
      return bindingNames(pattern.left);
    }

    case 'RestElement': {
      return bindingNames(pattern.argument);
    }

    default: {
      return [];
    }
  }
}

/** Parses a file with Babel (TypeScript unless it is plain JavaScript). */
export function parseFile(
  text: string,
  fileName = 'file.ts'
): ReturnType<typeof parse> {
  const isJsLike = /\.[cm]?jsx?$/i.test(fileName);
  const isJsx = /\.[jt]sx$/i.test(fileName);
  return parse(text, {
    sourceType: 'unambiguous',
    errorRecovery: true,
    plugins: [
      ...(isJsLike ? [] : [['typescript', {}] as ['typescript', object]]),
      ...(isJsx || isJsLike ? ['jsx' as const] : []),
    ],
  });
}

export function parseTypeScript(
  text: string,
  fileName = 'file.ts'
): GraphDocument {
  const diagnostics: Diagnostic[] = [];
  let program: t.Program;
  let comments: SourceRange[] = [];
  try {
    const file = parseFile(text, fileName);
    program = file.program;
    comments = (file.comments ?? []).map((c) => ({
      start: c.start ?? 0,
      end: c.end ?? 0,
    }));
    for (const error of file.errors ?? []) {
      const pos = (error as { pos?: number }).pos ?? 0;
      diagnostics.push({
        message: (error as { message?: string }).message ?? String(error),
        range: { start: pos, end: pos + 1 },
        severity: 'error',
      });
    }
  } catch (error) {
    const pos = (error as { pos?: number }).pos ?? 0;
    diagnostics.push({
      message: error instanceof Error ? error.message : String(error),
      range: { start: pos, end: pos + 1 },
      severity: 'error',
    });
    return { language: LANGUAGE_ID, functions: [], diagnostics };
  }

  const lowering = new DocumentLowering(
    text,
    fileName.split('/').at(-1) ?? fileName
  );
  lowering.run(program);
  const doc: GraphDocument = {
    language: LANGUAGE_ID,
    functions: lowering.functions,
    diagnostics,
    symbols: typeScriptSymbols(program, text),
  };
  attachComments(doc, text, comments);
  linkSymbolGraphs(doc);
  completeCallPins(doc, text, { placeholder: 'undefined' });
  return doc;
}
