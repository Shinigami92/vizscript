import type { SyntaxNode, Tree } from '@lezer/common';
import { parser } from '@lezer/python';
import type {
  Block,
  ClassDef,
  Expr,
  FunctionDef,
  Handler,
  IfStmt,
  Span,
  Stmt,
} from './ast';
import type { PythonDiagnostic } from './convert-utils';
import { children, isKnownGap, maskForParser } from './convert-utils';
import { ExpressionConverter } from './expression-converter';

/**
 * Converts Lezer's concrete Python syntax tree into the small typed AST the
 * lowering works with. Lezer is error tolerant, so this never throws: parts
 * it cannot make sense of become `Opaque` expressions or `Error` statements.
 */
class Converter extends ExpressionConverter {
  public readonly diagnostics: PythonDiagnostic[] = [];

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
