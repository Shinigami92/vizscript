/**
 * Godot's built-in value types (`Vector2`, `String`, `Array` …) and global
 * functions, as GDScript declarations like `godot-api.ts`: what the type
 * lookup needs to follow values through scripts (`velocity.x` is a
 * `float`, `print()` returns nothing).
 */
export const GODOT_BUILTINS: ReadonlyArray<
  readonly [name: string, members: string]
> = [
  [
    'Vector2',
    `
const ZERO: Vector2 = Vector2(0, 0)
const ONE: Vector2 = Vector2(1, 1)
const UP: Vector2 = Vector2(0, -1)
const DOWN: Vector2 = Vector2(0, 1)
const LEFT: Vector2 = Vector2(-1, 0)
const RIGHT: Vector2 = Vector2(1, 0)
var x: float
var y: float
func abs() -> Vector2: pass
func angle() -> float: pass
func angle_to(to: Vector2) -> float: pass
func angle_to_point(to: Vector2) -> float: pass
func clamp(min: Vector2, max: Vector2) -> Vector2: pass
func direction_to(to: Vector2) -> Vector2: pass
func distance_squared_to(to: Vector2) -> float: pass
func distance_to(to: Vector2) -> float: pass
func dot(with: Vector2) -> float: pass
func is_zero_approx() -> bool: pass
func length() -> float: pass
func length_squared() -> float: pass
func lerp(to: Vector2, weight: float) -> Vector2: pass
func limit_length(length: float = 1.0) -> Vector2: pass
func move_toward(to: Vector2, delta: float) -> Vector2: pass
func normalized() -> Vector2: pass
func rotated(angle: float) -> Vector2: pass
func round() -> Vector2: pass
func floor() -> Vector2: pass
`,
  ],
  [
    'Vector2i',
    `
const ZERO: Vector2i = Vector2i(0, 0)
const ONE: Vector2i = Vector2i(1, 1)
var x: int
var y: int
func abs() -> Vector2i: pass
func length() -> float: pass
`,
  ],
  [
    'Vector3',
    `
const ZERO: Vector3 = Vector3(0, 0, 0)
const ONE: Vector3 = Vector3(1, 1, 1)
const UP: Vector3 = Vector3(0, 1, 0)
const DOWN: Vector3 = Vector3(0, -1, 0)
const FORWARD: Vector3 = Vector3(0, 0, -1)
const BACK: Vector3 = Vector3(0, 0, 1)
var x: float
var y: float
var z: float
func abs() -> Vector3: pass
func cross(with: Vector3) -> Vector3: pass
func direction_to(to: Vector3) -> Vector3: pass
func distance_to(to: Vector3) -> float: pass
func dot(with: Vector3) -> float: pass
func length() -> float: pass
func lerp(to: Vector3, weight: float) -> Vector3: pass
func move_toward(to: Vector3, delta: float) -> Vector3: pass
func normalized() -> Vector3: pass
func rotated(axis: Vector3, angle: float) -> Vector3: pass
`,
  ],
  [
    'Vector3i',
    `
const ZERO: Vector3i = Vector3i(0, 0, 0)
var x: int
var y: int
var z: int
`,
  ],
  [
    'Color',
    `
const WHITE: Color = Color(1, 1, 1)
const BLACK: Color = Color(0, 0, 0)
const RED: Color = Color(1, 0, 0)
const GREEN: Color = Color(0, 1, 0)
const BLUE: Color = Color(0, 0, 1)
const TRANSPARENT: Color = Color(1, 1, 1, 0)
var r: float
var g: float
var b: float
var a: float
func darkened(amount: float) -> Color: pass
func lightened(amount: float) -> Color: pass
func lerp(to: Color, weight: float) -> Color: pass
func to_html(with_alpha: bool = true) -> String: pass
`,
  ],
  [
    'Rect2',
    `
var position: Vector2
var size: Vector2
var end: Vector2
func get_center() -> Vector2: pass
func has_point(point: Vector2) -> bool: pass
func intersects(b: Rect2) -> bool: pass
`,
  ],
  [
    'String',
    `
func begins_with(text: String) -> bool: pass
func ends_with(text: String) -> bool: pass
func contains(what: String) -> bool: pass
func find(what: String, from: int = 0) -> int: pass
func format(values: Variant, placeholder: String = "{_}") -> String: pass
func is_empty() -> bool: pass
func length() -> int: pass
func left(length: int) -> String: pass
func right(length: int) -> String: pass
func substr(from: int, len: int = -1) -> String: pass
func replace(what: String, forwhat: String) -> String: pass
func split(delimiter: String = "", allow_empty: bool = true, maxsplit: int = 0) -> PackedStringArray: pass
func strip_edges(left: bool = true, right: bool = true) -> String: pass
func to_lower() -> String: pass
func to_upper() -> String: pass
func to_int() -> int: pass
func to_float() -> float: pass
func is_valid_int() -> bool: pass
func is_valid_float() -> bool: pass
`,
  ],
  [
    'Array',
    `
func append(value: Variant) -> void: pass
func append_array(array: Array) -> void: pass
func clear() -> void: pass
func duplicate(deep: bool = false) -> Array: pass
func erase(value: Variant) -> void: pass
func find(what: Variant, from: int = 0) -> int: pass
func has(value: Variant) -> bool: pass
func insert(position: int, value: Variant) -> int: pass
func is_empty() -> bool: pass
func push_back(value: Variant) -> void: pass
func push_front(value: Variant) -> void: pass
func remove_at(position: int) -> void: pass
func reverse() -> void: pass
func shuffle() -> void: pass
func size() -> int: pass
func sort() -> void: pass
func back() -> Variant: pass
func front() -> Variant: pass
func pick_random() -> Variant: pass
func pop_back() -> Variant: pass
func pop_front() -> Variant: pass
func pop_at(position: int) -> Variant: pass
func max() -> Variant: pass
func min() -> Variant: pass
`,
  ],
  [
    'Dictionary',
    `
func clear() -> void: pass
func duplicate(deep: bool = false) -> Dictionary: pass
func erase(key: Variant) -> bool: pass
func get(key: Variant, default: Variant = null) -> Variant: pass
func has(key: Variant) -> bool: pass
func is_empty() -> bool: pass
func keys() -> Array: pass
func values() -> Array: pass
func size() -> int: pass
func merge(dictionary: Dictionary, overwrite: bool = false) -> void: pass
`,
  ],
  [
    'Signal',
    `
func connect(callable: Callable, flags: int = 0) -> int: pass
func disconnect(callable: Callable) -> void: pass
func emit() -> void: pass
func is_connected(callable: Callable) -> bool: pass
`,
  ],
  [
    'Callable',
    `
func call() -> Variant: pass
func call_deferred() -> void: pass
func bind() -> Callable: pass
func is_valid() -> bool: pass
`,
  ],
];

