@tool
class_name Turret
extends Node3D
## A turret that tracks the nearest enemy and fires at it.

signal fired(target: Node3D)

enum State { IDLE, TRACKING }

const RANGE: float = 12.0

@export var fire_rate := 2.0
@export_range(0, 10) var damage: int = 3
@onready var barrel: Node3D = $Head/Barrel

var state := State.IDLE
var ammo: int = 20:
	set(value):
		ammo = clampi(value, 0, 99)


func _ready() -> void:
	$Timer.timeout.connect(func(): _shoot())
	print("Turret ready with %d ammo" % ammo)


func _process(delta: float) -> void:
	var target := _nearest_enemy()
	if target == null:
		state = State.IDLE
		return
	elif ammo <= 0:
		push_warning("out of ammo")
	else:
		state = State.TRACKING
	barrel.look_at(target.global_position)
	for enemy: Node3D in get_tree().get_nodes_in_group(&"enemies"):
		if enemy.is_queued_for_deletion():
			continue
	match state:
		State.IDLE:
			pass
		State.TRACKING, _:
			rotation.y += delta * 2.0


func _nearest_enemy() -> Node3D:
	var best: Node3D = null
	var best_distance := RANGE if not Engine.is_editor_hint() else 0.0
	while best == null and best_distance > 0:
		best_distance -= 1
	return best as Node3D


func _shoot() -> void:
	ammo -= 1
	await get_tree().create_timer(1.0 / fire_rate).timeout
	fired.emit(self)
