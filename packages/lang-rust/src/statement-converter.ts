import type { SyntaxNode } from '@lezer/common';
import type {
  Block,
  Expr,
  IfStmt,
  MatchArm,
  MatchStmt,
  Pattern,
  Stmt,
} from './ast';
import { child, children } from './convert-utils';
import { ItemConverter } from './item-converter';

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

/** Statements, patterns and conditions (`if let`, let chains). */
export abstract class StatementConverter extends ItemConverter {
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

  protected statement(node: SyntaxNode): Stmt | undefined {
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

  protected letStatement(node: SyntaxNode): Stmt {
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

  protected label(node: SyntaxNode): string | undefined {
    const label = child(node, 'LoopLabel');
    return label ? this.slice(label) : undefined;
  }

  protected expressionStatement(
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

  protected blockLabel(node: SyntaxNode): string {
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

  protected emptyBlock(node: SyntaxNode): Block {
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

  protected bindings(node: SyntaxNode): Pattern['bindings'] {
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

  protected patternSpan(first: SyntaxNode, last: SyntaxNode): Pattern {
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

  protected pattern(node: SyntaxNode, mutable: boolean): Pattern {
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

  // ------------------------------------------------------------ conditions

  protected opaque(node: SyntaxNode): Expr {
    return { type: 'Opaque', nodeName: node.name, ...this.span(node) };
  }

  /** A condition: an expression, a `let` or a let chain. */
  protected condition(node: SyntaxNode): Expr {
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
}
