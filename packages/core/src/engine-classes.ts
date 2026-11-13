import type { ScriptSymbol } from './symbols';

/**
 * A class the language knows without a file declaring it: an engine's API
 * (Godot's `Node`, `Area2D`), like UE's native classes. Members are
 * portable symbols (ranges point nowhere, default values are text).
 */
export interface EngineClass {
  name: string;
  /** Base class (`Area2D` extends `CollisionObject2D`). */
  extends?: string;
  /**
   * A global object rather than a type (`Input`, `OS`): its methods are
   * called on its name (`Input.is_action_pressed()`).
   */
  singleton?: boolean;
  members: ScriptSymbol[];
}

/** The class and its bases, nearest first (unknown names: empty). */
export function classChain(
  classes: ReadonlyArray<EngineClass> | undefined,
  name: string | undefined
): EngineClass[] {
  const chain: EngineClass[] = [];
  let current = name ? classes?.find((c) => c.name === name) : undefined;
  while (current && !chain.includes(current)) {
    chain.push(current);
    const base = current.extends;
    current = base ? classes?.find((c) => c.name === base) : undefined;
  }

  return chain;
}

/**
 * Members of a class with the inherited ones, own first; a member a class
 * declares again hides the base class's one.
 */
export function classMembers(
  classes: ReadonlyArray<EngineClass> | undefined,
  name: string | undefined
): ScriptSymbol[] {
  const seen = new Set<string>();
  const members: ScriptSymbol[] = [];
  for (const cls of classChain(classes, name)) {
    for (const member of cls.members) {
      if (!seen.has(member.name)) {
        seen.add(member.name);
        members.push(member);
      }
    }
  }

  return members;
}

/** A method of a class or of one of its bases. */
export function classMethod(
  classes: ReadonlyArray<EngineClass> | undefined,
  name: string | undefined,
  method: string
): ScriptSymbol | undefined {
  return classMembers(classes, name).find(
    (s) => s.name === method && (s.kind === 'function' || s.kind === 'method')
  );
}