/**
 * Godot's global functions (`@GlobalScope`, `@GDScript`). Functions whose
 * result follows their arguments (`abs`, `min`, `lerp`) are typed by the
 * lookup itself.
 */
export const GODOT_GLOBALS = `
func print(value: Variant) -> void: pass
func prints(value: Variant) -> void: pass
func printt(value: Variant) -> void: pass
func printerr(value: Variant) -> void: pass
func print_rich(value: Variant) -> void: pass
func push_error(value: Variant) -> void: pass
func push_warning(value: Variant) -> void: pass
func str(value: Variant) -> String: pass
func len(value: Variant) -> int: pass
func range(end: int) -> Array[int]: pass
func randi() -> int: pass
func randf() -> float: pass
func randi_range(from: int, to: int) -> int: pass
func randf_range(from: float, to: float) -> float: pass
func randomize() -> void: pass
func clampi(value: int, min: int, max: int) -> int: pass
func clampf(value: float, min: float, max: float) -> float: pass
func absi(x: int) -> int: pass
func absf(x: float) -> float: pass
func mini(a: int, b: int) -> int: pass
func maxi(a: int, b: int) -> int: pass
func minf(a: float, b: float) -> float: pass
func maxf(a: float, b: float) -> float: pass
func lerpf(from: float, to: float, weight: float) -> float: pass
func signi(x: int) -> int: pass
func signf(x: float) -> float: pass
func round(x: float) -> float: pass
func roundi(x: float) -> int: pass
func floor(x: float) -> float: pass
func floori(x: float) -> int: pass
func ceil(x: float) -> float: pass
func ceili(x: float) -> int: pass
func sqrt(x: float) -> float: pass
func pow(base: float, exp: float) -> float: pass
func sin(angle: float) -> float: pass
func cos(angle: float) -> float: pass
func tan(angle: float) -> float: pass
func atan2(y: float, x: float) -> float: pass
func deg_to_rad(deg: float) -> float: pass
func rad_to_deg(rad: float) -> float: pass
func fmod(x: float, y: float) -> float: pass
func posmod(x: int, y: int) -> int: pass
func move_toward(from: float, to: float, delta: float) -> float: pass
func inverse_lerp(from: float, to: float, weight: float) -> float: pass
func remap(value: float, istart: float, istop: float, ostart: float, ostop: float) -> float: pass
func is_equal_approx(a: float, b: float) -> bool: pass
func is_zero_approx(x: float) -> bool: pass
func is_instance_valid(instance: Variant) -> bool: pass
func typeof(variable: Variant) -> int: pass
func type_string(type: int) -> String: pass
func var_to_str(variable: Variant) -> String: pass
func hash(variable: Variant) -> int: pass
func instance_from_id(id: int) -> Object: pass
func load(path: String) -> Resource: pass
func preload(path: String) -> Resource: pass
func get_stack() -> Array: pass
`;
