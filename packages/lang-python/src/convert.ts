import type { SyntaxNode, Tree } from '@lezer/common';
import { parser } from '@lezer/python';
import type {
  Arg,
  Block,
  ClassDef,
  Expr,
  FunctionDef,
  Handler,
  IfStmt,
  Param,
  Span,
  Stmt,
} from './ast';

/**
 * Converts Lezer's concrete Python syntax tree into the small typed AST the
 * lowering works with. Lezer is error tolerant, so this never throws: parts
 * it cannot make sense of become `Opaque` expressions or `Error` statements.
 */

export interface PythonDiagnostic {
  message: string;
  start: number;
  end: number;
}

/** Node types that are never expressions on their own. */
const NOT_EXPRESSIONS = new Set([
  'AssignOp',
  'UpdateOp',
  'ArithOp',
  'CompareOp',
  'BitOp',
  'TypeDef',
  'ArgList',
  'ParamList',
  'Body',
  'Comment',
  'Decorator',
  'At',
  'MatchBody',
  'MatchClause',
  'FormatReplacement',
  'FormatSpec',
  'FormatConversion',
  'PropertyName',
]);

function children(node: SyntaxNode): SyntaxNode[] {
  const result: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name !== 'Comment') {
      result.push(child);
    }
  }

  return result;
}

function isExpression(node: SyntaxNode): boolean {
  return /^[A-Z]/.test(node.name) && !NOT_EXPRESSIONS.has(node.name);
}

