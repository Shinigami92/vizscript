import type { SyntaxNode, Tree } from '@lezer/common';
import { parser } from '@lezer/rust';
import type {
  Block,
  EnumItem,
  Expr,
  FieldInit,
  FunctionItem,
  IfStmt,
  ImplItem,
  Item,
  MatchArm,
  MatchStmt,
  Param,
  Pattern,
  SelfParam,
  Span,
  Stmt,
  StructItem,
  TraitItem,
  ValueItem,
} from './ast';

/**
 * Converts Lezer's concrete Rust syntax tree into the small typed AST the
 * lowering works with. Lezer is error tolerant, so this never throws: parts
 * it cannot make sense of become `Opaque` expressions or `Error` statements.
 */

export interface RustDiagnostic {
  message: string;
  start: number;
  end: number;
}

export interface ConvertResult {
  items: Item[];
  diagnostics: RustDiagnostic[];
  comments: Span[];
}

const COMMENTS = new Set(['LineComment', 'BlockComment']);

/** Tokens and helper nodes that are never expressions. */
const NOT_EXPRESSIONS = new Set([
  'ArgList',
  'ParamList',
  'TypeArgList',
  'TypeParamList',
  'Block',
  'MatchBlock',
  'FieldInitializerList',
  'LoopLabel',
  'ArithOp',
  'LogicOp',
  'BitOp',
  'CompareOp',
  'UpdateOp',
  'DerefOp',
  'Vis',
  'Attribute',
  'Guard',
]);

/**
 * Macros whose arguments are expressions (comma separated). Others keep
 * their tokens as they are.
 */
const EXPRESSION_MACROS = new Set([
  'println',
  'print',
  'eprintln',
  'eprint',
  'format',
  'format_args',
  'write',
  'writeln',
  'panic',
  'assert',
  'assert_eq',
  'assert_ne',
  'debug_assert',
  'debug_assert_eq',
  'debug_assert_ne',
  'dbg',
  'todo',
  'unimplemented',
  'unreachable',
  'vec',
]);

/** Block-like expressions: statements of their own without `;`. */
const BLOCK_LIKE = new Set([
  'IfExpression',
  'MatchExpression',
  'ForExpression',
  'WhileExpression',
  'LoopExpression',
  'Block',
  'UnsafeBlock',
  'AsyncBlock',
  'LabeledBlock',
  'ConstBlock',
  'TryBlock',
]);

const TYPE_NODES = new Set([
  'TypeIdentifier',
  'ScopedTypeIdentifier',
  'GenericType',
  'ReferenceType',
  'PointerType',
  'TupleType',
  'UnitType',
  'ArrayType',
  'FunctionType',
  'AbstractType',
  'DynamicType',
  'BoundedType',
  'SelfType',
  'MetaType',
  'InferredType',
  'EmptyType',
  'QualifiedScope',
]);

function children(node: SyntaxNode): SyntaxNode[] {
  const result: SyntaxNode[] = [];
  for (let kid = node.firstChild; kid; kid = kid.nextSibling) {
    if (!COMMENTS.has(kid.name)) {
      result.push(kid);
    }
  }

  return result;
}

function child(node: SyntaxNode, name: string): SyntaxNode | undefined {
  return children(node).find((c) => c.name === name);
}

function isExpression(node: SyntaxNode): boolean {
  if (node.name === 'self' || node.name === 'super' || node.name === 'crate') {
    return true;
  }

  return (
    /^[A-Z]/.test(node.name) &&
    !NOT_EXPRESSIONS.has(node.name) &&
    !TYPE_NODES.has(node.name)
  );
}

function unescapeRust(body: string): string {
  return body.replaceAll(
    /\\(x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]+\}|\n\s*|.)/gs,
    (_, c: string) => {
      switch (c[0]) {
        case 'n': {
          return '\n';
        }

        case 't': {
          return '\t';
        }

        case 'r': {
          return '\r';
        }

        case '0': {
          return '\0';
        }

        case 'x': {
          return String.fromCodePoint(Number.parseInt(c.slice(1), 16));
        }

        case 'u': {
          return String.fromCodePoint(
            Number.parseInt(c.slice(2, -1), 16) || 0xfffd
          );
        }

        case '\n': {
          return '';
        }

        default: {
          return c;
        }
      }
    }
  );
}

