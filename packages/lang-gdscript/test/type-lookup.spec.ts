import type { GraphDocument, Pin } from '@vizscript/core';
import { describe, expect, it } from 'vitest';
import { parseGDScriptDocument } from '../src';

const TEXT = `extends CharacterBody2D

signal hit(amount: int)

enum State { IDLE, RUN }

const SPEED = 300.0
var items: Array[Item] = []
var state = State.IDLE
@onready var timer := $Timer as Timer

class Item:
	var price: int
	func label() -> String:
		return "item"

func _physics_process(delta):
	var direction := Input.get_axis(&"left", &"right")
	velocity.x = direction * SPEED
	var top = velocity.normalized()
	var gap = top.distance_to(Vector2.ZERO)
	print(top.length())
	for item in items:
		var total = item.price * 2
		print(item.label().to_upper(), total)
	for i in 3:
		print(i)
	var picked = items.pick_random()
	var power = clamp(delta, 0, 1)
	hit.emit(Item.new().price)
	var scene = preload("res://enemy.tscn")
	timer.start()
`;

/** Every data output with a source range: its code and Godot type. */
function outputs(doc: GraphDocument): Map<string, Pin> {
  const pins = new Map<string, Pin>();
  for (const node of doc.functions.flatMap((f) => f.nodes)) {
    for (const pin of node.pins) {
      if (pin.range && pin.direction === 'out' && pin.kind === 'data') {
        pins.set(TEXT.slice(pin.range.start, pin.range.end), pin);
      }
    }
  }

  return pins;
}

describe('the GDScript type lookup', () => {
  const doc = parseGDScriptDocument(TEXT, 'player.gd');
  const pins = outputs(doc);
  const typeOf = (code: string): string | undefined => pins.get(code)?.typeText;

  it('follows variables, members and Godot classes', () => {
    expect(typeOf('Input.get_axis(&"left", &"right")')).toBe('float');
    expect(typeOf('direction * SPEED')).toBe('float');
    expect(typeOf('velocity.normalized()')).toBe('Vector2');
    expect(typeOf('top.length()')).toBe('float');
    expect(typeOf('item.price * 2')).toBe('int');
    expect(typeOf('item.label().to_upper()')).toBe('String');
    expect(typeOf('items.pick_random()')).toBe('Item');
    expect(typeOf('clamp(delta, 0, 1)')).toBe('float');
    expect(typeOf('preload("res://enemy.tscn")')).toBe('PackedScene');
    expect(pins.get('item.price * 2')?.type).toBe('number');
  });

  it('types untyped declarations', () => {
    const symbols = new Map((doc.symbols ?? []).map((s) => [s.name, s]));
    expect(symbols.get('state')?.dataType).toBe('number');
    expect(symbols.get('timer')?.dataType).toBe('Timer');
    expect(symbols.get('top')?.dataType).toBe('Vector2');
    expect(symbols.get('item')?.dataType).toBe('Item');
    expect(symbols.get('i')?.dataType).toBe('number');
    const params = symbols.get('_physics_process')?.params ?? [];
    expect(params.map((p) => p.dataType)).toEqual(['number']);
  });

  it('drops results of functions that return nothing', () => {
    const calls = doc.functions
      .flatMap((f) => f.nodes)
      .filter((n) => n.title === 'print' || n.title === 'emit');
    expect(calls.length).toBe(4);
    expect(
      calls.flatMap((n) => n.pins.filter((p) => p.id === 'return'))
    ).toEqual([]);
  });

  it('lists members of built-in types for the action menu', () => {
    const vector = doc.typeMembers?.Vector2 ?? [];
    expect(vector.find((m) => m.name === 'x')).toMatchObject({
      kind: 'property',
      type: 'number',
      detail: 'x: float',
    });
    expect(vector.find((m) => m.name === 'move_toward')).toMatchObject({
      kind: 'method',
      type: 'Vector2',
      detail: 'move_toward(to: Vector2, delta: float) -> Vector2',
    });
  });

  it('names and types the arguments of Godot methods', () => {
    const call = doc.functions
      .flatMap((f) => f.nodes)
      .find((n) => n.title === 'distance_to');
    expect(
      call?.pins
        .filter(
          (p) => p.direction === 'in' && p.kind === 'data' && p.id !== 'target'
        )
        .map((p) => [p.name, p.type])
    ).toEqual([['to', 'Vector2']]);
  });
});
