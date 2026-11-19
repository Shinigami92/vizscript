import type { DataType, ExpressionTemplate, Point } from '@vizscript/core';
import { isTypeCompatible } from '@vizscript/core';
import { shortcut } from '../../graph/source';
import type { ActionEntry } from '../ActionMenu.vue';
import { addNodeEntries } from './add-node-entries';
import { containerEntries, methodCallExpression } from './container-entries';
import {
  callSignature,
  codeOffset,
  emptyInput,
  fillTemplate,
  fitsType,
  ownMethodName,
  scopeVariables,
  valueName,
  variablesNear,
  withImport,
} from './graph-helpers';
import { elementEntries, makeEntries, throwEntries } from './make-entries';
import { memberEntries } from './member-entries';
import {
  EXPRESSION_ICONS,
  ICON_CALL,
  ICON_IMPORT,
  ICON_SET,
} from './menu-data';
import type { NodeCommands } from './node-commands';
import { suggestEntries } from './suggest-entries';
import type { CanvasContext, MenuState } from './types';
import { variableReadEntries } from './variable-entries';

export interface ActionEntryDeps {
  commands: NodeCommands;
  pasteFromClipboard: (world: Point, nodeId?: string) => Promise<void>;
  openSearch: () => Promise<void>;
}

export interface ActionEntries {
  /** The searchable actions for a dropped wire or the empty graph. */
  actionEntries: (state: MenuState) => ActionEntry[];
  /** Actions made from the search text: call or use exactly what was typed. */
  suggestActions: (state: MenuState, query: string) => ActionEntry[];
  /** Title of the action menu, like "Actions taking a string". */
  actionTitle: (state: MenuState) => string;
}

