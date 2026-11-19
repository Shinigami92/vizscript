import { topLevelGraph } from '../../graph/symbols';
import type { ActionEntry } from '../ActionMenu.vue';
import { engineMembers, scriptBaseClass } from './engine-entries';
import {
  callSignature,
  globalObjects,
  scopeVariables,
  typeDefault,
  withImport,
} from './graph-helpers';
import {
  FLOW_ENTRIES,
  ICON_CALL,
  ICON_IMPORT,
  ICON_SET,
  ICON_VARIABLE,
  JUMPS,
} from './menu-data';
import type { CanvasContext, MenuState } from './types';

/**
 * `new X()` of classes this file imports already (TypeScript) and of the
 * language's built-in classes (`new Error()`): one node each.
 */
function constructable(
  props: CanvasContext['props']
): Array<{ name: string; global: boolean }> {
  const imported =
    props.doc?.language === 'typescript'
      ? (props.doc.symbols ?? [])
          .filter((s) => s.kind === 'import' && s.importedKind === 'class')
          .map((s) => s.name)
      : [];
  return [
    ...imported.map((name) => ({ name, global: false })),
    ...(props.types?.constructors ?? [])
      .filter((name) => !imported.includes(name))
      .map((name) => ({ name, global: true })),
  ];
}

/**
 * Methods and properties the script inherits from its engine class
 * (`extends CharacterBody2D`: `move_and_slide()`, `velocity`), like UE's
 * functions and variables of the parent class.
 */
function inheritedEntries(ctx: CanvasContext, state: MenuState): ActionEntry[] {
  const { props, addNode } = ctx;
  const own = new Set(ctx.callables.value);
  const base = scriptBaseClass(props.doc, props.types);
  const category = `Inherited from ${base}`;
  return engineMembers(props.types, base).flatMap((member): ActionEntry[] => {
    if (member.method) {
      return own.has(member.name)
        ? []
        : [
            {
              label: member.name,
              category,
              icon: ICON_CALL,
              hint: member.owner,
              ...(member.detail ? { detail: member.detail } : {}),
              action: () =>
                addNode({ type: 'call', callee: member.name }, state),
            },
          ];
    }

    return [
      ...(state.from
        ? []
        : [
            {
              label: `Get ${member.name}`,
              category,
              icon: ICON_VARIABLE,
              hint: member.type,
              keywords: `get read ${member.owner}`,
              action: () =>
                addNode({ type: 'value', expression: member.name }, state),
            },
          ]),
      {
        label: `Set ${member.name}`,
        category,
        icon: ICON_SET,
        hint: member.type,
        keywords: `set assign write ${member.owner}`,
        action: () =>
          addNode(
            {
              type: 'setVar',
              name: member.name,
              declaration: 'none',
              value: typeDefault(props.types, member.type),
            },
            state
          ),
      },
    ];
  });
}

/** Add-node actions at an exec pin (or, without one, at the end). */
export function addNodeEntries(
  ctx: CanvasContext,
  state: MenuState,
  after: boolean
): ActionEntry[] {
  const { props, addNode, ask } = ctx;
  const fnId = state.from
    ? ctx.index.value.nodes.get(state.from.node)?.fn.id
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
                    value: typeDefault(props.types, variable.type),
                  },
                  state
                ),
            },
          ]),
    ]),
    // UE's Get of a global object; not from an exec pin (no exec pins).
    ...(state.from
      ? []
      : globalObjects(props.doc, props.types).map((global): ActionEntry => ({
          label: `Get ${global.name}`,
          category: 'Globals',
          icon: ICON_VARIABLE,
          hint: global.hint,
          keywords: 'get read',
          action: () =>
            addNode({ type: 'value', expression: global.name }, state),
        }))),
    ...ctx.callables.value.map((callee): ActionEntry => ({
      label: callee,
      category: 'Call function',
      icon: ICON_CALL,
      detail: callSignature(props.doc, props.text, callee).detail,
      action: () => addNode({ type: 'call', callee }, state),
    })),
    ...constructable(props).map(({ name, global }): ActionEntry => ({
      label: `new ${name}()`,
      category: 'Construct',
      icon: ICON_CALL,
      ...(global ? { hint: 'global' } : {}),
      keywords: `${name} new construct create`,
      action: () =>
        addNode({ type: 'value', expression: `new ${name}()` }, state),
    })),
    ...ctx.externalNames.value.map((external): ActionEntry =>
      external.kind === 'class'
        ? {
            // UE's "Construct Object": a new instance, with its import.
            label: external.expression,
            category: 'Construct',
            icon: ICON_IMPORT,
            hint: external.where,
            // Context Sensitive on empty space: this file and its imports.
            ...(state.from ? {} : { fits: false }),
            keywords: `${external.name} new construct create ${external.path} import`,
            action: () =>
              addNode(
                { type: 'value', expression: external.expression },
                state,
                (op) => withImport(external, op)
              ),
          }
        : {
            label: external.callee,
            category: 'Call function',
            icon: ICON_IMPORT,
            detail: external.detail,
            hint: external.where,
            ...(state.from ? {} : { fits: false }),
            keywords: `${external.path} import`,
            action: () =>
              addNode({ type: 'call', callee: external.callee }, state, (op) =>
                withImport(external, op)
              ),
          }
    ),
    ...inheritedEntries(ctx, state),
    {
      label: 'Branch (if)',
      category: 'Flow control',
      icon: 'i-mdi-source-branch',
      keywords: 'if condition',
      action: () => addNode({ type: 'branch' }, state),
    },
    // No `return` in the file's top level (a module).
    ...(after && fnId !== topLevelGraph(props.doc, props.text)?.id
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
          state.from !== undefined || (flow !== 'break' && flow !== 'continue')
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
