import type { SyntaxNode, Tree } from '@lezer/common';
import type {
  Block,
  EnumItem,
  Expr,
  FunctionItem,
  ImplItem,
  Item,
  Param,
  SelfParam,
  Span,
  StructItem,
  TraitItem,
  ValueItem,
} from './ast';
import { children, TYPE_NODES } from './convert-utils';

export interface RustDiagnostic {
  message: string;
  start: number;
  end: number;
}

/**
 * The base of `Converter`: items (functions, types, impls, modules) and
 * the shared helpers. Statements and expressions build on it.
 */
export abstract class ItemConverter {
  public readonly diagnostics: RustDiagnostic[] = [];

  /**
   * `text` is what the nodes point into; `shift` turns their offsets into
   * offsets of the file (macro arguments are parsed on their own).
   */
  public constructor(
    protected readonly text: string,
    protected readonly shift = 0
  ) {}

  protected span(node: { from: number; to: number }): Span {
    return { start: node.from + this.shift, end: node.to + this.shift };
  }

  protected slice(node: { from: number; to: number }): string {
    return this.text.slice(node.from, node.to);
  }

  protected error(node: SyntaxNode, message = 'Syntax error'): void {
    const start = node.from + this.shift;
    if (!this.diagnostics.some((d) => d.start === start)) {
      this.diagnostics.push({
        message,
        start,
        end: Math.max(node.to, node.from + 1) + this.shift,
      });
    }
  }

  public abstract block(node: SyntaxNode): Block;

  public abstract expr(node: SyntaxNode): Expr;

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
  protected modifiers(
    nodes: ReadonlyArray<SyntaxNode>,
    until: string
  ): string[] {
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

  protected item(node: SyntaxNode, attributes: Span[] = []): Item | undefined {
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

  protected declarations(list: SyntaxNode): Item[] {
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

  protected fn(node: SyntaxNode, attributes: Span[]): FunctionItem {
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

  protected params(list: SyntaxNode): { self?: SelfParam; params: Param[] } {
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

  protected param(node: SyntaxNode): Param {
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

  protected struct(node: SyntaxNode, attributes: Span[]): StructItem {
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

  protected enumItem(node: SyntaxNode, attributes: Span[]): EnumItem {
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
  protected typeName(node: SyntaxNode | undefined): string {
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

  protected impl(node: SyntaxNode): ImplItem {
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

  protected trait(node: SyntaxNode, attributes: Span[]): TraitItem {
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

  protected valueItem(node: SyntaxNode, attributes: Span[]): ValueItem {
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
}