/** The searchable action menu (UE's palette) of a wire or the background. */
export function createActionEntries(
  ctx: CanvasContext & ActionEntryDeps
): ActionEntries {
  const { props, emitOp, ask, pinOf, commands } = ctx;
  const index = ctx.index;
  const callables = ctx.callables;
  const externalNames = ctx.externalNames;
  const signatureOf = (callee: string): ReturnType<typeof callSignature> =>
    callSignature(props.doc, props.text, callee);
  const fill = (
    expression: ExpressionTemplate,
    first?: string,
    wireType?: DataType
  ): string =>
    fillTemplate(
      expression.template,
      (slot) => emptyInput(expression, slot, props.types, wireType),
      first
    );

  /**
   * Operator and value actions (UE: `+`, Make Literal String …) for a wire
   * dropped from a data pin, or for empty space (`from` undefined).
   */
  function expressionActions(state: MenuState): ActionEntry[] {
    const expressions = props.types?.expressions ?? [];
    const source = state.from;
    const found = source ? pinOf(source) : undefined;
    return expressions.flatMap((expression): ActionEntry[] => {
      const base = {
        label: expression.label,
        category: expression.category,
        icon: EXPRESSION_ICONS[expression.category],
        keywords: `${expression.keywords ?? ''} ${expression.template}`,
        hint: fillTemplate(expression.template, '·'),
      };

      if (source && found?.pin.direction === 'out') {
        // The dragged value goes into the first input.
        if (!expression.template.includes('$1')) {
          return [];
        }

        return [
          {
            ...base,
            action: () =>
              emitOp({
                type: 'useValue',
                pin: source,
                expression: fill(expression, '$value', found.pin.type),
                position: { ...state.world },
                ...(expression.awaits ? { awaits: true } : {}),
              }),
          },
        ];
      }

      if (source && found) {
        // Into an input: replaces its value.
        return [
          {
            ...base,
            fits: isTypeCompatible(expression.result ?? 'any', found.pin.type),
            action: () =>
              emitOp({
                type: 'setInput',
                pin: source,
                expression: fill(expression, undefined, found.pin.type),
              }),
          },
        ];
      }

      // Empty space: a lone value at the end of the function under it.
      return [
        {
          ...base,
          action: () => {
            // It floats until it is wired in.
            emitOp(
              ctx.looseNode(
                { type: 'value', expression: fill(expression) },
                state.world
              )
            );
          },
        },
      ];
    });
  }

  /** Actions of the empty graph (no wire was dragged). */
  function backgroundEntries(state: MenuState): ActionEntry[] {
    const v = ctx.view.value;
    return [
      ...(props.editable ? addNodeEntries(ctx, state, true) : []),
      ...(props.editable ? expressionActions(state) : []),
      ...(props.editable
        ? [
            {
              label: 'Paste here',
              category: 'Graph',
              icon: 'i-mdi-content-paste',
              hint: shortcut('V'),
              keywords: 'clipboard insert',
              action: () => void ctx.pasteFromClipboard(state.world),
            },
          ]
        : []),
      {
        label: 'Find…',
        category: 'Graph',
        icon: 'i-mdi-magnify',
        hint: shortcut('F'),
        action: () => void ctx.openSearch(),
      },
      {
        label: 'Select all',
        category: 'Graph',
        icon: 'i-mdi-select-all',
        hint: shortcut('A'),
        action: () => v?.selectAll(),
      },
      {
        label: 'Zoom to fit all',
        category: 'Graph',
        icon: 'i-mdi-fit-to-screen-outline',
        hint: 'Home',
        action: () => v?.frameAll(),
      },
      ...(props.editable
        ? [
            {
              // UE's "Add Comment…": a comment box around the selection.
              label: 'Add Comment…',
              category: '',
              icon: 'i-mdi-comment-multiple-outline',
              hint: 'C',
              keywords: 'comment box region group',
              ...(ctx.selection.value.length === 0
                ? {
                    disabled:
                      'Select the nodes first: a comment box wraps them in the code.',
                  }
                : {}),
              action: () =>
                commands.createCommentBox(
                  [...ctx.selection.value],
                  state.client
                ),
            },
          ]
        : []),
    ];
  }

  function actionEntries(state: MenuState): ActionEntry[] {
    if (!state.from) {
      return backgroundEntries(state);
    }

    const source = state.from;
    const found = pinOf(source);
    if (!found || !props.editable) {
      return [];
    }

    const { node, pin } = found;
    if (pin.kind === 'exec') {
      return addNodeEntries(ctx, state, pin.direction === 'out');
    }

    if (pin.direction === 'out') {
      const named = node.kind === 'setVar' || node.kind === 'entry';
      const members = memberEntries(ctx, pin, source, state);
      const ownMethod = (callee: string): string | undefined =>
        ownMethodName(node, pin, callee);
      const methods = callables.value.flatMap((callee): ActionEntry[] => {
        const name = ownMethod(callee);
        const label = `.${name}()`;
        return name === undefined || members.some((m) => m.label === label)
          ? []
          : [
              {
                label,
                category: `Members of ${valueName(node, pin) ?? node.title}`,
                icon: ICON_CALL,
                detail: signatureOf(callee).detail,
                keywords: callee,
                action: () =>
                  emitOp({
                    type: 'useValue',
                    pin: source,
                    expression: methodCallExpression(props.types, pin, name),
                    position: { ...state.world },
                  }),
              },
            ];
      });
      return [
        ...members,
        ...methods,
        ...callables.value
          .filter((callee) => ownMethod(callee) === undefined)
          .map((callee): ActionEntry => ({
            label: `${callee}(value)`,
            category: 'Call function with this value',
            icon: ICON_CALL,
            detail: signatureOf(callee).detail,
            keywords: callee,
            fits: fitsType(pin.type, signatureOf(callee).first),
            action: () =>
              emitOp({
                type: 'callWith',
                pin: source,
                callee,
                position: { ...state.world },
              }),
          })),
        ...externalNames.value
          .filter((external) => external.kind === 'function')
          .map((external): ActionEntry => ({
            label: `${external.callee}(value)`,
            category: 'Call function with this value',
            icon: ICON_IMPORT,
            detail: external.detail,
            hint: external.where,
            fits: fitsType(pin.type, external.first),
            keywords: `${external.callee} ${external.path} import`,
            action: () =>
              emitOp(
                withImport(external, {
                  type: 'callWith',
                  pin: source,
                  callee: external.callee,
                  position: { ...state.world },
                })
              ),
          })),
        ...elementEntries(props.types, pin, source, state.world, emitOp),
        ...containerEntries(props.types, pin, source, state.world, emitOp),
        ...throwEntries(props.types, source, state.world, emitOp),
        // Set a variable to this value (`score = value`).
        ...scopeVariables(props.doc, index.value.nodes.get(source.node)?.fn.id)
          .filter((variable) => !variable.constant)
          .map((variable): ActionEntry => ({
            label: `Set ${variable.expression}`,
            category: 'Variables',
            icon: ICON_SET,
            hint: variable.type,
            keywords: 'set assign store',
            fits: isTypeCompatible(pin.type, variable.dataType),
            action: () =>
              emitOp({
                type: 'useValue',
                pin: source,
                expression: `${variable.expression} = $value`,
                position: { ...state.world },
              }),
          })),
        ...(named
          ? []
          : [
              {
                // UE lists it first, above the categories.
                label: 'Promote to Variable…',
                category: '',
                first: true,
                icon: 'i-mdi-variable text-sky-400',
                keywords: 'promote store const let',
                action: () => commands.promoteTo(source, pin, state.world),
              },
            ]),
        ...expressionActions(state),
      ];
    }

    const extract = commands.extractEntry(source, pin, state.world);
    const near = variablesNear(index.value, node.id);
    return [
      ...variableReadEntries(
        near,
        scopeVariables(
          props.doc,
          index.value.nodes.get(node.id)?.fn.id,
          codeOffset(index.value, node.id)
        ),
        pin.type,
        (expression) => emitOp({ type: 'setInput', pin: source, expression })
      ),
      // The file's own functions give their result; Context Sensitive hides
      // only those that say they return nothing or another type.
      ...callables.value.map((callee): ActionEntry => {
        const signature = signatureOf(callee);
        return {
          label: `${callee}()`,
          category: 'Call function',
          icon: ICON_CALL,
          detail: signature.detail,
          fits: fitsType(signature.returns, pin.type),
          keywords: callee,
          action: () =>
            emitOp({
              type: 'setInput',
              pin: source,
              expression: `${callee}()`,
            }),
        };
      }),
      ...externalNames.value.map((external): ActionEntry => {
        const expression =
          external.kind === 'function'
            ? `${external.callee}()`
            : external.expression;
        return {
          // Imported variables like the file's own: UE's "Get <name>".
          label:
            external.kind === 'function' || external.kind === 'class'
              ? expression
              : `Get ${expression}`,
          category:
            external.kind === 'function'
              ? 'Call function'
              : external.kind === 'class'
                ? 'Construct'
                : 'Variables',
          icon: ICON_IMPORT,
          detail: external.detail,
          hint: external.where,
          fits:
            external.kind === 'function'
              ? fitsType(external.returns, pin.type)
              : undefined,
          keywords: `${external.name} ${external.kind === 'class' ? 'new construct create ' : ''}${external.path} import`,
          action: () =>
            emitOp(
              withImport(external, {
                type: 'setInput',
                pin: source,
                expression,
              })
            ),
        };
      }),
      ...makeEntries(props.doc, state.from, pinOf, emitOp),
      ...expressionActions(state),
      ...(extract.type === undefined || extract.type === 'item'
        ? [
            {
              label: extract.label,
              category: '',
              first: true,
              icon: extract.icon,
              keywords: 'promote extract store const let',
              action: () => extract.action(),
            },
          ]
        : []),
      {
        label: 'Replace with value…',
        category: 'Value',
        icon: 'i-mdi-form-textbox',
        keywords: 'literal expression',
        action: () =>
          void ask({
            label: 'New value or expression',
            placeholder: pin.type === 'string' ? '"text"' : '42',
            value: pin.range
              ? props.text.slice(pin.range.start, pin.range.end)
              : '',
            submit: (expression) =>
              emitOp({ type: 'setInput', pin: source, expression }),
          }),
      },
    ];
  }

  function actionTitle(state: MenuState): string {
    const found = state.from ? pinOf(state.from) : undefined;
    if (!found) {
      return 'All Actions for this Script';
    }

    if (found.pin.kind === 'exec') {
      return 'Executable actions';
    }

    return found.pin.direction === 'out'
      ? `Actions taking ${String(found.pin.type)}`
      : `Actions providing ${String(found.pin.type)}`;
  }

  return {
    actionEntries,
    suggestActions: (state, query) => suggestEntries(ctx, state, query),
    actionTitle,
  };
}
