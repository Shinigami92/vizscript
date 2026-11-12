import type { Pin, PinRef, Point } from '@vizscript/core';
import { isTypeCompatible, qualifiedName } from '@vizscript/core';
import { shortcut } from '../../graph/source';
import type { ActionEntry } from '../ActionMenu.vue';
import {
  callSignature,
  fillTemplate,
  fitsType,
  scopeVariables,
  variablesNear,
  withImport,
} from './graph-helpers';
import {
  EXPRESSION_ICONS,
  FLOW_ENTRIES,
  ICON_CALL,
  ICON_IMPORT,
  ICON_MEMBER,
  ICON_SET,
  ICON_VARIABLE,
  IDENTIFIER_PATH,
  JUMPS,
  VALUE_WORDS,
} from './menu-data';
import type { NodeCommands } from './node-commands';
import type { CanvasContext, MenuState } from './types';

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
  const { props, emitOp, addNode, ask, pinOf, commands } = ctx;
  const index = ctx.index;
  const callables = ctx.callables;
  const externalNames = ctx.externalNames;
  const signatureOf = (callee: string): ReturnType<typeof callSignature> =>
    callSignature(props.doc, props.text, callee);
  const fill = (template: string, first?: string): string =>
    fillTemplate(template, props.types?.placeholder ?? 'undefined', first);

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
        hint: fill(expression.template, '·').replaceAll(
          props.types?.placeholder ?? 'undefined',
          '·'
        ),
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
                expression: fill(expression.template, '$value'),
                position: { ...state.world },
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
                expression: fill(expression.template),
              }),
          },
        ];
      }

      // Empty space: a lone value at the end of the function under it.
      return [
        {
          ...base,
          action: () => {
            const place = ctx.placeAt(state.world);
            if (!place) {
              ctx.show('Add it inside a function.');
              return;
            }

            emitOp({
              type: 'addNode',
              template: {
                type: 'value',
                expression: fill(expression.template),
              },
              ...place.anchor,
              position: { ...state.world },
            });
          },
        },
      ];
    });
  }

  /** Add-node actions at an exec pin (or, without one, at the end). */
  function addNodeActions(state: MenuState, after: boolean): ActionEntry[] {
    const fnId = state.from
      ? index.value.nodes.get(state.from.node)?.fn.id
      : ctx.placeAt(state.world)?.fnId;
    return [
      // UE's Get / Set of every variable; a Get from an exec pin makes no
      // sense (it has no exec pins).
      ...scopeVariables(props.doc, fnId).flatMap((variable): ActionEntry[] => [
        ...(state.from
          ? []
          : [
              {
                label: `Get ${variable.expression}`,
                category: 'Variables',
                icon: ICON_VARIABLE,
                hint: variable.type,
                keywords: 'get read',
                action: () =>
                  addNode(
                    { type: 'value', expression: variable.expression },
                    state
                  ),
              },
            ]),
        ...(variable.constant
          ? []
          : [
              {
                label: `Set ${variable.expression}`,
                category: 'Variables',
                icon: ICON_SET,
                hint: variable.type,
                keywords: 'set assign write',
                action: () =>
                  addNode(
                    {
                      type: 'setVar',
                      name: variable.expression,
                      declaration: 'none',
                    },
                    state
                  ),
              },
            ]),
      ]),
      ...callables.value.map((callee): ActionEntry => ({
        label: callee,
        category: 'Call function',
        icon: ICON_CALL,
        detail: signatureOf(callee).detail,
        action: () => addNode({ type: 'call', callee }, state),
      })),
      ...externalNames.value.map((external): ActionEntry => ({
        label: external.callee,
        category: 'Call function',
        icon: ICON_IMPORT,
        detail: external.detail,
        hint: external.where,
        keywords: `${external.path} import`,
        action: () =>
          addNode({ type: 'call', callee: external.callee }, state, (op) =>
            withImport(external, op)
          ),
      })),
      {
        label: 'Branch (if)',
        category: 'Flow control',
        icon: 'i-mdi-source-branch',
        keywords: 'if condition',
        action: () => addNode({ type: 'branch' }, state),
      },
      ...(after
        ? [
            {
              label: 'Return',
              category: 'Flow control',
              icon: 'i-mdi-keyboard-return text-purple-400',
              action: () => addNode({ type: 'return' }, state),
            },
          ]
        : []),
      // UE's For Each Loop, For Loop, While Loop, Switch …, in the language's
      // syntax; jumps (break, throw) only after a statement, like Return.
      ...(props.types?.flow ?? [])
        .filter((flow) => after || !JUMPS.has(flow))
        // On empty space the node goes to the end of the function, never
        // into a loop: no break / continue there.
        .filter(
          (flow) =>
            state.from !== undefined ||
            (flow !== 'break' && flow !== 'continue')
        )
        .map((flow): ActionEntry => ({
          ...FLOW_ENTRIES[flow],
          category: 'Flow control',
          action: () => addNode({ type: 'flow', flow }, state),
        })),
      {
        label: 'Declare variable…',
        category: 'Variables',
        icon: 'i-mdi-variable text-sky-400',
        keywords: 'let const var set',
        // The search text found this entry, so it is no name ("Declare
        // variable foo" from the typed entries is).
        action: () =>
          void ask({
            label: 'Variable name',
            placeholder: 'value',
            value: '',
            submit: (name) =>
              addNode({ type: 'setVar', name, declaration: 'const' }, state),
          }),
      },
    ];
  }

  /**
   * Fields and methods of a value's type, like UE's "Target is …" actions:
   * the fields of an interface or object type of the file, the public members
   * of a class of the file.
   */
  function memberEntries(
    pin: Pin,
    source: PinRef,
    state: MenuState
  ): ActionEntry[] {
    const typeName = String(pin.type);
    const symbols = props.doc?.symbols ?? [];
    const declared = /^[A-Za-z_$][\w$]*$/.test(typeName)
      ? symbols.find(
          (s) =>
            s.name === typeName &&
            s.scope === '' &&
            (s.kind === 'type' || s.kind === 'class')
        )
      : undefined;
    if (!declared) {
      return [];
    }

    const scope = qualifiedName(declared);
    const members =
      declared.kind === 'class'
        ? symbols
            .filter(
              (s) =>
                s.scope === scope &&
                (s.kind === 'variable' ||
                  s.kind === 'constant' ||
                  s.kind === 'method') &&
                s.name !== 'constructor' &&
                !s.name.startsWith('#') &&
                !s.modifiers.includes('static') &&
                !s.modifiers.includes('private')
            )
            .map((s) => ({
              name: s.name,
              type: s.type?.text ?? String(s.dataType),
              method: s.kind === 'method',
            }))
        : (declared.fields ?? []).map((f) => ({
            name: f.name,
            type: f.type?.text ?? String(f.dataType),
            method: f.method === true,
          }));
    return members.map((member): ActionEntry => ({
      label: member.method ? `.${member.name}()` : `.${member.name}`,
      category: `Members of ${typeName}`,
      icon: member.method ? ICON_CALL : ICON_MEMBER,
      ...(member.method ? {} : { hint: member.type }),
      keywords: `${member.name} get member property field`,
      action: () =>
        emitOp({
          type: 'useValue',
          pin: source,
          expression: member.method
            ? `$value.${member.name}()`
            : `$value.${member.name}`,
          position: { ...state.world },
        }),
    }));
  }

  /** Actions of the empty graph (no wire was dragged). */
  function backgroundEntries(state: MenuState): ActionEntry[] {
    const v = ctx.view.value;
    return [
      ...(props.editable ? addNodeActions(state, true) : []),
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
      ...(props.editable && ctx.selection.value.length > 0
        ? [
            {
              // UE's "Add Comment…" around the selected nodes.
              label: 'Add comment box around selection…',
              category: 'Graph',
              icon: 'i-mdi-comment-multiple-outline',
              hint: 'C',
              keywords: 'comment box region group',
              action: () =>
                commands.createCommentBox(
                  [...ctx.selection.value],
                  state.client
                ),
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
      return addNodeActions(state, pin.direction === 'out');
    }

    if (pin.direction === 'out') {
      const named = node.kind === 'setVar' || node.kind === 'entry';
      return [
        ...memberEntries(pin, source, state),
        ...callables.value.map((callee): ActionEntry => ({
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
                label: 'Store in variable…',
                category: 'Variables',
                icon: 'i-mdi-variable text-sky-400',
                keywords: 'promote const let',
                action: () => commands.promoteTo(source, pin, state.world),
              },
            ]),
        ...expressionActions(state),
      ];
    }

    const extract = commands.extractEntry(source, pin, state.world);
    const near = variablesNear(index.value, node.id);
    return [
      ...near.map((variable): ActionEntry => ({
        label: variable.name,
        category: 'Variables',
        icon: ICON_VARIABLE,
        hint: variable.type,
        keywords: 'get',
        fits: isTypeCompatible(variable.type, pin.type),
        action: () =>
          emitOp({ type: 'setInput', pin: source, expression: variable.name }),
      })),
      // Fields and module variables too (the near ones come first).
      ...scopeVariables(props.doc, index.value.nodes.get(node.id)?.fn.id)
        .filter(
          (variable) =>
            !near.some((other) => other.name === variable.expression)
        )
        .map((variable): ActionEntry => ({
          label: variable.expression,
          category: 'Variables',
          icon: ICON_VARIABLE,
          hint: variable.type,
          keywords: 'get',
          fits: isTypeCompatible(variable.dataType, pin.type),
          action: () =>
            emitOp({
              type: 'setInput',
              pin: source,
              expression: variable.expression,
            }),
        })),
      ...callables.value.map((callee): ActionEntry => ({
        label: `${callee}()`,
        category: 'Call function',
        icon: ICON_CALL,
        detail: signatureOf(callee).detail,
        keywords: callee,
        fits: fitsType(signatureOf(callee).returns, pin.type),
        action: () =>
          emitOp({ type: 'setInput', pin: source, expression: `${callee}()` }),
      })),
      ...externalNames.value.map((external): ActionEntry => {
        const expression =
          external.kind === 'function'
            ? `${external.callee}()`
            : external.expression;
        return {
          label: expression,
          category:
            external.kind === 'function' ? 'Call function' : 'Variables',
          icon: ICON_IMPORT,
          detail: external.detail,
          hint: external.where,
          fits:
            external.kind === 'function'
              ? fitsType(external.returns, pin.type)
              : undefined,
          keywords: `${external.name} ${external.path} import`,
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
      ...expressionActions(state),
      ...(extract.type === undefined || extract.type === 'item'
        ? extract.disabled
          ? []
          : [
              {
                label: extract.label,
                category: 'Value',
                icon: extract.icon,
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

  function suggestActions(state: MenuState, query: string): ActionEntry[] {
    const found = state.from ? pinOf(state.from) : undefined;
    const source = state.from;
    const reserved = new Set(props.types?.keywords ?? []).has(
      query.split('.')[0] ?? query
    );
    // Names the menu offers already ("greeter()") need no typed twin.
    const known =
      callables.value.includes(query) ||
      externalNames.value.some((e) => e.callee === query);
    const callable = IDENTIFIER_PATH.test(query) && !reserved && !known;
    const declarable = /^[A-Za-z_$][\w$]*$/.test(query) && !reserved;
    if (!props.editable) {
      return [];
    }

    if (!found || !source || found.pin.kind === 'exec') {
      return [
        ...(callable
          ? [
              {
                label: `Call ${query}()`,
                category: 'Typed',
                icon: ICON_CALL,
                action: () => addNode({ type: 'call', callee: query }, state),
              },
            ]
          : []),
        ...(declarable
          ? [
              {
                label: `Declare variable ${query}`,
                category: 'Typed',
                icon: 'i-mdi-variable text-sky-400',
                action: () =>
                  addNode(
                    { type: 'setVar', name: query, declaration: 'const' },
                    state
                  ),
              },
            ]
          : []),
      ];
    }

    if (found.pin.direction === 'out') {
      return callable
        ? [
            {
              label: `Call ${query}(value)`,
              category: 'Typed',
              icon: ICON_CALL,
              action: () =>
                emitOp({
                  type: 'callWith',
                  pin: source,
                  callee: query,
                  position: { ...state.world },
                }),
            },
          ]
        : [];
    }

    // A value written by hand: not an operator alone ("+"), not a variable
    // the menu lists anyway.
    const listed = scopeVariables(
      props.doc,
      index.value.nodes.get(found.node.id)?.fn.id
    ).some((v) => v.expression === query);
    return [
      ...(/[\w$'"`]/.test(query) &&
      !listed &&
      (!reserved || VALUE_WORDS.has(query))
        ? [
            {
              label: `Use ${query}`,
              category: 'Typed',
              icon: 'i-mdi-form-textbox',
              action: () =>
                emitOp({ type: 'setInput', pin: source, expression: query }),
            },
          ]
        : []),
      ...(callable
        ? [
            {
              label: `Call ${query}()`,
              category: 'Typed',
              icon: ICON_CALL,
              action: () =>
                emitOp({
                  type: 'setInput',
                  pin: source,
                  expression: `${query}()`,
                }),
            },
          ]
        : []),
    ];
  }

  function actionTitle(state: MenuState): string {
    const found = state.from ? pinOf(state.from) : undefined;
    if (!found) {
      return 'All actions';
    }

    if (found.pin.kind === 'exec') {
      return found.pin.direction === 'out'
        ? 'Add node after'
        : 'Add node before';
    }

    return found.pin.direction === 'out'
      ? `Actions taking ${String(found.pin.type)}`
      : `Actions providing ${String(found.pin.type)}`;
  }

  return { actionEntries, suggestActions, actionTitle };
}
