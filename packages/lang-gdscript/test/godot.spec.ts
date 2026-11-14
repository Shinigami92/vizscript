import type { GraphDocument, GraphNode, GraphOp } from '@vizscript/core';
import { applyTextEdits, classMembers } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import {
  applyGDScriptOp,
  gdscriptBackend,
  parseGDScriptDocument,
} from '../src';

function apply(text: string, op: GraphOp): string {
  const result = applyGDScriptOp(text, op, 'x.gd');
  if (!result.ok) {
    throw new Error(result.error);
  }

  return applyTextEdits(text, result.edits);
}

function call(doc: GraphDocument, title: string): GraphNode {
  const node = doc.functions
    .flatMap((f) => f.nodes)
    .find((n) => n.title === title);
  if (!node) {
    throw new Error(`no ${title}`);
  }

  return node;
}

/** Inputs and output of a node: `name:type`. */
function pins(node: GraphNode): string[] {
  return node.pins
    .filter((p) => p.kind === 'data')
    .map((p) => `${p.direction} ${p.name}:${String(p.type)}`);
}

function symbolId(doc: GraphDocument, name: string): string {
  const symbol = doc.symbols?.find((s) => s.name === name);
  if (!symbol) {
    throw new Error(`no ${name}`);
  }

  return symbol.id;
}

describe('Godot classes', () => {
  it('knows classes with their inherited members', () => {
    const members = classMembers(
      gdscriptBackend.typeSystem?.classes,
      'Area2D'
    ).map((m) => m.name);
    expect(members).toContain('get_overlapping_bodies');
    expect(members).toContain('global_position');
    expect(members).toContain('is_in_group');
  });

  it('names and types the pins of engine calls', () => {
    const text = [
      'extends CharacterBody2D',
      '',
      '@onready var sprite: Sprite2D = $Sprite2D',
      '',
      '',
      'func _collect(area: Area2D) -> void:',
      '\tif area.is_in_group(&"coins"):',
      '\t\tsprite.look_at(position)',
      '\tif Input.is_action_pressed(&"jump"):',
      '\t\tmove_and_slide()',
      '',
    ].join('\n');
    const doc = parseGDScriptDocument(text, 'x.gd');
    expect(pins(call(doc, 'is_in_group'))).toEqual([
      'in Target:object',
      'in group:StringName',
      'out :bool',
    ]);
    expect(pins(call(doc, 'sprite.look_at'))).toEqual(['in point:Vector2']);
    expect(pins(call(doc, 'Input.is_action_pressed'))).toEqual([
      'in action:StringName',
      'in exact_match:bool',
      'out :bool',
    ]);
    expect(pins(call(doc, 'move_and_slide'))).toEqual(['out :bool']);
    // Inherited properties have their types.
    expect(pins(call(doc, 'position'))).toEqual(['out :Vector2']);
  });
});

describe('signal inputs', () => {
  it('adds the first input of a signal and passes it to its emits', () => {
    const text = 'signal changed\n\n\nfunc a() -> void:\n\tchanged.emit()\n';
    const doc = parseGDScriptDocument(text, 'x.gd');
    expect(
      apply(text, {
        type: 'addParameter',
        symbol: symbolId(doc, 'changed'),
        name: 'value',
        typeText: 'int',
      })
    ).toBe(
      'signal changed(value: int)\n\n\nfunc a() -> void:\n\tchanged.emit(null)\n'
    );
  });

  it('removes an input of a signal and its argument', () => {
    const text =
      'signal changed(a, b)\n\n\nfunc f() -> void:\n\tchanged.emit(1, 2)\n';
    const doc = parseGDScriptDocument(text, 'x.gd');
    expect(
      apply(text, {
        type: 'removeParameter',
        symbol: symbolId(doc, 'changed'),
        index: 0,
      })
    ).toBe('signal changed(b)\n\n\nfunc f() -> void:\n\tchanged.emit(2)\n');
  });
});

/** Sets the type of `speed`. */
function setSpeedType(text: string, typeText: string | null): string {
  return apply(text, {
    type: 'setSymbolType',
    symbol: symbolId(parseGDScriptDocument(text, 'x.gd'), 'speed'),
    typeText,
  });
}

describe('inferred types', () => {
  it('writes := for a type taken from the value', () => {
    expect(setSpeedType('var speed = 1.0\n', ':=')).toBe('var speed := 1.0\n');
    expect(setSpeedType('var speed: float = 1.0\n', ':=')).toBe(
      'var speed := 1.0\n'
    );
    expect(setSpeedType('var speed := 1.0\n', ':=')).toBe('var speed := 1.0\n');
  });

  it('turns := into a type or no type', () => {
    expect(setSpeedType('var speed := 1.0\n', 'float')).toBe(
      'var speed: float = 1.0\n'
    );
    expect(setSpeedType('var speed := 1.0\n', null)).toBe('var speed = 1.0\n');
  });

  it('needs a value for :=', () => {
    const text = 'var speed: float\n';
    const result = applyGDScriptOp(
      text,
      {
        type: 'setSymbolType',
        symbol: symbolId(parseGDScriptDocument(text, 'x.gd'), 'speed'),
        typeText: ':=',
      },
      'x.gd'
    );
    expect(result.ok).toBe(false);
  });
});

describe('const without a value', () => {
  it('gets the default of its type', () => {
    const text = 'var speed: float\n';
    expect(
      apply(text, {
        type: 'setModifier',
        symbol: symbolId(parseGDScriptDocument(text, 'x.gd'), 'speed'),
        modifier: 'const',
        enabled: true,
      })
    ).toBe('const speed: float = 0.0\n');
  });
});
