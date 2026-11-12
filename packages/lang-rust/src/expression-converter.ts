import type { SyntaxNode, Tree } from '@lezer/common';
import { parser } from '@lezer/rust';
import type { Expr, FieldInit, Span } from './ast';
import { child, children, isExpression } from './convert-utils';
import { StatementConverter } from './statement-converter';
import { splitString } from './string-literal';

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

/**
 * `a * b as f64` is `a * (b as f64)`: `as` binds tighter than every binary
 * operator, but `@lezer/rust` casts the whole binary expression. The cast
 * moves onto the rightmost operand (parenthesized operands stay `Paren`).
 */
function castRightmost(value: Expr, target: Span, end: number): Expr {
  if (value.type === 'Binary') {
    return { ...value, end, right: castRightmost(value.right, target, end) };
  }

  return { type: 'Cast', start: value.start, end, value, target };
}

/** Turns Lezer's Rust syntax tree into the AST: expressions on top. */
export class Converter extends StatementConverter {
  // ------------------------------------------------------------ expressions

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
          ? castRightmost(this.expr(value), this.span(target), span.end)
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