/** Prefix (`b`, `r#`), quotes and value of a string or char literal. */
export function splitString(raw: string): {
  prefix: string;
  open: string;
  close: string;
  value: string;
  raw: boolean;
} {
  const rawMatch = raw.match(/^(b?r)(#*)"/);
  if (rawMatch) {
    const hashes = rawMatch[2] ?? '';
    const open = `${rawMatch[1] ?? 'r'}${hashes}"`;
    const close = `"${hashes}`;
    const body = raw.endsWith(close)
      ? raw.slice(open.length, -close.length)
      : raw.slice(open.length);
    return { prefix: rawMatch[1] ?? 'r', open, close, value: body, raw: true };
  }

  const prefix = raw.match(/^[bc]?/)?.[0] ?? '';
  const quote = raw[prefix.length] ?? '"';
  const body =
    raw.length > prefix.length + 1 && raw.endsWith(quote)
      ? raw.slice(prefix.length + 1, -1)
      : raw.slice(prefix.length + 1);
  return {
    prefix,
    open: `${prefix}${quote}`,
    close: quote,
    value: unescapeRust(body),
    raw: false,
  };
}

/**
 * Lezer's Rust grammar fails on a reference right before a let chain
 * (`if let Some(a) = &b && let …`). The `&` is replaced by a space (same
 * length, so offsets stay valid); the graph shows the value without it.
 */
export function maskForParser(text: string, tree?: Tree): string {
  let masked = text;
  let current = tree ?? parser.parse(text);
  for (let round = 0; round < 8; round++) {
    const errors: number[] = [];
    current.iterate({
      enter: (node) => {
        if (node.type.isError) {
          errors.push(node.from);
        }
      },
    });
    let changed = false;
    for (const at of errors) {
      // The `&& let` next to the error, and the `= &` before it.
      const from = Math.max(0, at - 400);
      const window = masked.slice(from, at + 200);
      const chains = [...window.matchAll(/&&\s*let\b/g)];
      const chain =
        chains.findLast((c) => from + (c.index ?? 0) <= at + 1) ?? chains[0];
      if (chain?.index === undefined) {
        continue;
      }

      const before = window.slice(0, chain.index);
      const last = [...before.matchAll(/=\s*(&)(?![&=])/g)].at(-1);
      if (last?.index === undefined) {
        continue;
      }

      const offset = from + last.index + last[0].length - 1;
      masked = `${masked.slice(0, offset)} ${masked.slice(offset + 1)}`;
      changed = true;
    }

    if (!changed) {
      break;
    }

    current = parser.parse(masked);
  }

  return masked;
}

class Converter {
  public readonly diagnostics: RustDiagnostic[] = [];

  /**
   * `text` is what the nodes point into; `shift` turns their offsets into
   * offsets of the file (macro arguments are parsed on their own).
   */
  public constructor(
    private readonly text: string,
    private readonly shift = 0
  ) {}

  private span(node: { from: number; to: number }): Span {
    return { start: node.from + this.shift, end: node.to + this.shift };
  }

  private slice(node: { from: number; to: number }): string {
    return this.text.slice(node.from, node.to);
  }

  private error(node: SyntaxNode, message = 'Syntax error'): void {
    const start = node.from + this.shift;
    if (!this.diagnostics.some((d) => d.start === start)) {
      this.diagnostics.push({
        message,
        start,
        end: Math.max(node.to, node.from + 1) + this.shift,
      });
    }
  }

  // ----------------------------------------------------------------- items

  public file(tree: Tree): Item[] {
    const top = tree.topNode;
    const items: Item[] = [];
    for (const node of children(top)) {
      if (node.type.isError) {
        this.error(node);
        continue;
      }

      const item = this.item(node);
      if (item) {
        items.push(item);
      }
    }

    top.toTree().iterate({
      enter: (ref) => {
        if (ref.type.isError) {
          this.error(ref.node);
        }
      },
    });
    return items;
  }

  /** Visibility and other modifiers before the keyword of an item. */
  private modifiers(nodes: ReadonlyArray<SyntaxNode>, until: string): string[] {
    const result: string[] = [];
    for (const node of nodes) {
      if (node.name === until) {
        break;
      }

      if (node.name === 'Vis') {
        result.push(this.slice(node).replaceAll(/\s+/g, ''));
      } else if (node.name === 'extern') {
        result.push('extern');
      } else if (/^[a-z]+$/.test(node.name)) {
        result.push(node.name);
      }
    }

    return result;
  }

  private item(node: SyntaxNode, attributes: Span[] = []): Item | undefined {
    switch (node.name) {
      case 'AttributeItem': {
        const kids = children(node);
        const attrs = kids.filter((k) => k.name === 'Attribute');
        const inner = kids.find(
          (k) => k.name !== 'Attribute' && k.name !== '#'
        );
        const own = attrs.map((a) => ({
          start: this.text.lastIndexOf('#', a.from) + this.shift,
          end: a.to + 1 + this.shift,
        }));
        if (!inner) {
          return undefined;
        }

        const item = this.item(inner, [...attributes, ...own]);
        if (item) {
          item.start = Math.min(item.start, node.from + this.shift);
        }

        return item;
      }

      case 'FunctionItem': {
        return this.fn(node, attributes);
      }

      case 'StructItem':
      case 'UnionItem': {
        return this.struct(node, attributes);
      }

      case 'EnumItem': {
        return this.enumItem(node, attributes);
      }

      case 'ImplItem': {
        return this.impl(node);
      }

      case 'TraitItem': {
        return this.trait(node, attributes);
      }

      case 'ConstItem':
      case 'StaticItem': {
        return this.valueItem(node, attributes);
      }

      case 'ModItem': {
        const kids = children(node);
        const name = kids.find((k) => k.name === 'BoundIdentifier');
        const list = kids.find((k) => k.name === 'DeclarationList');
        return {
          type: 'Mod',
          ...this.span(node),
          name: name ? this.slice(name) : '',
          nameSpan: this.span(name ?? node),
          ...(list ? { items: this.declarations(list) } : {}),
        };
      }

      case 'UseDeclaration': {
        return { type: 'Use', ...this.span(node) };
      }

      case 'TypeItem': {
        const kids = children(node);
        const name = kids.find((k) => k.name === 'TypeIdentifier');
        const eq = kids.findIndex((k) => k.name === '=');
        const value = eq === -1 ? undefined : kids[eq + 1];
        return {
          type: 'TypeAlias',
          ...this.span(node),
          name: name ? this.slice(name) : '',
          nameSpan: this.span(name ?? node),
          modifiers: this.modifiers(kids, 'type'),
          ...(value ? { value: this.span(value) } : {}),
        };
      }

      case 'InnerAttribute':
      case 'LineComment':
      case 'BlockComment':
      case 'EmptyStatement':
      case ';': {
        return undefined;
      }

      default: {
        return { type: 'OtherItem', nodeName: node.name, ...this.span(node) };
      }
    }
  }

  private declarations(list: SyntaxNode): Item[] {
    const items: Item[] = [];
    for (const node of children(list)) {
      if (node.name === '{' || node.name === '}') {
        continue;
      }

      const item = this.item(node);
      if (item) {
        items.push(item);
      }
    }

    return items;
  }

  private fn(node: SyntaxNode, attributes: Span[]): FunctionItem {
    const kids = children(node);
    const name = kids.find((k) => k.name === 'BoundIdentifier');
    const params = kids.find((k) => k.name === 'ParamList');
    const arrow = kids.findIndex((k) => k.name === '->');
    const returns = arrow === -1 ? undefined : kids[arrow + 1];
    const body = kids.find((k) => k.name === 'Block');
    const converted = params ? this.params(params) : { params: [] };
    return {
      type: 'Function',
      ...this.span(node),
      name: name ? this.slice(name) : '',
      nameSpan: this.span(name ?? node),
      modifiers: this.modifiers(kids, 'fn'),
      headStart: node.from + this.shift,
      ...(converted.self ? { self: converted.self } : {}),
      params: converted.params,
      paramList: this.span(params ?? node),
      ...(returns && returns.name !== 'WhereClause' && returns.name !== 'Block'
        ? { returns: this.span(returns) }
        : {}),
      ...(body ? { body: this.block(body) } : {}),
      attributes,
    };
  }

  private params(list: SyntaxNode): { self?: SelfParam; params: Param[] } {
    let self: SelfParam | undefined;
    const params: Param[] = [];
    for (const node of children(list)) {
      if (node.name === 'SelfParameter') {
        self = { ...this.span(node), text: this.slice(node) };
      } else if (
        node.name === 'Parameter' ||
        node.name === 'VariadicParameter'
      ) {
        params.push(this.param(node));
      }
    }

    return self ? { self, params } : { params };
  }

  private param(node: SyntaxNode): Param {
    const kids = children(node);
    const colon = kids.findIndex((k) => k.name === ':');
    const mutable = kids[0]?.name === 'mut';
    const patternNodes = (colon === -1 ? kids : kids.slice(0, colon)).filter(
      (k) => k.name !== 'mut'
    );
    const first = patternNodes[0];
    const last = patternNodes.at(-1);
    const pattern =
      first && last
        ? { start: first.from + this.shift, end: last.to + this.shift }
        : this.span(node);
    const type = colon === -1 ? undefined : kids[colon + 1];
    const name =
      patternNodes.length === 1 && first?.name === 'BoundIdentifier'
        ? this.slice(first)
        : undefined;
    return {
      ...this.span(node),
      ...(name ? { name } : {}),
      pattern,
      ...(type ? { type: this.span(type) } : {}),
      mutable,
    };
  }

  private struct(node: SyntaxNode, attributes: Span[]): StructItem {
    const kids = children(node);
    const name = kids.find((k) => k.name === 'TypeIdentifier');
    const named = kids.find((k) => k.name === 'FieldDeclarationList');
    const ordered = kids.find((k) => k.name === 'OrderedFieldDeclarationList');
    const fields: StructItem['fields'] = [];
    if (named) {
      for (const field of children(named)) {
        if (field.name !== 'FieldDeclaration') {
          continue;
        }

        const parts = children(field);
        const fieldName = parts.find((p) => p.name === 'FieldIdentifier');
        const colon = parts.findIndex((p) => p.name === ':');
        const type = colon === -1 ? undefined : parts[colon + 1];
        if (!fieldName || !type) {
          continue;
        }

        fields.push({
          ...this.span(field),
          name: this.slice(fieldName),
          nameSpan: this.span(fieldName),
          type: this.span(type),
          modifiers: this.modifiers(parts, 'FieldIdentifier'),
        });
      }
    }

    const braces = named ? children(named) : [];
    const open = braces.find((b) => b.name === '{');
    const close = braces.find((b) => b.name === '}');
    return {
      type: 'Struct',
      ...this.span(node),
      name: name ? this.slice(name) : '',
      nameSpan: this.span(name ?? node),
      modifiers: this.modifiers(
        kids,
        node.name === 'UnionItem' ? 'union' : 'struct'
      ),
      fields,
      tuple: ordered !== undefined,
      ...(open ? { open: open.to + this.shift } : {}),
      ...(close ? { close: close.from + this.shift } : {}),
      attributes,
    };
  }

  private enumItem(node: SyntaxNode, attributes: Span[]): EnumItem {
    const kids = children(node);
    const name = kids.find((k) => k.name === 'TypeIdentifier');
    const list = kids.find((k) => k.name === 'EnumVariantList');
    const variants: string[] = [];
    for (const variant of list ? children(list) : []) {
      const id =
        variant.name === 'EnumVariant'
          ? children(variant).find((v) => v.name === 'Identifier')
          : variant.name === 'AttributeItem'
            ? children(variant)
                .find((v) => v.name === 'EnumVariant')
                ?.getChild('Identifier')
            : undefined;
      if (id) {
        variants.push(this.slice(id));
      }
    }

    return {
      type: 'Enum',
      ...this.span(node),
      name: name ? this.slice(name) : '',
      nameSpan: this.span(name ?? node),
      modifiers: this.modifiers(kids, 'enum'),
      variants,
      attributes,
    };
  }

  /** Name of a type as written, without generics and paths (`Vec`). */
  private typeName(node: SyntaxNode | undefined): string {
    if (!node) {
      return '';
    }

    switch (node.name) {
      case 'GenericType': {
        return this.typeName(children(node)[0]);
      }

      case 'ScopedTypeIdentifier': {
        const last = children(node).at(-1);
        return last ? this.slice(last) : this.slice(node);
      }

      case 'ReferenceType':
      case 'PointerType': {
        return this.typeName(children(node).at(-1));
      }

      default: {
        return this.slice(node);
      }
    }
  }

  private impl(node: SyntaxNode): ImplItem {
    const kids = children(node);
    const types = kids.filter((k) => TYPE_NODES.has(k.name));
    const forAt = kids.findIndex((k) => k.name === 'for');
    const list = kids.find((k) => k.name === 'DeclarationList');
    const target =
      forAt === -1
        ? types[0]
        : kids.slice(forAt + 1).find((k) => TYPE_NODES.has(k.name));
    const traitNode = forAt === -1 ? undefined : types[0];
    const braces = list ? children(list) : [];
    const open = braces.find((b) => b.name === '{');
    const close = braces.find((b) => b.name === '}');
    return {
      type: 'Impl',
      ...this.span(node),
      target: this.typeName(target),
      ...(traitNode ? { trait: this.typeName(traitNode) } : {}),
      items: list ? this.declarations(list) : [],
      open: (open?.to ?? node.to) + this.shift,
      close: (close?.from ?? node.to) + this.shift,
    };
  }

  private trait(node: SyntaxNode, attributes: Span[]): TraitItem {
    const kids = children(node);
    const name = kids.find((k) => k.name === 'TypeIdentifier');
    const list = kids.find((k) => k.name === 'DeclarationList');
    return {
      type: 'Trait',
      ...this.span(node),
      name: name ? this.slice(name) : '',
      nameSpan: this.span(name ?? node),
      modifiers: this.modifiers(kids, 'trait'),
      items: list ? this.declarations(list) : [],
      attributes,
    };
  }

  private valueItem(node: SyntaxNode, attributes: Span[]): ValueItem {
    const kids = children(node);
    const name = kids.find((k) => k.name === 'BoundIdentifier');
    const colon = kids.findIndex((k) => k.name === ':');
    const eq = kids.findIndex((k) => k.name === '=');
    const type = colon === -1 ? undefined : kids[colon + 1];
    const value = eq === -1 ? undefined : kids[eq + 1];
    const isConst = node.name === 'ConstItem';
    return {
      type: isConst ? 'Const' : 'Static',
      ...this.span(node),
      name: name ? this.slice(name) : '',
      nameSpan: this.span(name ?? node),
      modifiers: this.modifiers(kids, isConst ? 'const' : 'static'),
      mutable: kids.some((k) => k.name === 'mut'),
      ...(type ? { valueType: this.span(type) } : {}),
      ...(value ? { value: this.expr(value) } : {}),
      attributes,
    };
  }

  // ------------------------------------------------------------ statements

  public block(node: SyntaxNode): Block {
    const kids = children(node);
    const open = kids.find((k) => k.name === '{');
    const close = kids.findLast((k) => k.name === '}');
    const body: Stmt[] = [];
    for (const kid of kids) {
      if (kid.name === '{' || kid.name === '}') {
        continue;
      }

      const stmt = this.statement(kid);
      if (stmt) {
        body.push(stmt);
      }
    }

    return {
      ...this.span(node),
      body,
      open: (open?.to ?? node.from) + this.shift,
      close: (close?.from ?? node.to) + this.shift,
    };
  }

  private statement(node: SyntaxNode): Stmt | undefined {
    if (node.type.isError) {
      this.error(node);
      return { type: 'Error', nodeName: '⚠', ...this.span(node) };
    }

    switch (node.name) {
      case 'LetDeclaration': {
        return this.letStatement(node);
      }

      case 'ExpressionStatement': {
        const kids = children(node);
        const inner = kids.find((k) => k.name !== ';');
        if (!inner) {
          return { type: 'Empty', ...this.span(node) };
        }

        const semicolon = kids.at(-1)?.name === ';';
        return this.expressionStatement(inner, node, semicolon);
      }

      case 'MacroInvocation': {
        const value = this.expr(node);
        const semicolon = children(node).at(-1)?.name === ';';
        return { type: 'Expr', ...this.span(node), value, semicolon };
      }

      case 'EmptyStatement':
      case ';': {
        return { type: 'Empty', ...this.span(node) };
      }

      default: {
        const item = this.item(node);
        return item ? { type: 'Item', ...this.span(node), item } : undefined;
      }
    }
  }

  private letStatement(node: SyntaxNode): Stmt {
    const kids = children(node);
    const mutable = kids[1]?.name === 'mut';
    const patternNode = kids.find(
      (k, i) => i > 0 && k.name !== 'mut' && k.name !== 'let'
    );
    const colon = kids.findIndex((k) => k.name === ':');
    const eq = kids.findIndex((k) => k.name === '=');
    const elseAt = kids.findIndex((k) => k.name === 'else');
    const type = colon === -1 ? undefined : kids[colon + 1];
    const value = eq === -1 ? undefined : kids[eq + 1];
    const orelse = elseAt === -1 ? undefined : kids[elseAt + 1];
    return {
      type: 'Let',
      ...this.span(node),
      pattern: this.pattern(patternNode ?? node, mutable),
      mutable,
      ...(type ? { valueType: this.span(type) } : {}),
      ...(value ? { value: this.expr(value) } : {}),
      ...(orelse?.name === 'Block' ? { orelse: this.block(orelse) } : {}),
    };
  }

  private label(node: SyntaxNode): string | undefined {
    const label = child(node, 'LoopLabel');
    return label ? this.slice(label) : undefined;
  }

  private expressionStatement(
    inner: SyntaxNode,
    stmt: SyntaxNode,
    semicolon: boolean
  ): Stmt {
    const span = this.span(stmt);
    switch (inner.name) {
      case 'AssignmentExpression': {
        const kids = children(inner);
        const op = kids.find((k) => k.name === '=' || k.name === 'UpdateOp');
        const opAt = op ? kids.indexOf(op) : 1;
        const target = kids[0];
        const value = kids[opAt + 1];
        return {
          type: 'Assign',
          ...span,
          target: target ? this.expr(target) : this.opaque(inner),
          op: op ? this.slice(op) : '=',
          value: value ? this.expr(value) : this.opaque(inner),
        };
      }

      case 'IfExpression': {
        return { ...this.ifStatement(inner), ...span };
      }

      case 'MatchExpression': {
        return { ...this.matchStatement(inner), ...span };
      }

      case 'ForExpression': {
        const kids = children(inner);
        const forAt = kids.findIndex((k) => k.name === 'for');
        const inAt = kids.findIndex((k) => k.name === 'in');
        const patternNode = kids[forAt + 1];
        const iter = kids[inAt + 1];
        const body = kids.find((k) => k.name === 'Block');
        const label = this.label(inner);
        return {
          type: 'For',
          ...span,
          pattern: this.pattern(patternNode ?? inner, false),
          iter: iter ? this.expr(iter) : this.opaque(inner),
          body: body ? this.block(body) : this.emptyBlock(inner),
          ...(label ? { label } : {}),
        };
      }

      case 'WhileExpression': {
        const kids = children(inner);
        const whileAt = kids.findIndex((k) => k.name === 'while');
        const condition = kids[whileAt + 1];
        const body = kids.find((k) => k.name === 'Block');
        const label = this.label(inner);
        return {
          type: 'While',
          ...span,
          condition: condition ? this.condition(condition) : this.opaque(inner),
          body: body ? this.block(body) : this.emptyBlock(inner),
          ...(label ? { label } : {}),
        };
      }

      case 'LoopExpression': {
        const body = child(inner, 'Block');
        const label = this.label(inner);
        return {
          type: 'Loop',
          ...span,
          body: body ? this.block(body) : this.emptyBlock(inner),
          ...(label ? { label } : {}),
        };
      }

      case 'ReturnExpression': {
        const value = children(inner).find((k) => k.name !== 'return');
        return {
          type: 'Return',
          ...span,
          ...(value ? { value: this.expr(value) } : {}),
        };
      }

      case 'BreakExpression': {
        const value = children(inner).find(
          (k) => k.name !== 'break' && k.name !== 'LoopLabel'
        );
        const label = this.label(inner);
        return {
          type: 'Break',
          ...span,
          ...(label ? { label } : {}),
          ...(value ? { value: this.expr(value) } : {}),
        };
      }

      case 'ContinueExpression': {
        const label = this.label(inner);
        return { type: 'Continue', ...span, ...(label ? { label } : {}) };
      }

      case 'Block':
      case 'UnsafeBlock':
      case 'AsyncBlock':
      case 'LabeledBlock':
      case 'ConstBlock':
      case 'TryBlock': {
        const block = inner.name === 'Block' ? inner : child(inner, 'Block');
        return {
          type: 'BlockStmt',
          ...span,
          block: block ? this.block(block) : this.emptyBlock(inner),
          label: this.blockLabel(inner),
        };
      }

      default: {
        return {
          type: 'Expr',
          ...span,
          value: this.expr(inner),
          semicolon: semicolon || BLOCK_LIKE.has(inner.name),
        };
      }
    }
  }

  private blockLabel(node: SyntaxNode): string {
    switch (node.name) {
      case 'UnsafeBlock': {
        return 'unsafe';
      }

      case 'AsyncBlock': {
        return children(node).some((k) => k.name === 'move')
          ? 'async move'
          : 'async';
      }

      case 'ConstBlock': {
        return 'const';
      }

      case 'TryBlock': {
        return 'try';
      }

      case 'LabeledBlock': {
        return this.label(node) ?? '';
      }

      default: {
        return '';
      }
    }
  }

  private emptyBlock(node: SyntaxNode): Block {
    return {
      start: node.to + this.shift,
      end: node.to + this.shift,
      body: [],
      open: node.to + this.shift,
      close: node.to + this.shift,
    };
  }

  public ifStatement(node: SyntaxNode): IfStmt {
    const kids = children(node);
    const ifAt = kids.findIndex((k) => k.name === 'if');
    const condition = kids[ifAt + 1];
    const body = kids.find((k) => k.name === 'Block');
    const elseAt = kids.findIndex((k) => k.name === 'else');
    const next = elseAt === -1 ? undefined : kids[elseAt + 1];
    const stmt: IfStmt = {
      type: 'If',
      ...this.span(node),
      condition: condition ? this.condition(condition) : this.opaque(node),
      body: body ? this.block(body) : this.emptyBlock(node),
      elifs: [],
    };
    if (next?.name === 'IfExpression') {
      const nested = this.ifStatement(next);
      stmt.elifs.push(
        {
          start: nested.start,
          end: nested.body.end,
          condition: nested.condition,
          body: nested.body,
        },
        ...nested.elifs
      );
      if (nested.orelse) {
        stmt.orelse = nested.orelse;
      }
    } else if (next?.name === 'Block') {
      stmt.orelse = this.block(next);
    }

    return stmt;
  }

  public matchStatement(node: SyntaxNode): MatchStmt {
    const kids = children(node);
    const matchAt = kids.findIndex((k) => k.name === 'match');
    const subject = kids[matchAt + 1];
    const block = kids.find((k) => k.name === 'MatchBlock');
    const arms: MatchArm[] = [];
    for (const arm of block ? children(block) : []) {
      if (arm.name !== 'MatchArm') {
        continue;
      }

      const parts = children(arm).filter((p) => p.name !== 'Attribute');
      const arrow = parts.findIndex((p) => p.name === '=>');
      const guardNode = parts.find((p) => p.name === 'Guard');
      const patternParts = parts.slice(
        0,
        guardNode ? parts.indexOf(guardNode) : arrow === -1 ? 1 : arrow
      );
      const bodyNode = arrow === -1 ? undefined : parts[arrow + 1];
      const first = patternParts[0];
      const last = patternParts.at(-1);
      const pattern = first && last ? this.patternSpan(first, last) : undefined;
      const guardExpr = guardNode
        ? children(guardNode).find((g) => g.name !== 'if')
        : undefined;
      arms.push({
        ...this.span(arm),
        pattern: pattern ?? { ...this.span(arm), bindings: [] },
        ...(guardExpr ? { guard: this.condition(guardExpr) } : {}),
        body: !bodyNode
          ? this.opaque(arm)
          : bodyNode.name === 'Block'
            ? this.block(bodyNode)
            : this.expr(bodyNode),
      });
    }

    return {
      type: 'Match',
      ...this.span(node),
      subject: subject ? this.expr(subject) : this.opaque(node),
      arms,
    };
  }

  // -------------------------------------------------------------- patterns

  private bindings(node: SyntaxNode): Pattern['bindings'] {
    const result: Pattern['bindings'] = [];
    node.toTree().iterate({
      enter: (ref) => {
        if (ref.name === 'BoundIdentifier') {
          const from = ref.from + node.from;
          const to = ref.to + node.from;
          result.push({
            name: this.text.slice(from, to),
            start: from + this.shift,
            end: to + this.shift,
          });
        }

        return ref.name !== 'MacroInvocation';
      },
    });
    return result;
  }

  private patternSpan(first: SyntaxNode, last: SyntaxNode): Pattern {
    const bindings: Pattern['bindings'] = [];
    for (let n: SyntaxNode | null = first; n; n = n.nextSibling) {
      if (n.name === 'BoundIdentifier') {
        bindings.push({ name: this.slice(n), ...this.span(n) });
      } else {
        bindings.push(...this.bindings(n));
      }

      if (n === last) {
        break;
      }
    }

    const span = { start: first.from + this.shift, end: last.to + this.shift };
    return first === last && first.name === 'BoundIdentifier'
      ? { ...span, bindings, simple: this.slice(first) }
      : { ...span, bindings };
  }

  private pattern(node: SyntaxNode, mutable: boolean): Pattern {
    if (node.name === 'BoundIdentifier' || node.name === 'Identifier') {
      const name = this.slice(node);
      return {
        ...this.span(node),
        bindings: [{ name, ...this.span(node) }],
        simple: name,
      };
    }

    if (node.name === 'MutPattern' && !mutable) {
      const inner = children(node).at(-1);
      if (inner?.name === 'BoundIdentifier') {
        const name = this.slice(inner);
        return {
          ...this.span(node),
          bindings: [{ name, ...this.span(inner) }],
          simple: name,
        };
      }
    }

    return { ...this.span(node), bindings: this.bindings(node) };
  }

  // ------------------------------------------------------------ expressions

  private opaque(node: SyntaxNode): Expr {
    return { type: 'Opaque', nodeName: node.name, ...this.span(node) };
  }

  /** A condition: an expression, a `let` or a let chain. */
  private condition(node: SyntaxNode): Expr {
    if (node.name === 'LetDeclaration') {
      const kids = children(node);
      const eq = kids.findIndex((k) => k.name === '=');
      const patternNode = kids.find(
        (k, i) => i > 0 && i < eq && k.name !== 'mut'
      );
      const value = eq === -1 ? undefined : kids[eq + 1];
      return {
        type: 'Let',
        ...this.span(node),
        pattern: this.pattern(patternNode ?? node, false),
        value: value ? this.expr(value) : this.opaque(node),
      };
    }

    if (node.name === 'LetChain') {
      return {
        type: 'LetChain',
        ...this.span(node),
        parts: children(node)
          .filter((k) => k.name !== 'LogicOp' && k.name !== '&&')
          .map((k) => this.condition(k)),
      };
    }

    return this.expr(node);
  }

  public expr(node: SyntaxNode): Expr {
    const span = this.span(node);
    switch (node.name) {
      case 'Identifier':
      case 'self':
      case 'super':
      case 'crate':
      case 'Metavariable':
      case 'ScopedIdentifier':
      case 'TypeIdentifier':
      case 'ScopedTypeIdentifier': {
        return {
          type: 'Name',
          ...span,
          name: this.slice(node).replaceAll(/\s+/g, ''),
        };
      }

      case 'Integer': {
        return {
          type: 'Literal',
          ...span,
          kind: 'int',
          value: this.slice(node),
        };
      }

      case 'Float': {
        return {
          type: 'Literal',
          ...span,
          kind: 'float',
          value: this.slice(node),
        };
      }

      case 'Boolean': {
        return {
          type: 'Literal',
          ...span,
          kind: 'bool',
          value: this.slice(node),
        };
      }

      case 'String':
      case 'RawString': {
        const raw = this.slice(node);
        return {
          type: 'Literal',
          ...span,
          kind: raw.startsWith('b') ? 'bytes' : 'string',
          value: splitString(raw).value,
        };
      }

      case 'Char': {
        const raw = this.slice(node);
        return {
          type: 'Literal',
          ...span,
          kind: 'char',
          value: splitString(raw).value,
        };
      }

      case 'UnitExpression': {
        return { type: 'Literal', ...span, kind: 'unit', value: '()' };
      }

      case 'ParenthesizedExpression': {
        const inner = children(node).find(isExpression);
        return inner
          ? { type: 'Paren', ...span, expr: this.expr(inner) }
          : this.opaque(node);
      }

      case 'FieldExpression': {
        const kids = children(node);
        const object = kids[0];
        const name = kids.at(-1);
        return object && name && name !== object
          ? {
              type: 'Field',
              ...span,
              object: this.expr(object),
              name: this.slice(name),
            }
          : this.opaque(node);
      }

      case 'IndexExpression': {
        const kids = children(node).filter(isExpression);
        const [object, index] = kids;
        return object && index
          ? {
              type: 'Index',
              ...span,
              object: this.expr(object),
              index: this.expr(index),
            }
          : this.opaque(node);
      }

      case 'CallExpression': {
        return this.call(node);
      }

      case 'MacroInvocation': {
        return this.macro(node);
      }

      case 'BinaryExpression': {
        const kids = children(node);
        const [left, op, right] = kids;
        return left && op && right
          ? {
              type: 'Binary',
              ...span,
              op: this.slice(op),
              left: this.expr(left),
              right: this.expr(right),
            }
          : this.opaque(node);
      }

      case 'UnaryExpression': {
        const [op, argument] = children(node);
        return op && argument
          ? {
              type: 'Unary',
              ...span,
              op: this.slice(op),
              argument: this.expr(argument),
            }
          : this.opaque(node);
      }

      case 'ReferenceExpression': {
        const kids = children(node);
        const argument = kids.at(-1);
        return argument && isExpression(argument)
          ? {
              type: 'Ref',
              ...span,
              mutable: kids.some((k) => k.name === 'mut'),
              argument: this.expr(argument),
            }
          : this.opaque(node);
      }

      case 'TypeCastExpression': {
        const kids = children(node);
        const asAt = kids.findIndex((k) => k.name === 'as');
        const value = kids[0];
        const target = kids[asAt + 1];
        return value && target && asAt !== -1
          ? {
              type: 'Cast',
              ...span,
              value: this.expr(value),
              target: this.span(target),
            }
          : this.opaque(node);
      }

      case 'RangeExpression': {
        const kids = children(node);
        const opAt = kids.findIndex((k) => k.name === '..' || k.name === '...');
        const from = opAt > 0 ? kids[0] : undefined;
        const to = opAt === -1 ? undefined : kids[opAt + 1];
        const opText = opAt === -1 ? '..' : this.slice(kids[opAt] ?? node);
        // `..=` is two tokens in Lezer: `..` and `=`.
        const inclusive = to?.name === '=';
        const end = inclusive ? kids[opAt + 2] : to;
        return {
          type: 'Range',
          ...span,
          op: inclusive ? '..=' : opText,
          ...(from ? { from: this.expr(from) } : {}),
          ...(end ? { to: this.expr(end) } : {}),
        };
      }

      case 'TryExpression': {
        const value = children(node)[0];
        return value
          ? { type: 'Try', ...span, value: this.expr(value) }
          : this.opaque(node);
      }

      case 'AwaitExpression': {
        const value = children(node)[0];
        return value
          ? { type: 'Await', ...span, value: this.expr(value) }
          : this.opaque(node);
      }

      case 'StructExpression': {
        return this.structExpr(node);
      }

      case 'ArrayExpression': {
        const kids = children(node);
        return {
          type: 'Array',
          ...span,
          items: kids.filter(isExpression).map((k) => this.expr(k)),
          ...(kids.some((k) => k.name === ';') ? { repeat: true } : {}),
        };
      }

      case 'TupleExpression': {
        return {
          type: 'Tuple',
          ...span,
          items: children(node)
            .filter(isExpression)
            .map((k) => this.expr(k)),
        };
      }

      case 'ClosureExpression': {
        const kids = children(node);
        const params = kids.find((k) => k.name === 'ParamList');
        const arrow = kids.findIndex((k) => k.name === '->');
        const body = kids.at(-1);
        return {
          type: 'Closure',
          ...span,
          params: params ? this.params(params).params : [],
          body: !body
            ? this.opaque(node)
            : body.name === 'Block'
              ? this.block(body)
              : this.expr(body),
          isAsync: kids.some((k) => k.name === 'async'),
          isMove: kids.some((k) => k.name === 'move'),
          ...(arrow === -1 || !kids[arrow + 1]
            ? {}
            : { returns: this.span(kids[arrow + 1] as SyntaxNode) }),
        };
      }

      case 'IfExpression': {
        return { type: 'If', ...span, stmt: this.ifStatement(node) };
      }

      case 'MatchExpression': {
        return { type: 'Match', ...span, stmt: this.matchStatement(node) };
      }

      case 'Block':
      case 'UnsafeBlock':
      case 'AsyncBlock':
      case 'LabeledBlock':
      case 'ConstBlock':
      case 'TryBlock': {
        const block = node.name === 'Block' ? node : child(node, 'Block');
        return block
          ? {
              type: 'Block',
              ...span,
              block: this.block(block),
              label: this.blockLabel(node),
            }
          : this.opaque(node);
      }

      case 'LetDeclaration':
      case 'LetChain': {
        return this.condition(node);
      }

      default: {
        if (node.type.isError) {
          this.error(node);
        }

        return this.opaque(node);
      }
    }
  }

  private call(node: SyntaxNode): Expr {
    const kids = children(node);
    let callee = kids[0];
    const args = kids.find((k) => k.name === 'ArgList');
    let turbofish: Span | undefined;
    if (callee?.name === 'GenericFunction') {
      const parts = children(callee);
      const sep = parts.find((p) => p.name === '::');
      const list = parts.find((p) => p.name === 'TypeArgList');
      if (sep && list) {
        turbofish = { start: sep.from + this.shift, end: list.to + this.shift };
      }

      callee = parts[0];
    }

    if (!callee || !args) {
      return this.opaque(node);
    }

    const argKids = children(args);
    const open = argKids.find((a) => a.name === '(');
    const close = argKids.findLast((a) => a.name === ')');
    return {
      type: 'Call',
      ...this.span(node),
      callee: this.expr(callee),
      args: argKids.filter(isExpression).map((a) => this.expr(a)),
      ...(turbofish ? { turbofish } : {}),
      open: (open?.to ?? args.from) + this.shift,
      close: (close?.from ?? args.to) + this.shift,
    };
  }

  private macro(node: SyntaxNode): Expr {
    const kids = children(node);
    const nameNode = kids[0];
    const tokens = kids.find(
      (k) =>
        k.name === 'ParenthesizedTokens' ||
        k.name === 'BracketedTokens' ||
        k.name === 'BracedTokens'
    );
    const name = nameNode ? this.slice(nameNode).replaceAll(/\s+/g, '') : '';
    const end = tokens?.to ?? node.to;
    const span = { start: node.from + this.shift, end: end + this.shift };
    const open = (tokens ? tokens.from + 1 : end) + this.shift;
    const close =
      (tokens ? Math.max(tokens.from + 1, tokens.to - 1) : end) + this.shift;
    const base: Extract<Expr, { type: 'Macro' }> = {
      type: 'Macro',
      ...span,
      name,
      open,
      close,
    };
    const bare = name.split('::').at(-1) ?? name;
    if (!tokens || !EXPRESSION_MACROS.has(bare)) {
      return base;
    }

    const inner = this.text.slice(open - this.shift, close - this.shift);
    const parsed = parseMacroArguments(inner, open, bare === 'vec');
    if (!parsed) {
      return base;
    }

    return {
      ...base,
      args: parsed.args,
      ...(parsed.repeat ? { repeat: true } : {}),
    };
  }

  private structExpr(node: SyntaxNode): Expr {
    const kids = children(node);
    const nameNode = kids[0];
    const list = kids.find((k) => k.name === 'FieldInitializerList');
    const fields: FieldInit[] = [];
    let base: Expr | undefined;
    for (const field of list ? children(list) : []) {
      if (field.name === 'ShorthandFieldInitializer') {
        const id = children(field)[0];
        if (id) {
          const name = this.slice(id);
          fields.push({
            ...this.span(field),
            name,
            nameSpan: this.span(id),
          });
        }
      } else if (field.name === 'FieldInitializer') {
        const parts = children(field);
        const id = parts[0];
        const colon = parts.findIndex((p) => p.name === ':');
        const value = colon === -1 ? undefined : parts[colon + 1];
        if (id && value) {
          fields.push({
            ...this.span(field),
            name: this.slice(id),
            nameSpan: this.span(id),
            value: this.expr(value),
          });
        }
      } else if (field.name === 'BaseFieldInitializer') {
        const value = children(field).find(isExpression);
        if (value) {
          base = this.expr(value);
        }
      }
    }

    return {
      type: 'Struct',
      ...this.span(node),
      name: nameNode ? this.slice(nameNode).replaceAll(/\s+/g, '') : '',
      fields,
      ...(base ? { base } : {}),
    };
  }

  /** Items of a file parsed for its macro arguments. */
  public argumentsOf(
    tree: Tree,
    repeatable: boolean
  ):
    | {
        args: Expr[];
        repeat?: boolean;
      }
    | undefined {
    const fn = children(tree.topNode).find((n) => n.name === 'FunctionItem');
    const block = fn ? child(fn, 'Block') : undefined;
    const stmt = block
      ? children(block).find((k) => k.name === 'ExpressionStatement')
      : undefined;
    const expr = stmt ? children(stmt).find((k) => k.name !== ';') : undefined;
    if (!expr) {
      return undefined;
    }

    let hasError = false;
    expr.toTree().iterate({
      enter: (ref) => {
        if (ref.type.isError) {
          hasError = true;
        }
      },
    });
    if (hasError) {
      return undefined;
    }

    if (repeatable && expr.name === 'ArrayExpression') {
      const kids = children(expr);
      return {
        args: kids.filter(isExpression).map((k) => this.expr(k)),
        ...(kids.some((k) => k.name === ';') ? { repeat: true } : {}),
      };
    }

    const args =
      expr.name === 'CallExpression' ? child(expr, 'ArgList') : undefined;
    return args
      ? {
          args: children(args)
            .filter(isExpression)
            .map((a) => this.expr(a)),
        }
      : undefined;
  }
}

/**
 * Parses the arguments of a macro (`println!("{}", x)`) as expressions:
 * the tokens go into a function call (`vec!` into an array) of a tiny file.
 */
function parseMacroArguments(
  inner: string,
  offset: number,
  repeatable: boolean
): { args: Expr[]; repeat?: boolean } | undefined {
  if (inner.trim() === '') {
    return { args: [] };
  }

  const prefix = repeatable ? 'fn f(){[' : 'fn f(){f(';
  const suffix = repeatable ? ']}' : ')}';
  const text = `${prefix}${inner}${suffix}`;
  const converter = new Converter(text, offset - prefix.length);
  return converter.argumentsOf(parser.parse(text), repeatable);
}

/** Parses Rust source into the AST used by the lowering. */
export function parseRust(text: string): ConvertResult {
  const first = parser.parse(text);
  const masked = maskForParser(text, first);
  const tree = masked === text ? first : parser.parse(masked);
  const converter = new Converter(masked);
  const items = converter.file(tree);
  const comments: Span[] = [];
  tree.iterate({
    enter: (node) => {
      if (COMMENTS.has(node.name)) {
        comments.push({ start: node.from, end: node.to });
      }
    },
  });
  return { items, diagnostics: converter.diagnostics, comments };
}

/** The Lezer tree of a file (with the parser workarounds applied). */
export function parseRustTree(text: string): { tree: Tree; text: string } {
  const first = parser.parse(text);
  const masked = maskForParser(text, first);
  return { tree: masked === text ? first : parser.parse(masked), text: masked };
}
