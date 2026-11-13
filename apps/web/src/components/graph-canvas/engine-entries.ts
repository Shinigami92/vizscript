import type {
  GraphDocument,
  ScriptSymbol,
  TypeSystemInfo,
} from '@vizscript/core';
import { classMembers } from '@vizscript/core';

/** A member of a class the language knows (Godot's `Node.add_child`). */
export interface EngineMember {
  name: string;
  /** Type of a property, or the result of a method, as written. */
  type: string;
  method: boolean;
  /** The class that declares it (`Node` for `Area2D.is_in_group`). */
  owner: string;
  /** Signature of a method: `add_child(node: Node, …) -> void`. */
  detail?: string;
}

function detailOf(symbol: ScriptSymbol): string {
  const params = (symbol.params ?? [])
    .map(
      (p) =>
        `${p.name}${p.type ? `: ${p.type.text}` : ''}${p.defaultText === undefined ? '' : ` = ${p.defaultText}`}`
    )
    .join(', ');
  return `${symbol.name}(${params}) -> ${symbol.returns?.text ?? 'void'}`;
}

/**
 * Methods and properties of a class with its inherited ones (UE's "Target
 * is Node" actions); signals and constants are left out.
 */
export function engineMembers(
  types: TypeSystemInfo | null | undefined,
  className: string | undefined
): EngineMember[] {
  return classMembers(types?.classes, className)
    .filter((s) => s.kind === 'method' || s.kind === 'variable')
    .map((s) => ({
      name: s.name,
      type:
        s.kind === 'method'
          ? (s.returns?.text ?? 'void')
          : (s.type?.text ?? String(s.dataType)),
      method: s.kind === 'method',
      owner: s.scope,
      ...(s.kind === 'method' ? { detail: detailOf(s) } : {}),
    }));
}

/** The engine class a script extends (`extends CharacterBody2D`). */
export function scriptBaseClass(
  doc: GraphDocument | null,
  types: TypeSystemInfo | null | undefined
): string | undefined {
  if (!types?.classes?.length) {
    return undefined;
  }

  const base = doc?.settings?.find((s) => s.id === 'extends')?.value.trim();
  const name = base || 'RefCounted';
  return types.classes.some((c) => c.name === name) ? name : undefined;
}
