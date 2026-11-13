/**
 * A part of Godot 4's class reference, as GDScript declarations: the
 * classes and members scripts use most. Each entry is a class, its base
 * class, and its members, one per line. `godot.ts` parses them like a
 * script, so they get the same symbols, types and pins as a file's own.
 */
export const GODOT_API: ReadonlyArray<
  readonly [name: string, base: string | undefined, members: string]
> = [
  [
    'Object',
    undefined,
    `
func get_class() -> String: pass
func set(property: StringName, value: Variant) -> void: pass
func get(property: StringName) -> Variant: pass
func has_method(method: StringName) -> bool: pass
func has_signal(name: StringName) -> bool: pass
func get_instance_id() -> int: pass
func set_meta(name: StringName, value: Variant) -> void: pass
func get_meta(name: StringName, default: Variant = null) -> Variant: pass
func has_meta(name: StringName) -> bool: pass
func free() -> void: pass
func is_queued_for_deletion() -> bool: pass
func notification(what: int, reversed: bool = false) -> void: pass
func call_deferred(method: StringName) -> Variant: pass
func set_deferred(property: StringName, value: Variant) -> void: pass
`,
  ],
  ['RefCounted', 'Object', ''],
  [
    'Resource',
    'RefCounted',
    `
signal changed
var resource_name: String
var resource_path: String
func duplicate(subresources: bool = false) -> Resource: pass
func emit_changed() -> void: pass
`,
  ],
  [
    'Node',
    'Object',
    `
signal ready
signal renamed
signal tree_entered
signal tree_exiting
signal tree_exited
signal child_entered_tree(node: Node)
signal child_exiting_tree(node: Node)
var name: StringName
var owner: Node
var process_mode: int
var unique_name_in_owner: bool
func add_child(node: Node, force_readable_name: bool = false, internal: int = 0) -> void: pass
func remove_child(node: Node) -> void: pass
func get_child(idx: int, include_internal: bool = false) -> Node: pass
func get_child_count(include_internal: bool = false) -> int: pass
func get_children(include_internal: bool = false) -> Array[Node]: pass
func get_node(path: NodePath) -> Node: pass
func get_node_or_null(path: NodePath) -> Node: pass
func has_node(path: NodePath) -> bool: pass
func find_child(pattern: String, recursive: bool = true, owned: bool = true) -> Node: pass
func find_children(pattern: String, type: String = "", recursive: bool = true, owned: bool = true) -> Array[Node]: pass
func get_parent() -> Node: pass
func get_path() -> NodePath: pass
func get_tree() -> SceneTree: pass
func get_viewport() -> Viewport: pass
func get_window() -> Window: pass
func get_index(include_internal: bool = false) -> int: pass
func is_inside_tree() -> bool: pass
func is_node_ready() -> bool: pass
func move_child(child_node: Node, to_index: int) -> void: pass
func reparent(new_parent: Node, keep_global_transform: bool = true) -> void: pass
func queue_free() -> void: pass
func duplicate(flags: int = 15) -> Node: pass
func add_to_group(group: StringName, persistent: bool = false) -> void: pass
func remove_from_group(group: StringName) -> void: pass
func is_in_group(group: StringName) -> bool: pass
func get_groups() -> Array[StringName]: pass
func set_process(enable: bool) -> void: pass
func set_physics_process(enable: bool) -> void: pass
func set_process_input(enable: bool) -> void: pass
func set_process_unhandled_input(enable: bool) -> void: pass
func is_processing() -> bool: pass
func is_physics_processing() -> bool: pass
func get_process_delta_time() -> float: pass
func get_physics_process_delta_time() -> float: pass
func create_tween() -> Tween: pass
func print_tree_pretty() -> void: pass
`,
  ],
  [
    'CanvasItem',
    'Node',
    `
signal draw
signal visibility_changed
signal hidden
var visible: bool
var modulate: Color
var self_modulate: Color
var show_behind_parent: bool
var top_level: bool
var z_index: int
var z_as_relative: bool
var y_sort_enabled: bool
var material: Material
func show() -> void: pass
func hide() -> void: pass
func is_visible_in_tree() -> bool: pass
func queue_redraw() -> void: pass
func get_global_mouse_position() -> Vector2: pass
func get_local_mouse_position() -> Vector2: pass
func get_global_transform() -> Transform2D: pass
func get_viewport_rect() -> Rect2: pass
func draw_line(from: Vector2, to: Vector2, color: Color, width: float = -1.0, antialiased: bool = false) -> void: pass
func draw_rect(rect: Rect2, color: Color, filled: bool = true, width: float = -1.0, antialiased: bool = false) -> void: pass
func draw_circle(position: Vector2, radius: float, color: Color, filled: bool = true, width: float = -1.0, antialiased: bool = false) -> void: pass
func draw_texture(texture: Texture2D, position: Vector2, modulate: Color = Color(1, 1, 1, 1)) -> void: pass
`,
  ],
  [
    'Node2D',
    'CanvasItem',
    `
var position: Vector2
var rotation: float
var rotation_degrees: float
var scale: Vector2
var skew: float
var global_position: Vector2
var global_rotation: float
var global_rotation_degrees: float
var global_scale: Vector2
var transform: Transform2D
var global_transform: Transform2D
func rotate(radians: float) -> void: pass
func translate(offset: Vector2) -> void: pass
func global_translate(offset: Vector2) -> void: pass
func move_local_x(delta: float, scaled: bool = false) -> void: pass
func move_local_y(delta: float, scaled: bool = false) -> void: pass
func look_at(point: Vector2) -> void: pass
func get_angle_to(point: Vector2) -> float: pass
func to_local(global_point: Vector2) -> Vector2: pass
func to_global(local_point: Vector2) -> Vector2: pass
func apply_scale(ratio: Vector2) -> void: pass
`,
  ],
  [
    'CollisionObject2D',
    'Node2D',
    `
signal input_event(viewport: Node, event: InputEvent, shape_idx: int)
signal mouse_entered
signal mouse_exited
var collision_layer: int
var collision_mask: int
var input_pickable: bool
func set_collision_layer_value(layer_number: int, value: bool) -> void: pass
func get_collision_layer_value(layer_number: int) -> bool: pass
func set_collision_mask_value(layer_number: int, value: bool) -> void: pass
func get_collision_mask_value(layer_number: int) -> bool: pass
`,
  ],
  [
    'Area2D',
    'CollisionObject2D',
    `
signal area_entered(area: Area2D)
signal area_exited(area: Area2D)
signal body_entered(body: Node2D)
signal body_exited(body: Node2D)
var monitoring: bool
var monitorable: bool
var priority: int
var gravity: float
func get_overlapping_areas() -> Array[Area2D]: pass
func get_overlapping_bodies() -> Array[Node2D]: pass
func has_overlapping_areas() -> bool: pass
func has_overlapping_bodies() -> bool: pass
func overlaps_area(area: Node) -> bool: pass
func overlaps_body(body: Node) -> bool: pass
`,
  ],
  [
    'PhysicsBody2D',
    'CollisionObject2D',
    `
func move_and_collide(motion: Vector2, test_only: bool = false, safe_margin: float = 0.08, recovery_as_collision: bool = false) -> KinematicCollision2D: pass
func test_move(from: Transform2D, motion: Vector2, collision: KinematicCollision2D = null, safe_margin: float = 0.08, recovery_as_collision: bool = false) -> bool: pass
func add_collision_exception_with(body: Node) -> void: pass
func remove_collision_exception_with(body: Node) -> void: pass
func get_gravity() -> Vector2: pass
`,
  ],
  [
    'StaticBody2D',
    'PhysicsBody2D',
    `
var constant_linear_velocity: Vector2
var constant_angular_velocity: float
`,
  ],
  [
    'CharacterBody2D',
    'PhysicsBody2D',
    `
var velocity: Vector2
var motion_mode: int
var up_direction: Vector2
var floor_max_angle: float
var floor_snap_length: float
var floor_stop_on_slope: bool
var max_slides: int
var slide_on_ceiling: bool
func move_and_slide() -> bool: pass
func is_on_floor() -> bool: pass
func is_on_floor_only() -> bool: pass
func is_on_wall() -> bool: pass
func is_on_wall_only() -> bool: pass
func is_on_ceiling() -> bool: pass
func is_on_ceiling_only() -> bool: pass
func get_floor_normal() -> Vector2: pass
func get_wall_normal() -> Vector2: pass
func get_floor_angle(up_direction: Vector2 = Vector2(0, -1)) -> float: pass
func get_last_motion() -> Vector2: pass
func get_position_delta() -> Vector2: pass
func get_real_velocity() -> Vector2: pass
func get_platform_velocity() -> Vector2: pass
func get_slide_collision_count() -> int: pass
func get_slide_collision(slide_idx: int) -> KinematicCollision2D: pass
func get_last_slide_collision() -> KinematicCollision2D: pass
func apply_floor_snap() -> void: pass
`,
  ],
  [
    'RigidBody2D',
    'PhysicsBody2D',
    `
signal body_entered(body: Node)
signal body_exited(body: Node)
signal sleeping_state_changed
var mass: float
var gravity_scale: float
var linear_velocity: Vector2
var angular_velocity: float
var linear_damp: float
var angular_damp: float
var freeze: bool
var sleeping: bool
var lock_rotation: bool
var contact_monitor: bool
var max_contacts_reported: int
func apply_central_impulse(impulse: Vector2 = Vector2(0, 0)) -> void: pass
func apply_impulse(impulse: Vector2, position: Vector2 = Vector2(0, 0)) -> void: pass
func apply_torque_impulse(torque: float) -> void: pass
func apply_central_force(force: Vector2) -> void: pass
func apply_force(force: Vector2, position: Vector2 = Vector2(0, 0)) -> void: pass
func apply_torque(torque: float) -> void: pass
func get_colliding_bodies() -> Array[Node2D]: pass
func get_contact_count() -> int: pass
`,
  ],
  [
    'Sprite2D',
    'Node2D',
    `
signal frame_changed
signal texture_changed
var texture: Texture2D
var centered: bool
var offset: Vector2
var flip_h: bool
var flip_v: bool
var hframes: int
var vframes: int
var frame: int
var frame_coords: Vector2i
var region_enabled: bool
var region_rect: Rect2
func get_rect() -> Rect2: pass
func is_pixel_opaque(pos: Vector2) -> bool: pass
`,
  ],
  [
    'AnimatedSprite2D',
    'Node2D',
    `
signal animation_finished
signal animation_looped
signal animation_changed
signal frame_changed
var sprite_frames: SpriteFrames
var animation: StringName
var autoplay: String
var frame: int
var frame_progress: float
var speed_scale: float
var centered: bool
var offset: Vector2
var flip_h: bool
var flip_v: bool
func play(name: StringName = &"", custom_speed: float = 1.0, from_end: bool = false) -> void: pass
func play_backwards(name: StringName = &"") -> void: pass
func pause() -> void: pass
func stop() -> void: pass
func is_playing() -> bool: pass
`,
  ],
  [
    'CollisionShape2D',
    'Node2D',
    `
var shape: Shape2D
var disabled: bool
var one_way_collision: bool
var debug_color: Color
`,
  ],
  [
    'Camera2D',
    'Node2D',
    `
var offset: Vector2
var zoom: Vector2
var enabled: bool
var ignore_rotation: bool
var limit_left: int
var limit_top: int
var limit_right: int
var limit_bottom: int
var position_smoothing_enabled: bool
var position_smoothing_speed: float
func make_current() -> void: pass
func is_current() -> bool: pass
func get_screen_center_position() -> Vector2: pass
func force_update_scroll() -> void: pass
func reset_smoothing() -> void: pass
`,
  ],
  ['Marker2D', 'Node2D', 'var gizmo_extents: float'],
  [
    'Timer',
    'Node',
    `
signal timeout
var wait_time: float
var one_shot: bool
var autostart: bool
var paused: bool
var time_left: float
func start(time_sec: float = -1) -> void: pass
func stop() -> void: pass
func is_stopped() -> bool: pass
`,
  ],
  [
    'AnimationPlayer',
    'Node',
    `
signal animation_finished(anim_name: StringName)
signal animation_started(anim_name: StringName)
signal current_animation_changed(name: String)
var current_animation: String
var autoplay: String
var speed_scale: float
func play(name: StringName = &"", custom_blend: float = -1, custom_speed: float = 1.0, from_end: bool = false) -> void: pass
func play_backwards(name: StringName = &"", custom_blend: float = -1) -> void: pass
func pause() -> void: pass
func stop(keep_state: bool = false) -> void: pass
func queue(name: StringName) -> void: pass
func is_playing() -> bool: pass
func has_animation(name: StringName) -> bool: pass
func seek(seconds: float, update: bool = false, update_only: bool = false) -> void: pass
func get_current_animation_position() -> float: pass
`,
  ],
  [
    'AudioStreamPlayer',
    'Node',
    `
signal finished
var stream: AudioStream
var volume_db: float
var pitch_scale: float
var playing: bool
var autoplay: bool
var bus: StringName
func play(from_position: float = 0.0) -> void: pass
func stop() -> void: pass
func seek(to_position: float) -> void: pass
func get_playback_position() -> float: pass
`,
  ],
  [
    'AudioStreamPlayer2D',
    'Node2D',
    `
signal finished
var stream: AudioStream
var volume_db: float
var pitch_scale: float
var playing: bool
var autoplay: bool
var max_distance: float
func play(from_position: float = 0.0) -> void: pass
func stop() -> void: pass
`,
  ],
  [
    'Control',
    'CanvasItem',
    `
signal resized
signal gui_input(event: InputEvent)
signal mouse_entered
signal mouse_exited
signal focus_entered
signal focus_exited
var position: Vector2
var size: Vector2
var global_position: Vector2
var scale: Vector2
var rotation: float
var pivot_offset: Vector2
var custom_minimum_size: Vector2
var mouse_filter: int
var focus_mode: int
var tooltip_text: String
var size_flags_horizontal: int
var size_flags_vertical: int
func grab_focus() -> void: pass
func release_focus() -> void: pass
func has_focus() -> bool: pass
func get_rect() -> Rect2: pass
func get_global_rect() -> Rect2: pass
func set_anchors_preset(preset: int, keep_offsets: bool = false) -> void: pass
func accept_event() -> void: pass
`,
  ],
  [
    'Label',
    'Control',
    `
var text: String
var horizontal_alignment: int
var vertical_alignment: int
var autowrap_mode: int
var visible_characters: int
var visible_ratio: float
var uppercase: bool
func get_line_count() -> int: pass
`,
  ],
  [
    'BaseButton',
    'Control',
    `
signal pressed
signal button_down
signal button_up
signal toggled(toggled_on: bool)
var disabled: bool
var toggle_mode: bool
var button_pressed: bool
func is_hovered() -> bool: pass
`,
  ],
  [
    'Button',
    'BaseButton',
    `
var text: String
var icon: Texture2D
var flat: bool
`,
  ],
  [
    'Range',
    'Control',
    `
signal value_changed(value: float)
var value: float
var min_value: float
var max_value: float
var step: float
var ratio: float
`,
  ],
  ['ProgressBar', 'Range', 'var show_percentage: bool'],
  [
    'TextureRect',
    'Control',
    `
var texture: Texture2D
var stretch_mode: int
var flip_h: bool
var flip_v: bool
`,
  ],
  [
    'LineEdit',
    'Control',
    `
signal text_changed(new_text: String)
signal text_submitted(new_text: String)
var text: String
var placeholder_text: String
var editable: bool
func clear() -> void: pass
func select_all() -> void: pass
`,
  ],
  [
    'Node3D',
    'Node',
    `
signal visibility_changed
var position: Vector3
var rotation: Vector3
var rotation_degrees: Vector3
var scale: Vector3
var global_position: Vector3
var global_rotation: Vector3
var transform: Transform3D
var global_transform: Transform3D
var basis: Basis
var visible: bool
func show() -> void: pass
func hide() -> void: pass
func rotate(axis: Vector3, angle: float) -> void: pass
func rotate_x(angle: float) -> void: pass
func rotate_y(angle: float) -> void: pass
func rotate_z(angle: float) -> void: pass
func translate(offset: Vector3) -> void: pass
func look_at(target: Vector3, up: Vector3 = Vector3(0, 1, 0), use_model_front: bool = false) -> void: pass
func to_local(global_point: Vector3) -> Vector3: pass
func to_global(local_point: Vector3) -> Vector3: pass
`,
  ],
  [
    'CollisionObject3D',
    'Node3D',
    `
signal mouse_entered
signal mouse_exited
var collision_layer: int
var collision_mask: int
`,
  ],
  [
    'Area3D',
    'CollisionObject3D',
    `
signal area_entered(area: Area3D)
signal area_exited(area: Area3D)
signal body_entered(body: Node3D)
signal body_exited(body: Node3D)
var monitoring: bool
var monitorable: bool
func get_overlapping_areas() -> Array[Area3D]: pass
func get_overlapping_bodies() -> Array[Node3D]: pass
func has_overlapping_bodies() -> bool: pass
`,
  ],
  [
    'PhysicsBody3D',
    'CollisionObject3D',
    `
func move_and_collide(motion: Vector3, test_only: bool = false, safe_margin: float = 0.001, recovery_as_collision: bool = false, max_collisions: int = 1) -> KinematicCollision3D: pass
`,
  ],
  ['StaticBody3D', 'PhysicsBody3D', ''],
  [
    'CharacterBody3D',
    'PhysicsBody3D',
    `
var velocity: Vector3
var up_direction: Vector3
var floor_max_angle: float
func move_and_slide() -> bool: pass
func is_on_floor() -> bool: pass
func is_on_wall() -> bool: pass
func is_on_ceiling() -> bool: pass
func get_floor_normal() -> Vector3: pass
func get_wall_normal() -> Vector3: pass
func get_real_velocity() -> Vector3: pass
func get_slide_collision_count() -> int: pass
func get_last_slide_collision() -> KinematicCollision3D: pass
`,
  ],
  [
    'RigidBody3D',
    'PhysicsBody3D',
    `
signal body_entered(body: Node)
signal body_exited(body: Node)
var mass: float
var gravity_scale: float
var linear_velocity: Vector3
var angular_velocity: Vector3
var freeze: bool
func apply_central_impulse(impulse: Vector3) -> void: pass
func apply_impulse(impulse: Vector3, position: Vector3 = Vector3(0, 0, 0)) -> void: pass
func apply_central_force(force: Vector3) -> void: pass
func apply_force(force: Vector3, position: Vector3 = Vector3(0, 0, 0)) -> void: pass
func apply_torque(torque: Vector3) -> void: pass
func apply_torque_impulse(impulse: Vector3) -> void: pass
`,
  ],
  [
    'Camera3D',
    'Node3D',
    `
var fov: float
var current: bool
var near: float
var far: float
func make_current() -> void: pass
func is_current() -> bool: pass
func project_ray_origin(screen_point: Vector2) -> Vector3: pass
func project_ray_normal(screen_point: Vector2) -> Vector3: pass
func unproject_position(world_point: Vector3) -> Vector2: pass
`,
  ],
  [
    'MeshInstance3D',
    'Node3D',
    `
var mesh: Mesh
func get_surface_override_material(surface: int) -> Material: pass
func set_surface_override_material(surface: int, material: Material) -> void: pass
`,
  ],
  [
    'Tween',
    'RefCounted',
    `
signal finished
signal loop_finished(loop_count: int)
signal step_finished(idx: int)
func tween_property(object: Object, property: NodePath, final_val: Variant, duration: float) -> PropertyTweener: pass
func tween_interval(time: float) -> IntervalTweener: pass
func tween_callback(callback: Callable) -> CallbackTweener: pass
func tween_method(method: Callable, from: Variant, to: Variant, duration: float) -> MethodTweener: pass
func set_parallel(parallel: bool = true) -> Tween: pass
func set_loops(loops: int = 0) -> Tween: pass
func set_ease(ease: int) -> Tween: pass
func set_trans(trans: int) -> Tween: pass
func parallel() -> Tween: pass
func chain() -> Tween: pass
func kill() -> void: pass
func pause() -> void: pass
func play() -> void: pass
func stop() -> void: pass
func is_running() -> bool: pass
func is_valid() -> bool: pass
`,
  ],
  [
    'SceneTree',
    'Object',
    `
signal process_frame
signal physics_frame
signal node_added(node: Node)
signal node_removed(node: Node)
var paused: bool
var current_scene: Node
var root: Window
func change_scene_to_file(path: String) -> int: pass
func change_scene_to_packed(packed_scene: PackedScene) -> int: pass
func reload_current_scene() -> int: pass
func quit(exit_code: int = 0) -> void: pass
func create_timer(time_sec: float, process_always: bool = true, process_in_physics: bool = false, ignore_time_scale: bool = false) -> SceneTreeTimer: pass
func create_tween() -> Tween: pass
func get_nodes_in_group(group: StringName) -> Array[Node]: pass
func get_first_node_in_group(group: StringName) -> Node: pass
func call_group(group: StringName, method: StringName) -> void: pass
func get_node_count() -> int: pass
func get_frame() -> int: pass
`,
  ],
  [
    'SceneTreeTimer',
    'RefCounted',
    `
signal timeout
var time_left: float
`,
  ],
  [
    'PackedScene',
    'Resource',
    `
func instantiate(edit_state: int = 0) -> Node: pass
func can_instantiate() -> bool: pass
`,
  ],
  [
    'Texture2D',
    'Resource',
    `
func get_width() -> int: pass
func get_height() -> int: pass
func get_size() -> Vector2: pass
`,
  ],
  [
    'InputEvent',
    'Resource',
    `
func is_action(action: StringName, exact_match: bool = false) -> bool: pass
func is_action_pressed(action: StringName, allow_echo: bool = false, exact_match: bool = false) -> bool: pass
func is_action_released(action: StringName, exact_match: bool = false) -> bool: pass
func is_pressed() -> bool: pass
func is_released() -> bool: pass
func is_echo() -> bool: pass
func get_action_strength(action: StringName, exact_match: bool = false) -> float: pass
`,
  ],
  [
    'KinematicCollision2D',
    'RefCounted',
    `
func get_collider() -> Object: pass
func get_normal() -> Vector2: pass
func get_position() -> Vector2: pass
func get_travel() -> Vector2: pass
func get_remainder() -> Vector2: pass
func get_collider_velocity() -> Vector2: pass
func get_angle(up_direction: Vector2 = Vector2(0, -1)) -> float: pass
`,
  ],
  [
    'Viewport',
    'Node',
    `
func get_visible_rect() -> Rect2: pass
func get_mouse_position() -> Vector2: pass
func get_camera_2d() -> Camera2D: pass
func get_camera_3d() -> Camera3D: pass
func set_input_as_handled() -> void: pass
`,
  ],
  [
    'Window',
    'Viewport',
    `
signal close_requested
var title: String
var size: Vector2i
`,
  ],
];

