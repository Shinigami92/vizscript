import type { EngineClass, ScriptSymbol } from '@vizscript/core';
import { portableSymbols } from '@vizscript/core';
import { GODOT_API, GODOT_SINGLETONS } from './godot-api';
import { GODOT_BUILTINS, GODOT_GLOBALS } from './godot-builtins';
import { parseGDScript } from './parser';
import { gdscriptSymbols } from './symbols';

/** Members of a class, parsed from its declarations like a script. */
function members(name: string, text: string): ScriptSymbol[] {
  const { script } = parseGDScript(text);
  return portableSymbols(gdscriptSymbols(script.body, text), text).map(
    (symbol) => ({
      ...symbol,
      id: `godot:${name}.${symbol.name}`,
      scope: name,
      kind: symbol.kind === 'function' ? 'method' : symbol.kind,
    })
  );
}

let cache: EngineClass[] | undefined;

/** Godot's classes and global objects (a part of its class reference). */
export function godotClasses(): EngineClass[] {
  cache ??= [
    ...GODOT_API.map(([name, base, text]): EngineClass => ({
      name,
      ...(base ? { extends: base } : {}),
      members: members(name, text),
    })),
    ...GODOT_SINGLETONS.map(([name, text]): EngineClass => ({
      name,
      extends: 'Object',
      singleton: true,
      members: members(name, text),
    })),
  ];
  return cache;
}

/** Calls of Godot's global objects, for the action menu (`Input.…`). */
export function godotSingletonCalls(): string[] {
  return godotClasses()
    .filter((c) => c.singleton)
    .flatMap((c) =>
      c.members
        .filter((m) => m.kind === 'method')
        .map((m) => `${c.name}.${m.name}`)
    );
}

let builtins: EngineClass[] | undefined;

/** Godot's built-in value types (`Vector2`, `String`, `Array` …). */
export function godotBuiltins(): EngineClass[] {
  builtins ??= GODOT_BUILTINS.map(([name, text]): EngineClass => ({
    name,
    members: members(name, text),
  }));
  return builtins;
}

let globals: Map<string, ScriptSymbol> | undefined;

/** Godot's global functions (`print`, `randf`), by name. */
export function godotGlobals(): ReadonlyMap<string, ScriptSymbol> {
  globals ??= new Map(
    members('@GlobalScope', GODOT_GLOBALS).map((s) => [s.name, s])
  );
  return globals;
}
