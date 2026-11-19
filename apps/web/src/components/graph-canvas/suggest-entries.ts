import type { ActionEntry } from '../ActionMenu.vue';
import { methodCallExpression } from './container-entries';
import { scopeVariables } from './graph-helpers';
import {
  ICON_CALL,
  ICON_MEMBER,
  IDENTIFIER_PATH,
  VALUE_WORDS,
} from './menu-data';
import type { CanvasContext, MenuState } from './types';

/**
 * Actions made from the menu's search text: call, declare, read or use
 * exactly what was typed.
 */
export function suggestEntries(
  ctx: CanvasContext,
  state: MenuState,
  query: string
): ActionEntry[] {
  const { props, emitOp, addNode, pinOf } = ctx;
  const found = state.from ? pinOf(state.from) : undefined;
  const source = state.from;
  const reserved = new Set(props.types?.keywords ?? []).has(
    query.split('.')[0] ?? query
  );
  // Names the menu offers already ("greeter()") need no typed twin.
  const known =
    ctx.callables.value.includes(query) ||
    ctx.externalNames.value.some((e) => e.callee === query);
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
    // A member of the value (`.description()`), also for types the
    // editor doesn't know; on a call's unused result it continues the
    // chain (`program.name('x').description()`).
    const member = query.replace(/^\./, '');
    const useMember = (expression: string): void =>
      emitOp({
        type: 'useValue',
        pin: source,
        expression,
        position: { ...state.world },
      });
    const members: ActionEntry[] = /^[A-Za-z_$][\w$]*$/.test(member)
      ? [
          {
            label: `.${member}()`,
            category: 'Typed',
            icon: ICON_CALL,
            hint: 'call on the value',
            action: () =>
              useMember(methodCallExpression(props.types, found.pin, member)),
          },
          {
            label: `.${member}`,
            category: 'Typed',
            icon: ICON_MEMBER,
            hint: 'member of the value',
            action: () => useMember(`$value.${member}`),
          },
        ]
      : [];
    return [
      ...members,
      ...(callable
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
        : []),
    ];
  }

  // A value written by hand: not an operator alone ("+"), not a variable
  // the menu lists anyway.
  const listed = scopeVariables(
    props.doc,
    ctx.index.value.nodes.get(found.node.id)?.fn.id
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