/** Global objects of Godot (singletons): called on their name. */
export const GODOT_SINGLETONS: ReadonlyArray<readonly [string, string]> = [
  [
    'Input',
    `
func is_action_pressed(action: StringName, exact_match: bool = false) -> bool: pass
func is_action_just_pressed(action: StringName, exact_match: bool = false) -> bool: pass
func is_action_just_released(action: StringName, exact_match: bool = false) -> bool: pass
func get_action_strength(action: StringName, exact_match: bool = false) -> float: pass
func get_axis(negative_action: StringName, positive_action: StringName) -> float: pass
func get_vector(negative_x: StringName, positive_x: StringName, negative_y: StringName, positive_y: StringName, deadzone: float = -1.0) -> Vector2: pass
func is_key_pressed(keycode: int) -> bool: pass
func is_mouse_button_pressed(button: int) -> bool: pass
func get_last_mouse_velocity() -> Vector2: pass
func set_mouse_mode(mode: int) -> void: pass
func action_press(action: StringName, strength: float = 1.0) -> void: pass
func action_release(action: StringName) -> void: pass
`,
  ],
  [
    'Engine',
    `
var time_scale: float
var physics_ticks_per_second: int
func get_frames_per_second() -> float: pass
func is_editor_hint() -> bool: pass
func get_physics_frames() -> int: pass
`,
  ],
  [
    'Time',
    `
func get_ticks_msec() -> int: pass
func get_ticks_usec() -> int: pass
func get_unix_time_from_system() -> float: pass
func get_datetime_string_from_system(utc: bool = false, use_space: bool = false) -> String: pass
`,
  ],
  [
    'OS',
    `
func get_name() -> String: pass
func has_feature(tag_name: String) -> bool: pass
func get_environment(variable: String) -> String: pass
func shell_open(uri: String) -> int: pass
`,
  ],
  [
    'ResourceLoader',
    `
func load(path: String, type_hint: String = "", cache_mode: int = 1) -> Resource: pass
func exists(path: String, type_hint: String = "") -> bool: pass
`,
  ],
];
