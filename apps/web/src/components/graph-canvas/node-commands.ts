import type { CommentTarget } from '@vizscript/canvas';
import type { Pin, PinRef, Point } from '@vizscript/core';
import { qualifiedName, referenceName, uniqueName } from '@vizscript/core';
import { usesSnakeCase } from '../../graph/languages';
import { symbolNodes } from '../../graph/symbols';
import type { MenuEntry } from '../ContextMenu.vue';
import { suggestName } from './graph-helpers';
import type { CanvasContext, MenuState } from './types';

export interface NodeCommandDeps {
  openMenu: (state: MenuState) => void;
  closeMenu: () => void;
  selectNodes: (ids: string[], focus?: boolean) => void;
  /** Last pointer position in client coordinates. */
  pointer: Readonly<Point>;
}

export interface NodeCommands {
  editComment: (target: CommentTarget) => void;
  createCommentBox: (ids: ReadonlyArray<string>, client: Point) => void;
  promoteTo: (source: PinRef, pin: Pin, world: Point, value?: string) => void;
  extractEntry: (source: PinRef, pin: Pin, world: Point) => MenuEntry;
  findReferences: (nodeId: string) => void;
  collapseToFunction: (ids: ReadonlyArray<string>) => void;
}

/** Node commands that ask for a name or select nodes (menus, keys). */
export function createNodeCommands(
  ctx: CanvasContext & NodeCommandDeps
): NodeCommands {
  const { props, ask, emitOp } = ctx;

  function editComment(target: CommentTarget): void {
    ctx.closeMenu();
    ctx.view.value?.editComment(target);
  }

  /** Asks for a title and wraps the nodes' code in a region. */
  function createCommentBox(ids: ReadonlyArray<string>, client: Point): void {
    if (!props.editable || ids.length === 0) {
      return;
    }

    ctx.openMenu({
      world: { x: 0, y: 0 },
      client,
      target: { kind: 'node', nodeId: ids[0] ?? '' },
    });
    void ask({
      label: 'Comment box title',
      placeholder: 'Comment',
      allowEmpty: true,
      submit: (title) =>
        emitOp({ type: 'addCommentBox', nodes: [...ids], title }),
    });
  }

  /** UE's "Promote to variable": store an output's value in a new variable. */
  function promoteTo(
    source: PinRef,
    pin: Pin,
    world: Point,
    value = /^[A-Za-z_$][\w$]*$/.test(pin.name) ? pin.name : ''
  ): void {
    void ask({
      label: 'Variable name',
      placeholder: 'value',
      value,
      submit: (name) =>
        emitOp({ type: 'promote', pin: source, name, position: { ...world } }),
    });
  }

  /**
   * UE's "Promote to Variable" for an input: a variable declared before the
   * statement takes the input's value (or the type's start value when the
   * input is empty) and the input reads it.
   */
  function extractEntry(source: PinRef, pin: Pin, world: Point): MenuEntry {
    const empty = !pin.range || pin.range.end <= pin.range.start;
    const value = empty
      ? (props.types?.primitives.find((t) => t.dataType === pin.type)
          ?.defaultValue ??
        props.types?.placeholder ??
        'undefined')
      : undefined;
    return {
      label: 'Promote to Variable…',
      icon: 'i-mdi-variable text-sky-400',
      action: () =>
        void ask({
          label: 'Variable name',
          placeholder: 'value',
          value: suggestName(pin),
          submit: (name) =>
            emitOp({
              type: 'extract',
              pin: source,
              name,
              ...(value === undefined ? {} : { value }),
              position: { ...world },
            }),
        }),
    };
  }

  /**
   * UE's "Find References": selects every Get / Set of the node's variable
   * or every call of its function (the Details panel lists them).
   */
  function findReferences(nodeId: string): void {
    const doc = props.doc;
    const entry = ctx.index.value.nodes.get(nodeId);
    const name = entry ? referenceName(entry.node) : undefined;
    if (!doc || !entry || !name) {
      return;
    }

    const bare = name.replace(/^(?:this|self)\./, '');
    const isCall = entry.node.kind === 'call';
    const kinds = isCall
      ? ['function', 'method', 'import']
      : ['variable', 'constant', 'local', 'import'];
    const candidates = (doc.symbols ?? []).filter(
      (s) => s.name === bare && kinds.includes(s.kind)
    );
    const owner = doc.symbols?.find(
      (s) => s.fnId === entry.fn.id && s.kind !== 'class'
    );
    const symbol =
      candidates.find(
        (s) => s.kind === 'local' && owner && s.scope === qualifiedName(owner)
      ) ?? candidates.find((s) => s.kind !== 'local');
    const found = symbol
      ? symbolNodes(doc, symbol)
      : doc.functions
          .flatMap((f) => f.nodes)
          .filter((n) => referenceName(n) === name)
          .map((n) => n.id);
    const ids = found.includes(nodeId) ? found : [nodeId, ...found];
    ctx.selectNodes(ids);
    ctx.show(
      `${ids.length} ${ids.length === 1 ? 'reference' : 'references'} of ${name}`
    );
  }

  /** Asks for a name and collapses the nodes into a new function. */
  function collapseToFunction(ids: ReadonlyArray<string>): void {
    const doc = props.doc;
    if (!doc) {
      return;
    }

    const snake = usesSnakeCase(doc.language);
    const positions = ctx.view.value?.getPositions() ?? {};
    const first = ids
      .map((id) => positions[id])
      .filter((p): p is Point => p !== undefined)
      .reduce<Point | undefined>(
        (a, b) => (!a || b.x < a.x ? b : a),
        undefined
      );
    ctx.openMenu({
      world: { x: 0, y: 0 },
      client: { x: ctx.pointer.x, y: ctx.pointer.y },
      target: { kind: 'node', nodeId: ids[0] ?? '' },
    });
    void ask({
      label: 'Name of the new function',
      placeholder: snake ? 'new_function' : 'newFunction',
      value: uniqueName(doc, '', snake ? 'new_function' : 'newFunction'),
      submit: (name) =>
        emitOp({
          type: 'collapseToFunction',
          nodes: [...ids],
          name,
          ...(first ? { position: { ...first } } : {}),
        }),
    });
  }

  return {
    editComment,
    createCommentBox,
    promoteTo,
    extractEntry,
    findReferences,
    collapseToFunction,
  };
}