function unescapePython(body: string): string {
  return body.replaceAll(
    /\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|.)/gs,
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

        case 'x':
        case 'u': {
          return c.length > 1
            ? String.fromCodePoint(Number.parseInt(c.slice(1), 16))
            : c;
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

/** Prefix, quote and unescaped content of a Python string literal. */
export function splitString(raw: string): {
  prefix: string;
  quote: string;
  body: string;
  value: string;
} {
  const prefix = raw.match(/^[rRbBuUfF]*/)?.[0] ?? '';
  const rest = raw.slice(prefix.length);
  const quote = rest.startsWith('"""')
    ? '"""'
    : rest.startsWith("'''")
      ? "'''"
      : (rest[0] ?? '"');
  const body =
    rest.endsWith(quote) && rest.length >= quote.length * 2
      ? rest.slice(quote.length, -quote.length)
      : rest.slice(quote.length);
  const isRaw = /r/i.test(prefix);
  return { prefix, quote, body, value: isRaw ? body : unescapePython(body) };
}

/**
 * Lezer's Python grammar rejects a few valid constructs. Two of them leave
 * the tree intact and only add an error node, which is ignored:
 * - a bare `yield` (an empty error node where the value would be),
 * - star targets in comprehensions (`[a for a, *rest in xs]`).
 */
function isKnownGap(node: SyntaxNode, text: string): boolean {
  const parent = node.parent?.name ?? '';
  if (parent === 'YieldStatement' && node.from === node.to) {
    return true;
  }

  return /Comprehension/.test(parent) && text.slice(node.from, node.to) === '*';
}

/**
 * Same-length rewrite of constructs the grammar cannot parse, so offsets
 * stay valid: `with x as (a, b):` becomes `with x as _a__b_:` (only for the
 * parser; names shown in the graph come from the original text).
 */
export function maskForParser(text: string): string {
  return text.replaceAll(
    /^([ \t]*(?:async[ \t]+)?with\b[^\n]*?\bas[ \t]+)\(([\w\s,*]*)\)/gm,
    (_, head: string, inner: string) =>
      `${head}_${inner.replaceAll(/[^\w]/g, '_')}_`
  );
}

class Converter {
  public readonly diagnostics: PythonDiagnostic[] = [];

  public constructor(private readonly text: string) {}

  private src(span: Span | SyntaxNode): string {
    return 'from' in span
      ? this.text.slice(span.from, span.to)
      : this.text.slice(span.start, span.end);
  }

  /** End of a range without trailing whitespace. */
  private trimmedEnd(start: number, end: number): number {
    let e = end;
    while (e > start && /\s/.test(this.text[e - 1] ?? '')) {
      e--;
    }

    return e;
  }

  private span(node: SyntaxNode): Span {
    return { start: node.from, end: this.trimmedEnd(node.from, node.to) };
  }

  // ------------------------------------------------------------ statements

  public script(tree: Tree): Stmt[] {
    tree.iterate({
      enter: (node) => {
        if (node.type.isError && !isKnownGap(node.node, this.text)) {
          this.diagnostics.push({
            message: 'Syntax error',
            start: node.from,
            end: Math.max(node.to, node.from + 1),
          });
        }
      },
    });
    return this.statements(children(tree.topNode));
  }

  private statements(nodes: ReadonlyArray<SyntaxNode>): Stmt[] {
    return nodes.flatMap((node) => this.statement(node));
  }

  private block(body: SyntaxNode | undefined, fallback: number): Block {
    if (!body) {
      return {
        body: [],
        inline: false,
        colonEnd: fallback,
        start: fallback,
        end: fallback,
      };
    }

    const kids = children(body);
    const colon = kids[0]?.name === ':' ? kids.shift() : undefined;
    const colonEnd = colon?.to ?? body.from;
    const stmts = this.statements(kids);
    const first = stmts[0];
    const inline =
      first !== undefined &&
      !this.text.slice(colonEnd, first.start).includes('\n');
    return {
      body: stmts,
      inline,
      colonEnd,
      start: first?.start ?? colonEnd,
      end: stmts.at(-1)?.end ?? colonEnd,
    };
  }

  private statement(node: SyntaxNode): Stmt[] {
    const span = this.span(node);
    const kids = children(node);
    if (node.type.isError) {
      return span.end > span.start
        ? [{ type: 'Error', nodeName: node.name, ...span }]
        : [];
    }

    switch (node.name) {
      case 'ExpressionStatement': {
        const value = this.list(kids);
        return value ? [{ type: 'Expr', value, ...span }] : [];
      }

      case 'AssignStatement': {
        return [this.assign(kids, span)];
      }

      case 'UpdateStatement': {
        const op = kids.findIndex((k) => k.name === 'UpdateOp');
        const target = op < 0 ? undefined : this.list(kids.slice(0, op));
        const value = op < 0 ? undefined : this.list(kids.slice(op + 1));
        if (!target || !value) {
          return [{ type: 'Error', nodeName: node.name, ...span }];
        }

        return [
          {
            type: 'AugAssign',
            target,
            op: this.src(kids[op] as SyntaxNode),
            value,
            ...span,
          },
        ];
      }

      case 'IfStatement': {
        return [this.ifStatement(kids, span)];
      }

      case 'WhileStatement': {
        const bodies = kids.filter((k) => k.name === 'Body');
        const test = this.list(this.between(kids, 'while', 'Body'));
        const body = this.block(bodies[0], span.end);
        const orelse = bodies[1] ? this.block(bodies[1], span.end) : undefined;
        return [
          {
            type: 'While',
            test: test ?? this.opaque(node),
            body,
            orelse,
            start: span.start,
            end: (orelse ?? body).end,
          },
        ];
      }

      case 'ForStatement': {
        const bodies = kids.filter((k) => k.name === 'Body');
        const target = this.list(this.between(kids, 'for', 'in'));
        const iter = this.list(this.between(kids, 'in', 'Body'));
        const body = this.block(bodies[0], span.end);
        const orelse = bodies[1] ? this.block(bodies[1], span.end) : undefined;
        return [
          {
            type: 'For',
            target: target ?? this.opaque(node),
            iter: iter ?? this.opaque(node),
            body,
            orelse,
            isAsync: kids[0]?.name === 'async',
            start: span.start,
            end: (orelse ?? body).end,
          },
        ];
      }

      case 'WithStatement': {
        const bodyNode = kids.find((k) => k.name === 'Body');
        const items: Array<{ context: Expr; target?: Expr }> = [];
        for (const segment of this.split(this.between(kids, 'with', 'Body'))) {
          const as = segment.findIndex((k) => k.name === 'as');
          const context = this.list(as < 0 ? segment : segment.slice(0, as));
          const target = as < 0 ? undefined : this.list(segment.slice(as + 1));
          if (context) {
            items.push({ context, target });
          }
        }

        const body = this.block(bodyNode, span.end);
        return [
          {
            type: 'With',
            items,
            body,
            isAsync: kids[0]?.name === 'async',
            start: span.start,
            end: body.end,
          },
        ];
      }

      case 'TryStatement': {
        return [this.tryStatement(kids, span)];
      }

      case 'ReturnStatement': {
        return [{ type: 'Return', value: this.list(kids.slice(1)), ...span }];
      }

      case 'RaiseStatement': {
        const from = kids.findIndex((k) => k.name === 'from');
        return [
          {
            type: 'Raise',
            exception: this.list(kids.slice(1, from < 0 ? undefined : from)),
            cause: from < 0 ? undefined : this.list(kids.slice(from + 1)),
            ...span,
          },
        ];
      }

      case 'AssertStatement': {
        const [test, message] = this.split(kids.slice(1)).map((s) =>
          this.list(s)
        );
        return [
          {
            type: 'Assert',
            test: test ?? this.opaque(node),
            message,
            ...span,
          },
        ];
      }

      case 'DeleteStatement': {
        return [
          {
            type: 'Delete',
            targets: this.split(kids.slice(1))
              .map((s) => this.list(s))
              .filter((e) => e !== undefined),
            ...span,
          },
        ];
      }

      case 'YieldStatement': {
        const rest = kids.filter(
          (k) => k.name !== 'yield' && k.name !== 'from'
        );
        return [{ type: 'Yield', value: this.list(rest), ...span }];
      }

      case 'PassStatement': {
        return [{ type: 'Pass', ...span }];
      }

      case 'BreakStatement': {
        return [{ type: 'Break', ...span }];
      }

      case 'ContinueStatement': {
        return [{ type: 'Continue', ...span }];
      }

      case 'ImportStatement': {
        return [{ type: 'Import', ...span }];
      }

      case 'ScopeStatement': {
        return [{ type: 'Scope', ...span }];
      }

      case 'FunctionDefinition': {
        return [this.functionDef(node, [])];
      }

      case 'ClassDefinition': {
        return [this.classDef(node, [])];
      }

      case 'DecoratedStatement': {
        const decorators = kids
          .filter((k) => k.name === 'Decorator')
          .map((k) => this.span(k));
        const target = kids.find(
          (k) => k.name === 'FunctionDefinition' || k.name === 'ClassDefinition'
        );
        if (!target) {
          return [{ type: 'Error', nodeName: node.name, ...span }];
        }

        const def =
          target.name === 'FunctionDefinition'
            ? this.functionDef(target, decorators)
            : this.classDef(target, decorators);
        def.start = span.start;
        return [def];
      }

      case 'MatchStatement': {
        const matchBody = kids.find((k) => k.name === 'MatchBody');
        const subject = this.list(this.between(kids, 'match', 'MatchBody'));
        const cases = (matchBody ? children(matchBody) : [])
          .filter((k) => k.name === 'MatchClause')
          .map((clause) => {
            const parts = children(clause);
            const patternNodes = this.between(parts, 'case', 'Body');
            const first = patternNodes[0];
            const last = patternNodes.at(-1);
            const body = this.block(
              parts.find((k) => k.name === 'Body'),
              clause.to
            );
            return {
              pattern: {
                start: first?.from ?? clause.from,
                end: last ? this.trimmedEnd(last.from, last.to) : clause.from,
              },
              body,
              start: clause.from,
              end: body.end,
            };
          });
        return [
          {
            type: 'Match',
            subject: subject ?? this.opaque(node),
            cases,
            start: span.start,
            end: cases.at(-1)?.end ?? span.end,
          },
        ];
      }

      default: {
        // Groups like `a = 1; b = 2` contain statements themselves.
        const nested = kids.filter((k) =>
          /Statement$|Definition$/.test(k.name)
        );
        if (nested.length > 0) {
          return this.statements(nested);
        }

        if (/^[;:]?$/.test(this.src(span).trim())) {
          return [];
        }

        return [{ type: 'Error', nodeName: node.name, ...span }];
      }
    }
  }

  private assign(kids: SyntaxNode[], span: Span): Stmt {
    const segments: SyntaxNode[][] = [[]];
    for (const kid of kids) {
      if (kid.name === 'AssignOp') {
        segments.push([]);
      } else {
        segments.at(-1)?.push(kid);
      }
    }

    let annotation: Span | undefined;
    const first = segments[0] ?? [];
    const typeDef = first.findIndex((k) => k.name === 'TypeDef');
    if (typeDef >= 0) {
      annotation = this.typeSpan(first[typeDef] as SyntaxNode);
      first.splice(typeDef, 1);
    }

    const exprs = segments.map((s) => this.list(s));
    const value = segments.length > 1 ? exprs.at(-1) : undefined;
    const targets = (segments.length > 1 ? exprs.slice(0, -1) : exprs).filter(
      (e) => e !== undefined
    );
    return { type: 'Assign', targets, value, annotation, ...span };
  }

  private ifStatement(kids: SyntaxNode[], span: Span): IfStmt {
    const parts: Array<{
      keyword: SyntaxNode;
      test: Expr | undefined;
      body: Block;
    }> = [];
    let orelse: Block | undefined;
    for (let i = 0; i < kids.length; i++) {
      const kid = kids[i] as SyntaxNode;
      if (kid.name === 'if' || kid.name === 'elif') {
        const bodyIndex = kids.findIndex((k, j) => j > i && k.name === 'Body');
        if (bodyIndex < 0) {
          break;
        }

        parts.push({
          keyword: kid,
          test: this.list(kids.slice(i + 1, bodyIndex)),
          body: this.block(kids[bodyIndex], span.end),
        });
        i = bodyIndex;
      } else if (kid.name === 'else') {
        orelse = this.block(kids[i + 1], span.end);
        i++;
      }
    }

    const [head, ...elifs] = parts;
    const fallback: Expr = { type: 'Opaque', nodeName: 'If', ...span };
    const stmt: IfStmt = {
      type: 'If',
      test: head?.test ?? fallback,
      body: head?.body ?? this.block(undefined, span.end),
      elifs: elifs.map((e) => ({
        test: e.test ?? fallback,
        body: e.body,
        start: e.keyword.from,
        end: e.body.end,
      })),
      orelse,
      start: span.start,
      end: span.end,
    };
    stmt.end = (orelse ?? stmt.elifs.at(-1)?.body ?? stmt.body).end;
    return stmt;
  }

  private tryStatement(kids: SyntaxNode[], span: Span): Stmt {
    let body: Block | undefined;
    let orelse: Block | undefined;
    let finalbody: Block | undefined;
    const handlers: Handler[] = [];
    for (let i = 0; i < kids.length; i++) {
      const kid = kids[i] as SyntaxNode;
      const bodyIndex = kids.findIndex((k, j) => j > i && k.name === 'Body');
      if (bodyIndex < 0) {
        break;
      }

      const block = this.block(kids[bodyIndex], span.end);
      if (kid.name === 'try') {
        body = block;
      } else if (kid.name === 'except') {
        const header = kids
          .slice(i + 1, bodyIndex)
          .filter((k) => k.name !== '*');
        const as = header.findIndex((k) => k.name === 'as');
        const nameNode = as < 0 ? undefined : header[as + 1];
        handlers.push({
          exception: this.list(as < 0 ? header : header.slice(0, as)),
          name: nameNode ? this.src(nameNode) : undefined,
          body: block,
          start: kid.from,
          end: block.end,
        });
      } else if (kid.name === 'else') {
        orelse = block;
      } else if (kid.name === 'finally') {
        finalbody = block;
      }

      i = bodyIndex;
    }

    const tryBody = body ?? this.block(undefined, span.end);
    return {
      type: 'Try',
      body: tryBody,
      handlers,
      orelse,
      finalbody,
      start: span.start,
      end: (finalbody ?? orelse ?? handlers.at(-1)?.body ?? tryBody).end,
    };
  }

  private functionDef(node: SyntaxNode, decorators: Span[]): FunctionDef {
    const kids = children(node);
    const nameNode = kids.find((k) => k.name === 'VariableName');
    const paramList = kids.find((k) => k.name === 'ParamList');
    const returns = kids.find((k) => k.name === 'TypeDef');
    const body = this.block(
      kids.find((k) => k.name === 'Body'),
      node.to
    );
    return {
      type: 'FunctionDef',
      name: nameNode ? this.src(nameNode) : 'anonymous',
      params: paramList ? this.params(paramList) : [],
      returns: returns ? this.typeSpan(returns) : undefined,
      body,
      isAsync: kids[0]?.name === 'async',
      decorators,
      start: node.from,
      end: body.end,
    };
  }

  private classDef(node: SyntaxNode, decorators: Span[]): ClassDef {
    const kids = children(node);
    const nameNode = kids.find((k) => k.name === 'VariableName');
    const argList = kids.find((k) => k.name === 'ArgList');
    const body = this.block(
      kids.find((k) => k.name === 'Body'),
      node.to
    );
    return {
      type: 'ClassDef',
      name: nameNode ? this.src(nameNode) : 'AnonymousClass',
      bases: argList ? this.args(argList) : [],
      body,
      decorators,
      start: node.from,
      end: body.end,
    };
  }

  /** The type of a `TypeDef` (`: int` or `-> str`), without punctuation. */
  private typeSpan(typeDef: SyntaxNode): Span {
    const kids = children(typeDef).filter(
      (k) => k.name !== ':' && k.name !== '->'
    );
    const first = kids[0];
    const last = kids.at(-1);
    if (!first || !last) {
      return this.span(typeDef);
    }

    return { start: first.from, end: this.trimmedEnd(first.from, last.to) };
  }

  private params(list: SyntaxNode): Param[] {
    const params: Param[] = [];
    let star = '';
    let expectDefault = false;
    for (const kid of children(list)) {
      if (expectDefault && isExpression(kid)) {
        const last = params.at(-1);
        if (last) {
          last.defaultValue = this.expr(kid);
          last.end = kid.to;
        }

        expectDefault = false;
        continue;
      }

      switch (kid.name) {
        case '*':
        case '**': {
          star = kid.name;
          break;
        }

        case 'VariableName': {
          params.push({
            name: `${star}${this.src(kid)}`,
            start: kid.from,
            end: kid.to,
          });
          star = '';
          break;
        }

        case 'TypeDef': {
          const last = params.at(-1);
          if (last) {
            last.annotation = this.typeSpan(kid);
            last.end = kid.to;
          }

          break;
        }

        case 'AssignOp': {
          expectDefault = true;
          break;
        }

        default: {
          star = '';
        }
      }
    }

    return params;
  }

  private args(list: SyntaxNode): Arg[] {
    const kids = children(list).filter((k) => k.name !== '(' && k.name !== ')');
    if (kids.some((k) => k.name === 'for')) {
      // `f(x for x in xs)`: a single generator argument.
      const span = {
        start: kids[0]?.from ?? list.from,
        end: kids.at(-1)?.to ?? list.to,
      };
      return [
        {
          value: {
            type: 'Comprehension',
            kind: 'generator',
            sources: this.comprehensionSources(kids),
            ...span,
          },
          ...span,
        },
      ];
    }

    const args: Arg[] = [];
    for (const segment of this.split(kids)) {
      const first = segment[0];
      if (!first) {
        continue;
      }

      const end = segment.at(-1)?.to ?? first.to;
      if (first.name === '*' || first.name === '**') {
        const value = this.list(segment.slice(1));
        if (value) {
          args.push({ star: first.name, value, start: first.from, end });
        }
      } else if (
        segment[1]?.name === 'AssignOp' &&
        first.name === 'VariableName'
      ) {
        const value = this.list(segment.slice(2));
        if (value) {
          args.push({
            keyword: this.src(first),
            value,
            start: first.from,
            end,
          });
        }
      } else {
        const value = this.list(segment);
        if (value) {
          args.push({ value, start: first.from, end });
        }
      }
    }

    return args;
  }

  // ----------------------------------------------------------- expressions

  /** Nodes after the `from` keyword up to the first `to` node. */
  private between(kids: SyntaxNode[], from: string, to: string): SyntaxNode[] {
    const start = kids.findIndex((k) => k.name === from);
    const end = kids.findIndex((k, i) => i > start && k.name === to);
    return kids.slice(start + 1, end < 0 ? undefined : end);
  }

  /** Splits sibling nodes at top-level commas. */
  private split(kids: SyntaxNode[]): SyntaxNode[][] {
    const segments: SyntaxNode[][] = [[]];
    for (const kid of kids) {
      if (kid.name === ',') {
        segments.push([]);
      } else {
        segments.at(-1)?.push(kid);
      }
    }

    return segments.filter((s) => s.length > 0);
  }

  /** One expression from a segment (merging implicit string concatenation). */
  private segmentExpr(segment: SyntaxNode[]): Expr | undefined {
    const first = segment[0];
    if (!first) {
      return undefined;
    }

    if (first.name === '*' || first.name === '**') {
      const value = this.segmentExpr(segment.slice(1));
      return value
        ? {
            type: 'Starred',
            star: first.name,
            value,
            start: first.from,
            end: value.end,
          }
        : undefined;
    }

    const exprs = segment.filter((k) => isExpression(k));
    const strings = exprs.filter((k) => k.name === 'String');
    if (strings.length > 1 && strings.length === exprs.length) {
      return {
        type: 'Literal',
        kind: 'string',
        value: strings.map((s) => splitString(this.src(s)).value).join(''),
        start: strings[0]?.from ?? first.from,
        end: strings.at(-1)?.to ?? first.to,
      };
    }

    const node = exprs[0];
    return node ? this.expr(node) : undefined;
  }

  /** Comma separated expressions: one, or a tuple without parentheses. */
  private list(kids: SyntaxNode[]): Expr | undefined {
    const segments = this.split(kids);
    const trailingComma = kids.at(-1)?.name === ',';
    if (segments.length === 1 && !trailingComma) {
      return this.segmentExpr(segments[0] as SyntaxNode[]);
    }

    const items = segments
      .map((s) => this.segmentExpr(s))
      .filter((e) => e !== undefined);
    const first = kids[0];
    const last = kids.at(-1);
    if (!first || !last || items.length === 0) {
      return undefined;
    }

    return {
      type: 'Collection',
      kind: 'tuple',
      items,
      start: first.from,
      end: last.to,
    };
  }

  private opaque(node: SyntaxNode): Expr {
    return { type: 'Opaque', nodeName: node.name, ...this.span(node) };
  }

  private comprehensionSources(kids: SyntaxNode[]): Expr[] {
    const sources: Expr[] = [];
    for (const [i, kid] of kids.entries()) {
      const next = kids[i + 1];
      if (kid.name === 'in' && next && isExpression(next)) {
        sources.push(this.expr(next));
      }
    }

    return sources;
  }

  private expr(node: SyntaxNode): Expr {
    const span = this.span(node);
    const kids = children(node);
    const exprKids = kids.filter((k) => isExpression(k));

    switch (node.name) {
      case 'VariableName': {
        return { type: 'Name', name: this.src(span), ...span };
      }

      case 'Number': {
        const raw = this.src(span);
        const isFloat = !/^0[xXoObB]/.test(raw) && /[.eEjJ]/.test(raw);
        return {
          type: 'Literal',
          kind: isFloat ? 'float' : 'int',
          value: raw,
          ...span,
        };
      }

      case 'String': {
        const { prefix, value } = splitString(this.src(span));
        return {
          type: 'Literal',
          kind: /b/i.test(prefix) ? 'bytes' : 'string',
          value,
          ...span,
        };
      }

      case 'FormatString': {
        const replacements = kids.filter((k) => k.name === 'FormatReplacement');
        const parts: Expr[] = [];
        let format = '';
        let cursor = span.start;
        for (const [i, replacement] of replacements.entries()) {
          format += this.text.slice(cursor, replacement.from);
          format += `{${i}}`;
          cursor = replacement.to;
          const inner = children(replacement).find((k) => isExpression(k));
          parts.push(inner ? this.expr(inner) : this.opaque(replacement));
        }

        format += this.text.slice(cursor, span.end);
        return { type: 'FString', parts, format, ...span };
      }

      case 'ContinuedString': {
        // Implicit concatenation over several lines inside brackets.
        const parts = kids.filter((k) => k.name === 'String');
        if (parts.length !== kids.filter((k) => isExpression(k)).length) {
          return this.opaque(node);
        }

        return {
          type: 'Literal',
          kind: 'string',
          value: parts.map((p) => splitString(this.src(p)).value).join(''),
          ...span,
        };
      }

      case 'Boolean': {
        return {
          type: 'Literal',
          kind: 'bool',
          value: this.src(span),
          ...span,
        };
      }

      case 'None': {
        return { type: 'Literal', kind: 'none', value: 'None', ...span };
      }

      case 'BinaryExpression': {
        const left = exprKids[0];
        const right = exprKids.at(-1);
        if (!left || !right || left === right) {
          return this.opaque(node);
        }

        const op = this.text
          .slice(left.to, right.from)
          .replaceAll(/\s+/g, ' ')
          .trim();
        return {
          type: 'Binary',
          op,
          left: this.expr(left),
          right: this.expr(right),
          ...span,
        };
      }

      case 'UnaryExpression': {
        const argument = exprKids.at(-1);
        const op = kids[0];
        return argument && op && op !== argument
          ? {
              type: 'Unary',
              op: this.src(op).trim(),
              argument: this.expr(argument),
              ...span,
            }
          : this.opaque(node);
      }

      case 'ConditionalExpression': {
        const [consequent, test, alternate] = exprKids;
        return consequent && test && alternate
          ? {
              type: 'Conditional',
              consequent: this.expr(consequent),
              test: this.expr(test),
              alternate: this.expr(alternate),
              ...span,
            }
          : this.opaque(node);
      }

      case 'CallExpression': {
        const callee = exprKids[0];
        const argList = kids.find((k) => k.name === 'ArgList');
        return callee
          ? {
              type: 'Call',
              callee: this.expr(callee),
              args: argList ? this.args(argList) : [],
              ...span,
            }
          : this.opaque(node);
      }

      case 'MemberExpression': {
        const object = kids[0];
        if (!object) {
          return this.opaque(node);
        }

        const property = kids.find((k) => k.name === 'PropertyName');
        if (kids[1]?.name === '.' && property) {
          return {
            type: 'Attribute',
            object: this.expr(object),
            name: this.src(property),
            ...span,
          };
        }

        const inner = kids.slice(2, -1);
        const only = inner[0];
        const index: Expr =
          inner.length === 1 && only && isExpression(only)
            ? this.expr(only)
            : {
                type: 'Opaque',
                nodeName: 'Slice',
                start: only?.from ?? span.start,
                end: inner.at(-1)?.to ?? span.end,
              };
        return {
          type: 'Subscript',
          object: this.expr(object),
          index,
          ...span,
        };
      }

      case 'ParenthesizedExpression': {
        const value = this.list(kids.slice(1, -1));
        return value
          ? { type: 'Paren', expr: value, ...span }
          : this.opaque(node);
      }

      case 'TupleExpression':
      case 'ArrayExpression':
      case 'SetExpression': {
        const items = this.split(kids.slice(1, -1))
          .map((s) => this.segmentExpr(s))
          .filter((e) => e !== undefined);
        return {
          type: 'Collection',
          kind:
            node.name === 'TupleExpression'
              ? 'tuple'
              : node.name === 'ArrayExpression'
                ? 'list'
                : 'set',
          items,
          ...span,
        };
      }

      case 'DictionaryExpression': {
        const entries: Array<{ key?: Expr; value: Expr }> = [];
        for (const segment of this.split(kids.slice(1, -1))) {
          if (segment[0]?.name === '**') {
            const value = this.segmentExpr(segment.slice(1));
            if (value) {
              entries.push({ value });
            }

            continue;
          }

          const colon = segment.findIndex((k) => k.name === ':');
          const key = this.segmentExpr(segment.slice(0, colon));
          const value = this.segmentExpr(segment.slice(colon + 1));
          if (colon > 0 && value) {
            entries.push({ key, value });
          }
        }

        return { type: 'Dict', entries, ...span };
      }

      case 'ArrayComprehensionExpression':
      case 'SetComprehensionExpression':
      case 'DictionaryComprehensionExpression':
      case 'ComprehensionExpression': {
        return {
          type: 'Comprehension',
          kind: node.name.startsWith('Array')
            ? 'list'
            : node.name.startsWith('Set')
              ? 'set'
              : node.name.startsWith('Dictionary')
                ? 'dict'
                : 'generator',
          sources: this.comprehensionSources(kids),
          ...span,
        };
      }

      case 'LambdaExpression': {
        const paramList = kids.find((k) => k.name === 'ParamList');
        const body = exprKids.at(-1);
        return body
          ? {
              type: 'Lambda',
              params: paramList ? this.params(paramList) : [],
              body: this.expr(body),
              ...span,
            }
          : this.opaque(node);
      }

      case 'AwaitExpression': {
        const argument = exprKids.at(-1);
        return argument
          ? { type: 'Await', argument: this.expr(argument), ...span }
          : this.opaque(node);
      }

      default: {
        return this.opaque(node);
      }
    }
  }
}

export interface ConvertResult {
  body: Stmt[];
  diagnostics: PythonDiagnostic[];
  /** Ranges of all `#` comments. */
  comments: Array<{ start: number; end: number }>;
}

export function parsePython(text: string): ConvertResult {
  const converter = new Converter(text);
  const tree = parser.parse(maskForParser(text));
  const body = converter.script(tree);
  const comments: Array<{ start: number; end: number }> = [];
  tree.iterate({
    enter: (node) => {
      if (node.name === 'Comment') {
        comments.push({ start: node.from, end: node.to });
      }
    },
  });
  return { body, diagnostics: converter.diagnostics, comments };
}
