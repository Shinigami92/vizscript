import type { Pin, PinRef } from '@vizscript/core';
import { qualifiedName } from '@vizscript/core';
import type { ActionEntry } from '../ActionMenu.vue';
import { methodCallExpression } from './container-entries';
import { engineMembers } from './engine-entries';
import { ICON_CALL, ICON_MEMBER } from './menu-data';
import type { CanvasContext, MenuState } from './types';

/** An action that reads `member` of the value at `source`. */
function readMember(
  ctx: CanvasContext,
  source: PinRef,
  state: MenuState,
  member: { name: string; method: boolean }
): () => void {
  return () =>
    ctx.emitOp({
      type: 'useValue',
      pin: source,
      expression: member.method
        ? methodCallExpression(
            ctx.props.types,
            ctx.pinOf(source)?.pin,
            member.name
          )
        : `$value.${member.name}`,
      position: { ...state.world },
    });
}

/**
 * Fields and methods of a value's type, like UE's "Target is …" actions:
 * those a type checker saw (with inherited ones, also of library types),
 * else the fields of an interface or object type of the file, the public
 * members of a class of the file, or the members of an engine class.
 */
export function memberEntries(
  ctx: CanvasContext,
  pin: Pin,
  source: PinRef,
  state: MenuState
): ActionEntry[] {
  const { props } = ctx;
  const typeName = String(pin.type);
  const checked =
    pin.typeText === undefined
      ? undefined
      : props.doc?.typeMembers?.[pin.typeText];
  if (checked && checked.length > 0) {
    // The checked type as the language writes it (`Option<Item>`).
    const category = `Members of ${pin.typeText ?? typeName}`;
    return checked.map((member): ActionEntry => {
      const method = member.kind === 'method';
      return {
        label: method ? `.${member.name}()` : `.${member.name}`,
        category,
        icon: method ? ICON_CALL : ICON_MEMBER,
        hint: String(member.type),
        ...(member.detail ? { detail: member.detail } : {}),
        keywords: `${member.name} member property method field`,
        action: readMember(ctx, source, state, { name: member.name, method }),
      };
    });
  }

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
    // A class of the engine (Godot's `Area2D`), with inherited members.
    return engineMembers(props.types, typeName).map((member): ActionEntry => ({
      label: member.method ? `.${member.name}()` : `.${member.name}`,
      category: `Members of ${typeName}`,
      icon: member.method ? ICON_CALL : ICON_MEMBER,
      hint: member.owner === typeName ? member.type : member.owner,
      ...(member.detail ? { detail: member.detail } : {}),
      keywords: `${member.name} ${member.owner} member property method`,
      action: readMember(ctx, source, state, member),
    }));
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
    action: readMember(ctx, source, state, member),
  }));
}
