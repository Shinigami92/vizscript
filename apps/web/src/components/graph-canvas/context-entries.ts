import type { ContextTarget, GraphView } from '@vizscript/canvas';
import type { InputPinMeta, Point } from '@vizscript/core';
import { ARG_PIN, getMeta, referenceName } from '@vizscript/core';
import type { Ref } from 'vue';
import { toRaw } from 'vue';
import { pinEdges } from '../../graph/doc-index';
import { isMac, shortcut } from '../../graph/source';
import type { MenuEntry } from '../ContextMenu.vue';
import { ALIGN_ENTRIES } from './menu-data';
import type { NodeCommands } from './node-commands';
import type { CanvasContext, CanvasEvents, MenuState } from './types';

export interface ContextEntryDeps {
  events: CanvasEvents;
  commands: NodeCommands;
  /** The node whose variable or function "Replace with…" picks. */
  replacing: Ref<string | null>;
  selectNodes: (ids: string[], focus?: boolean) => void;
  copyCode: (ids: ReadonlyArray<string>) => Promise<boolean>;
  cutNodes: (ids: ReadonlyArray<string>) => Promise<void>;
  pasteFromClipboard: (world: Point, nodeId?: string) => Promise<void>;
  duplicateSelection: () => void;
}

type Target<K extends ContextTarget['kind']> = Extract<
  ContextTarget,
  { kind: K }
>;

function knotEntries(v: GraphView, target: Target<'knot'>): MenuEntry[] {
  return [
    { type: 'header', label: 'Reroute node' },
    {
      label: 'Remove reroute node',
      icon: 'i-mdi-close-circle-outline',
      shortcut: 'Alt+Click',
      action: () => v.removeReroute(target.edgeId, target.index),
    },
    {
      label: 'Remove all on this wire',
      icon: 'i-mdi-vector-polyline-remove',
      action: () => v.clearReroutes(target.edgeId),
    },
  ];
}

