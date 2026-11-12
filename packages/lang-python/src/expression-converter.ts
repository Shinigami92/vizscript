import type { SyntaxNode } from '@lezer/common';
import type { Arg, Expr, Param, Span } from './ast';
import { children, isExpression, splitString } from './convert-utils';

/** Converts expressions, argument and parameter lists. */
export abstract class ExpressionConverter {
  public constructor(protected readonly text: string) {}

  protected src(span: Span | SyntaxNode): string {
    return 'from' in span
      ? this.text.slice(span.from, span.to)
      : this.text.slice(span.start, span.end);
  }

  /** End of a range without trailing whitespace. */
  protected trimmedEnd(start: number, end: number): number {
    let e = end;
    while (e > start && /\s/.test(this.text[e - 1] ?? '')) {
      e--;
    }

    return e;
  }

  protected span(node: SyntaxNode): Span {
    return { start: node.from, end: this.trimmedEnd(node.from, node.to) };
  }

  /** The type of a `TypeDef` (`: int` or `-> str`), without punctuation. */
  protected typeSpan(typeDef: SyntaxNode): Span {
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

  protected params(list: SyntaxNode): Param[] {
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

  protected args(list: SyntaxNode): Arg[] {
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
  protected between(
    kids: SyntaxNode[],
    from: string,
    to: string
  ): SyntaxNode[] {
    const start = kids.findIndex((k) => k.name === from);
    const end = kids.findIndex((k, i) => i > start && k.name === to);
    return kids.slice(start + 1, end < 0 ? undefined : end);
  }

  /** Splits sibling nodes at top-level commas. */
  protected split(kids: SyntaxNode[]): SyntaxNode[][] {
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
  protected segmentExpr(segment: SyntaxNode[]): Expr | undefined {
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
  protected list(kids: SyntaxNode[]): Expr | undefined {
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

  protected opaque(node: SyntaxNode): Expr {
    return { type: 'Opaque', nodeName: node.name, ...this.span(node) };
  }

  protected comprehensionSources(kids: SyntaxNode[]): Expr[] {
    const sources: Expr[] = [];
    for (const [i, kid] of kids.entries()) {
      const next = kids[i + 1];
      if (kid.name === 'in' && next && isExpression(next)) {
        sources.push(this.expr(next));
      }
    }

    return sources;
  }

  protected expr(node: SyntaxNode): Expr {
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