/** The context menu of a node, pin, wire, knot, comment box or function. */
export function createContextEntries(
  ctx: CanvasContext & ContextEntryDeps
): (target: ContextTarget, state: MenuState) => MenuEntry[] {
  const { props, emitOp, events, commands } = ctx;

  function nodeEntries(
    v: GraphView,
    target: Target<'node'>,
    state: MenuState
  ): MenuEntry[] {
    const index = ctx.index.value;
    const selection = ctx.selection.value;
    const ids = selection.includes(target.nodeId) ? selection : [target.nodeId];
    const first = index.nodes.get(target.nodeId);
    const definition =
      ids.length === 1 ? props.definitionOf?.(target.nodeId) : undefined;
    const deletable = ids.some(
      (id) => index.nodes.get(id)?.node.kind !== 'entry'
    );
    const reference =
      ids.length === 1 && first ? referenceName(first.node) : undefined;
    return [
      {
        type: 'header',
        label:
          ids.length > 1 ? `${ids.length} nodes` : (first?.node.title ?? ''),
      },
      {
        label: 'Jump to code',
        icon: 'i-mdi-code-tags',
        shortcut: 'Double-click',
        action: () => events.activate(target.nodeId),
      },
      ...(definition
        ? [
            {
              label: `Go to definition (${definition})`,
              icon: 'i-mdi-arrow-top-right',
              shortcut: 'F12',
              action: () => events.goToDefinition(target.nodeId),
            },
          ]
        : []),
      // The node's own actions first, then the generic editing ones.
      ...(props.editable && ids.length === 1 && first?.node.kind === 'call'
        ? [
            {
              // UE's "Add pin": one more argument to wire or fill in.
              label: 'Add argument pin',
              icon: 'i-mdi-plus-circle-outline',
              action: () =>
                emitOp({ type: 'addArgument', node: target.nodeId }),
            },
          ]
        : []),
      ...(reference
        ? [
            {
              // UE's "Find References".
              label: `Find references of ${reference}`,
              icon: 'i-mdi-magnify-scan',
              action: () => commands.findReferences(target.nodeId),
            },
          ]
        : []),
      ...(reference && props.editable
        ? [
            {
              // UE's "Replace References" / "Replace with".
              label:
                first?.node.kind === 'call'
                  ? 'Replace function…'
                  : 'Replace variable…',
              icon: 'i-mdi-swap-horizontal',
              action: () => {
                ctx.replacing.value = target.nodeId;
              },
            },
          ]
        : []),
      ...(props.editable && ids.length === 1
        ? [
            {
              // UE's "Break Node Link(s)".
              label: 'Break node links',
              icon: 'i-mdi-link-variant-off',
              disabled: !first?.fn.edges.some(
                (e) =>
                  e.kind === 'data' &&
                  (e.from.node === target.nodeId || e.to.node === target.nodeId)
              ),
              reason: 'It has no data wires.',
              action: () =>
                emitOp({ type: 'disconnectNode', node: target.nodeId }),
            },
          ]
        : []),
      { type: 'separator' },
      ...(props.editable
        ? [
            {
              label: 'Cut',
              icon: 'i-mdi-content-cut',
              shortcut: shortcut('X'),
              disabled: !deletable,
              reason: "A function's entry can't be cut.",
              action: () => void ctx.cutNodes(ids),
            },
          ]
        : []),
      {
        label: 'Copy',
        icon: 'i-mdi-content-copy',
        shortcut: shortcut('C'),
        action: () =>
          void ctx
            .copyCode(ids)
            .then(
              (copied) => copied && ctx.show('Code copied to the clipboard.')
            ),
      },
      ...(props.editable
        ? [
            {
              label: 'Paste',
              icon: 'i-mdi-content-paste',
              shortcut: shortcut('V'),
              action: () =>
                void ctx.pasteFromClipboard(
                  state.world,
                  ids.length === 1 ? target.nodeId : undefined
                ),
            },
            {
              label: 'Duplicate',
              icon: 'i-mdi-content-duplicate',
              shortcut: shortcut('D'),
              action: () => ctx.duplicateSelection(),
            },
          ]
        : []),
      ...(props.editable
        ? [
            {
              // UE's "Collapse to Function".
              label: 'Collapse to function…',
              icon: 'i-mdi-function-variant',
              // Only inside named functions and methods for now.
              disabled: !props.doc?.symbols?.some(
                (sym) =>
                  sym.fnId === first?.fn.id &&
                  (sym.kind === 'function' || sym.kind === 'method') &&
                  !sym.modifiers.includes('callback')
              ),
              reason: 'Only code inside a named function can be collapsed.',
              action: () => commands.collapseToFunction(ids),
            },
          ]
        : []),
      { type: 'separator' },
      {
        label: 'Zoom to selection',
        icon: 'i-mdi-image-filter-center-focus',
        shortcut: 'F',
        action: () => v.frameSelection(),
      },
      {
        label: `Select all of ${first?.fn.name ?? 'function'}`,
        icon: 'i-mdi-selection-multiple',
        disabled: !first,
        action: () => first && v.selectFunction(first.fn.id),
      },
      {
        label: 'Reset position',
        icon: 'i-mdi-auto-fix',
        action: () => events.resetLayout(ids),
      },
      // UE's alignment section (positions only, the code stays).
      { type: 'header', label: 'Alignment' },
      {
        label: 'Straighten connections',
        icon: 'i-mdi-ray-start-end',
        shortcut: 'Q',
        action: () => v.alignSelection('straighten'),
      },
      ...(ids.length > 1
        ? ALIGN_ENTRIES.map((entry) => ({
            label: entry.label,
            icon: entry.icon,
            shortcut: entry.keys
              ? isMac
                ? entry.keys.replace('Alt+', '⌥').replace('Shift+', '⇧')
                : entry.keys
              : undefined,
            action: () => v.alignSelection(entry.mode),
          }))
        : []),
      ...(props.editable
        ? [
            { type: 'separator' as const },
            {
              label: first?.node.comment ? 'Edit comment…' : 'Add comment…',
              icon: 'i-mdi-comment-text-outline',
              shortcut: first?.node.comment ? 'Double-click' : undefined,
              action: () =>
                commands.editComment({ kind: 'node', nodeId: target.nodeId }),
            },
            ...(first?.node.comment
              ? [
                  {
                    label: 'Remove comment',
                    icon: 'i-mdi-comment-remove-outline',
                    action: () =>
                      emitOp({
                        type: 'setComment',
                        node: target.nodeId,
                        text: '',
                      }),
                  },
                ]
              : []),
            {
              label: 'Create comment box…',
              icon: 'i-mdi-comment-multiple-outline',
              shortcut: 'C',
              action: () => commands.createCommentBox(ids, state.client),
            },
            { type: 'separator' as const },
            {
              label: ids.length > 1 ? 'Delete nodes' : 'Delete',
              icon: 'i-mdi-delete-outline',
              shortcut: 'Del',
              danger: true,
              disabled: !deletable,
              reason:
                "A function's entry can't be deleted; delete the function in My Script.",
              action: () =>
                events.op({ type: 'deleteNodes', nodeIds: [...ids] }),
            },
          ]
        : []),
    ];
  }

  function pinEntries(
    v: GraphView,
    target: Target<'pin'>,
    state: MenuState
  ): MenuEntry[] {
    const index = ctx.index.value;
    const entry = index.nodes.get(target.pin.node);
    const pin = entry?.node.pins.find((p) => p.id === target.pin.pin);
    if (!entry || !pin) {
      return [];
    }

    const edges = pinEdges(index, entry.node.id, pin);
    const peers = edges.map((e) =>
      pin.direction === 'in' ? e.from.node : e.to.node
    );
    /** The other end of each wire, named like UE's "Break link to …". */
    const links = edges.map((edge) => {
      const peer = pin.direction === 'in' ? edge.from : edge.to;
      const node = index.nodes.get(peer.node)?.node;
      const title = node?.title ?? 'node';
      const name = node?.pins.find((p) => p.id === peer.pin)?.name;
      return {
        edge,
        node: peer.node,
        title,
        label: name ? `${title} · ${name}` : title,
      };
    });
    const source = { ...toRaw(target.pin) };
    const argument =
      entry.node.kind === 'call' && pin.range && ARG_PIN.test(pin.id)
        ? pin.range
        : undefined;
    const fallback = getMeta<InputPinMeta>(pin).defaultValue;
    const current = pin.range
      ? props.text.slice(pin.range.start, pin.range.end)
      : undefined;
    return [
      {
        type: 'header',
        label: `${pin.name || (pin.kind === 'exec' ? 'Exec' : 'Value')} · ${
          pin.kind === 'exec' ? 'exec' : String(pin.type)
        }`,
      },
      ...(pin.literal && edges.length === 0 && props.editable
        ? [
            {
              label: 'Edit value',
              icon: 'i-mdi-pencil-outline',
              shortcut: 'Double-click',
              action: () => v.editLiteral(entry.node.id, pin.id),
            },
          ]
        : []),
      ...(argument &&
      fallback !== undefined &&
      edges.length === 0 &&
      current !== fallback &&
      props.editable
        ? [
            {
              // UE's "Reset to default value": the last argument (or a
              // keyword one) is left out, others get the default written.
              label: `Reset to default (${fallback})`,
              icon: 'i-mdi-restore',
              action: () =>
                emitOp(
                  pin.name.endsWith('=') ||
                    !entry.node.pins.some(
                      (p) =>
                        ARG_PIN.test(p.id) &&
                        p.range !== undefined &&
                        p.range.start > argument.start
                    )
                    ? { type: 'removeArgument', pin: source }
                    : { type: 'setInput', pin: source, expression: fallback }
                ),
            },
          ]
        : []),
      ...(pin.kind === 'data' && pin.direction === 'in' && props.editable
        ? [commands.extractEntry(source, pin, state.world)]
        : []),
      ...(pin.kind === 'data' &&
      pin.direction === 'out' &&
      entry.node.kind !== 'setVar' &&
      entry.node.kind !== 'entry' &&
      props.editable
        ? [
            {
              label: 'Promote to Variable…',
              icon: 'i-mdi-variable text-sky-400',
              action: () => commands.promoteTo(source, pin, state.world),
            },
          ]
        : []),
      // UE's "Jump to …": frame the node at the other end.
      ...links
        .filter((link, i) => links.findIndex((l) => l.node === link.node) === i)
        .map((link) => ({
          label: `Jump to ${link.title}`,
          icon: 'i-mdi-arrow-right-circle-outline',
          action: () => ctx.selectNodes([link.node]),
        })),
      ...(new Set(peers).size > 1
        ? [
            {
              label: 'Select all connected nodes',
              icon: 'i-mdi-ray-start-arrow',
              action: () => ctx.selectNodes([...new Set(peers)]),
            },
          ]
        : []),
      ...(props.editable
        ? [
            {
              // UE's "Break link to …", or "Break all links" for several.
              label:
                links.length > 1
                  ? 'Break all links'
                  : links.length === 1
                    ? `Break link to ${links[0]?.label ?? 'node'}`
                    : 'Break link',
              icon: 'i-mdi-link-variant-off',
              shortcut: 'Alt+Click',
              // Exec wires the code can't drop stay broken in the graph.
              disabled:
                edges.length === 0 &&
                (pin.kind === 'exec' || pin.direction === 'out' || !pin.range),
              reason: 'Nothing is wired to this pin.',
              action: () => events.op({ type: 'disconnect', pin: source }),
            },
            // One wire of several.
            ...(links.length > 1
              ? links.map((link) => ({
                  label: `Break link to ${link.label}`,
                  icon: 'i-mdi-link-variant-minus',
                  action: () =>
                    events.op({
                      type: 'disconnect',
                      pin: { ...toRaw(link.edge.to) },
                    }),
                }))
              : []),
            ...(argument
              ? [
                  {
                    // UE's "Remove pin" (for added pins).
                    label: 'Remove argument pin',
                    icon: 'i-mdi-minus-circle-outline',
                    danger: true,
                    action: () =>
                      emitOp({ type: 'removeArgument', pin: source }),
                  },
                ]
              : []),
          ]
        : []),
    ];
  }

  function wireEntries(
    v: GraphView,
    target: Target<'wire'>,
    state: MenuState
  ): MenuEntry[] {
    const edge = target.edge;
    const knots = v.getReroutes(edge.id).length;
    return [
      {
        type: 'header',
        label: edge.kind === 'exec' ? 'Execution wire' : 'Data wire',
      },
      {
        label: 'Add reroute node',
        icon: 'i-mdi-circle-medium',
        shortcut: 'Double-click',
        action: () => v.addReroute(edge.id, state.world),
      },
      {
        label: 'Remove reroute nodes',
        icon: 'i-mdi-vector-polyline-remove',
        disabled: knots === 0,
        reason: 'This wire has no reroute nodes.',
        action: () => v.clearReroutes(edge.id),
      },
      { type: 'separator' },
      {
        label: 'Select source node',
        icon: 'i-mdi-ray-start',
        action: () => ctx.selectNodes([edge.from.node]),
      },
      {
        label: 'Select target node',
        icon: 'i-mdi-ray-end',
        action: () => ctx.selectNodes([edge.to.node]),
      },
      ...(props.editable
        ? [
            { type: 'separator' as const },
            {
              label: 'Break link',
              icon: 'i-mdi-link-variant-off',
              action: () =>
                events.op({
                  type: 'disconnect',
                  pin: { ...toRaw(edge.to) },
                }),
            },
          ]
        : []),
    ];
  }

  function commentEntries(
    v: GraphView,
    target: Target<'comment'>
  ): MenuEntry[] {
    const fn = props.doc?.functions.find((f) => f.id === target.fnId);
    const box = fn?.comments?.find((b) => b.id === target.boxId);
    if (!box) {
      return [];
    }

    return [
      { type: 'header', label: box.title || 'Comment box' },
      {
        label: 'Select nodes',
        icon: 'i-mdi-selection-multiple',
        action: () => v.setSelection(box.nodes),
      },
      {
        label: 'Frame comment box',
        icon: 'i-mdi-image-filter-center-focus',
        action: () => {
          v.setSelection(box.nodes);
          v.frameSelection();
        },
      },
      {
        label: 'Jump to code',
        icon: 'i-mdi-code-tags',
        action: () => box.nodes[0] && events.activate(box.nodes[0]),
      },
      ...(props.editable
        ? [
            { type: 'separator' as const },
            {
              label: 'Rename…',
              icon: 'i-mdi-rename-outline',
              shortcut: 'Double-click',
              action: () =>
                commands.editComment({ kind: 'box', boxId: box.id }),
            },
            {
              label: 'Remove comment box',
              icon: 'i-mdi-comment-remove-outline',
              danger: true,
              action: () => emitOp({ type: 'deleteCommentBox', box: box.id }),
            },
          ]
        : []),
    ];
  }

  function functionEntries(
    v: GraphView,
    target: Target<'function'>
  ): MenuEntry[] {
    const fn = props.doc?.functions.find((f) => f.id === target.fnId);
    const entryNode = fn?.nodes.find((n) => n.kind === 'entry');
    return [
      { type: 'header', label: fn?.name ?? 'Function' },
      {
        label: 'Open on its own',
        icon: 'i-mdi-arrow-expand',
        shortcut: 'Double-click',
        action: () => events.openFunction(target.fnId),
      },
      {
        label: 'Select all nodes',
        icon: 'i-mdi-selection-multiple',
        action: () => v.selectFunction(target.fnId),
      },
      {
        label: 'Frame function',
        icon: 'i-mdi-image-filter-center-focus',
        action: () => {
          v.selectFunction(target.fnId);
          v.frameSelection();
        },
      },
      {
        label: 'Jump to code',
        icon: 'i-mdi-code-tags',
        disabled: !entryNode,
        action: () => entryNode && events.activate(entryNode.id),
      },
      {
        label: 'Reset layout of function',
        icon: 'i-mdi-auto-fix',
        action: () => events.resetLayout(fn?.nodes.map((n) => n.id) ?? []),
      },
    ];
  }

  return (target, state) => {
    const v = ctx.view.value;
    if (!v) {
      return [];
    }

    switch (target.kind) {
      case 'background': {
        // Shown by the searchable action menu.
        return [];
      }

      case 'node': {
        return nodeEntries(v, target, state);
      }

      case 'pin': {
        return pinEntries(v, target, state);
      }

      case 'wire': {
        return wireEntries(v, target, state);
      }

      case 'knot': {
        return knotEntries(v, target);
      }

      case 'comment': {
        return commentEntries(v, target);
      }

      case 'function': {
        return functionEntries(v, target);
      }
    }
  };
}
