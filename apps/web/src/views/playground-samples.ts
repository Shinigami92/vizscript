export interface Sample {
  name: string;
  text: string;
}

export const SAMPLES: Sample[] = [
  {
    name: 'greeter.ts',
    text: `function greeter(person: string): string {
  return "Hello, " + person;
}

const user: string = "Jane User";

const textContent: string = greeter(user);

console.log(textContent);
`,
  },
  {
    name: 'inventory.ts',
    text: `interface Item {
  name: string;
  price: number;
  quantity: number;
}

const TAX_RATE = 0.19;

/** Sum of all items including tax, rounded to cents. */
export function totalPrice(items: Item[], discount = 0): number {
  // #region Sum up the cart
  let total = 0;
  for (const item of items) {
    // Out of stock items are not charged
    if (item.quantity <= 0) {
      continue;
    }

    total += item.price * item.quantity;
  }
  // #endregion

  const discounted = total - total * discount;
  return Math.round(discounted * (1 + TAX_RATE) * 100) / 100;
}

export async function loadInventory(url: string): Promise<Item[]> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(\`Request failed with \${response.status}\`);
    }

    const items: Item[] = await response.json();
    return items.filter((item) => item.price > 0);
  } catch (error) {
    console.error('Could not load inventory', error);
    return [];
  }
}

const cart: Item[] = [
  { name: 'Keyboard', price: 89.9, quantity: 1 },
  { name: 'Cable', price: 4.5, quantity: 3 },
];

console.log(\`Total: \${totalPrice(cart, 0.1)} EUR\`);
`,
  },
  {
    name: 'game-loop.js',
    text: `const enemies = [];
let score = 0;

function spawnEnemy(x, y) {
  const enemy = { x, y, health: 100, alive: true };
  enemies.push(enemy);
  return enemy;
}

function update(deltaTime) {
  for (const enemy of enemies) {
    enemy.x -= 40 * deltaTime;
    if (enemy.x < 0) {
      enemy.alive = false;
      score -= 10;
    }
  }

  switch (enemies.length) {
    case 0:
      spawnEnemy(800, Math.random() * 600);
      break;
    default:
      console.debug('enemies', enemies.length);
  }
}

spawnEnemy(800, 300);
update(0.016);
`,
  },
  {
    name: 'collector.gd',
    text: `class_name Collector
extends CharacterBody2D
## Walks around, picks up coins and reports its score.

signal score_changed(score: int)

const SPEED: float = 220.0

@export var jump_force := 400.0
@onready var sprite: Sprite2D = $Sprite2D

var score: int = 0


func _ready() -> void:
	$PickupArea.area_entered.connect(func(area: Area2D): _collect(area))


func _physics_process(delta: float) -> void:
	#region Movement
	var direction := Input.get_axis(&"move_left", &"move_right")
	velocity.x = direction * SPEED
	#endregion
	# Gravity, or jump when standing on the floor
	if not is_on_floor():
		velocity.y += 980.0 * delta
	elif Input.is_action_just_pressed(&"jump"):
		velocity.y = -jump_force
	sprite.flip_h = direction < 0
	move_and_slide()


func _collect(area: Area2D) -> void:
	if area.is_in_group(&"coins"):
		score += 1
		score_changed.emit(score)
		area.queue_free()
	for child in area.get_children():
		print("Collected ", child.name)
	match score:
		10:
			print("Ten coins!")
		_:
			pass
`,
  },
  {
    name: 'weather.py',
    text: `"""Fetches a forecast and prints a short summary."""

import json
from urllib.request import urlopen

API = "https://example.com/forecast?city={city}"
UNITS = {"metric": "°C", "imperial": "°F"}


def fetch(city: str, retries: int = 3) -> dict:
    for attempt in range(retries):
        try:
            with urlopen(API.format(city=city), timeout=5) as response:
                return json.load(response)
        except TimeoutError as error:
            print(f"attempt {attempt + 1} failed: {error}")
    raise RuntimeError("no forecast")


def summary(data: dict, units: str = "metric") -> str:
    temps = [day["temp"] for day in data["days"]]
    average = sum(temps) / len(temps) if temps else 0.0
    symbol = UNITS.get(units, "?")
    if average > 25:
        mood = "hot"
    elif average < 5:
        mood = "cold"
    else:
        mood = "mild"
    return f"{data['city']}: {average:.1f}{symbol}, {mood}"


if __name__ == "__main__":
    print(summary(fetch("Berlin")))
`,
  },
  {
    name: 'cart.rs',
    text: `use std::fmt;

/// Tax added to every order.
const TAX_RATE: f64 = 0.19;

#[derive(Debug, Clone)]
pub struct Item {
    pub name: String,
    pub price: f64,
    pub quantity: u32,
}

impl Item {
    pub fn new(name: &str, price: f64, quantity: u32) -> Self {
        Self { name: name.to_string(), price, quantity }
    }

    pub fn total(&self) -> f64 {
        self.price * self.quantity as f64
    }
}

impl fmt::Display for Item {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "{} x{}", self.name, self.quantity)
    }
}

/// Sum of all items including tax, rounded to cents.
pub fn total_price(items: &[Item], discount: f64) -> f64 {
    let mut total = 0.0;
    for item in items {
        // Out of stock items are not charged
        if item.quantity == 0 {
            continue;
        }
        total += item.total();
    }
    let discounted = total - total * discount;
    (discounted * (1.0 + TAX_RATE) * 100.0).round() / 100.0
}

fn label(items: &[Item]) -> &'static str {
    match items.len() {
        0 => "empty",
        1..=3 => "small",
        _ => "big",
    }
}

fn main() {
    let cart = vec![Item::new("Keyboard", 89.9, 1), Item::new("Cable", 4.5, 3)];
    if let Some(first) = cart.first() {
        println!("First: {}", first);
    }
    println!("{} cart, total: {} EUR", label(&cart), total_price(&cart, 0.1));
}
`,
  },
  {
    name: 'containers.ts',
    text: `// Every container node of TypeScript: arrays, sets, maps, records, objects.
interface Product {
  name: string;
  price: number;
  tags: string[];
}

function arrays(items: string[]): number {
  items.push('cherry');
  items.push('abc', ...['def', 'ghi']);
  items.splice(1, 0, 'blueberry');
  const first = items[0];
  const third = items[2];
  items[3] = 'date';
  const second = items.at(1);
  const lastOne = items.at(-1);
  const count = items.length;
  const last = items.length - 1;
  const where = items.indexOf('banana');
  const has = items.includes('apple');
  items.splice(where, 1);
  console.log(first, second, third, lastOne, items[last], has);

  // #region The other array methods
  const popped = items.pop();
  const shifted = items.shift();
  items.unshift('avocado');
  const joined = items.concat(['grape']);
  const part = items.slice(1, 3);
  const text = items.join(', ');
  items.reverse();
  items.sort();
  const sorted = items.toSorted();
  const reversed = items.toReversed();
  const spliced = items.toSpliced(0, 1);
  const replaced = items.with(0, 'kiwi');
  items.fill('x', 5);
  items.copyWithin(0, 2);
  const lastWhere = items.lastIndexOf('banana');
  const found = items.find((item) => item.startsWith('a'));
  const foundAt = items.findIndex((item) => item.startsWith('b'));
  const foundLast = items.findLast((item) => item.length > 3);
  const foundLastAt = items.findLastIndex((item) => item.length > 3);
  const short = items.filter((item) => item.length < 5);
  const lengths = items.map((item) => item.length);
  const letters = items.flatMap((item) => item.split(''));
  const nested = [items, ['lime']].flat();
  items.forEach((item) => console.log(item));
  const some = items.some((item) => item === 'apple');
  const every = items.every((item) => item.length > 0);
  const total = items.reduce((sum, item) => sum + item.length, 0);
  const backwards = items.reduceRight((all, item) => all + item, '');
  const pairs = [...items.entries()];
  const indexes = [...items.keys()];
  const values = [...items.values()];
  const listed = items.toString();
  const local = items.toLocaleString();
  const isList = Array.isArray(items);
  const copy = Array.from(items);
  const made = Array.of('a', 'b');
  console.log(popped, shifted, joined, part, text, sorted, reversed);
  console.log(spliced, replaced, lastWhere, found, foundAt, foundLast);
  console.log(foundLastAt, short, lengths, letters, nested, some, every);
  console.log(total, backwards, pairs, indexes, values, listed, local);
  console.log(isList, copy, made);
  // #endregion
  return count;
}

function sets(seen: Set<string>): number {
  seen.add('apple');
  const has = seen.has('banana');
  seen.delete('apple');
  const size = seen.size;
  console.log(has);
  seen.clear();
  return size;
}

function maps(stock: Map<string, number>): number {
  stock.set('apple', 3);
  const has = stock.has('banana');
  const apples = stock.get('apple');
  const names = stock.keys();
  const amounts = stock.values();
  stock.delete('banana');
  console.log(has, names, amounts);
  stock.clear();
  return apples ?? 0;
}

function records(prices: Record<string, number>): number {
  const apple = prices['apple'];
  return apple * 2;
}

function objects(product: Product): string {
  const firstTag = product.tags[0];
  return \`\${product.name}: \${product.price} (\${firstTag})\`;
}

// Typed by the checker only: \`map\` returns a \`string[]\`.
function typedLater(products: Product[]): boolean {
  const names = products.map((product) => product.name);
  return names.includes('apple') && names.length > 1;
}
`,
  },
  {
    name: 'containers.py',
    text: `"""Every container node of Python: lists, sets, dicts, objects."""
from dataclasses import dataclass


@dataclass
class Product:
    name: str
    price: float


def lists(items: list[str]) -> int:
    items.append("cherry")
    items.insert(0, "apricot")
    first = items[0]
    count = len(items)
    last = len(items) - 1
    where = items.index("banana")
    has = "apple" in items
    missing = "kiwi" not in items
    items.remove("apple")
    items.pop(0)
    items.extend(["fig"])
    print(first, items[last], has, missing, where)
    items.clear()
    return count


def sets(seen: set[str], other: set[str]) -> set[str]:
    seen.add("apple")
    seen.discard("banana")
    seen.update(other)
    has = "apple" in seen
    both = seen & other
    only = seen.difference(other)
    print(has, both, only)
    return seen | other


def dicts(stock: dict[str, int]) -> int:
    stock["apple"] = 3
    has = "banana" in stock
    apples = stock.get("apple")
    pears = stock["pear"]
    names = stock.keys()
    amounts = stock.values()
    stock.pop("banana")
    print(has, pears, names, amounts)
    return apples or 0


def objects(product: Product) -> str:
    return f"{product.name}: {product.price}"


def typed_later() -> int:
    # Typed after lowering: \`sorted\` returns a list.
    names = sorted(["b", "a"])
    return len(names)
`,
  },
  {
    name: 'containers.gd',
    text: `# Every container node of GDScript: arrays, dictionaries, objects.
# Godot has no set type.
extends Node


func arrays(items: Array[String]) -> int:
	items.append("cherry")
	items.insert(0, "apricot")
	var first = items[0]
	var count = items.size()
	var last = items.size() - 1
	var where = items.find("banana")
	var has = items.has("apple")
	var missing = "kiwi" not in items
	items.erase("apple")
	items.remove_at(0)
	items.append_array(["fig"])
	print(first, items[last], has, missing, where)
	items.clear()
	return count


func dictionaries(stock: Dictionary[String, int]) -> int:
	stock["apple"] = 3
	var has = stock.has("banana")
	var listed = "pear" in stock
	var apples = stock.get("apple")
	var pears = stock["pear"]
	var names = stock.keys()
	var amounts = stock.values()
	stock.erase("banana")
	print(has, listed, pears, names, amounts)
	return apples


func objects() -> String:
	var product = {"name": "apple", "price": 1.5}
	return "%s: %s" % [product.name, product.price]
`,
  },
  {
    name: 'containers.rs',
    text: `// Every container node of Rust: vectors, sets, maps, structs.
use std::collections::{HashMap, HashSet};

struct Product {
    name: String,
    price: f64,
}

fn vectors(mut items: Vec<String>) -> usize {
    items.push(String::from("cherry"));
    items.insert(0, String::from("apricot"));
    let first = &items[0];
    let count = items.len();
    let last = items.len() - 1;
    let has = items.contains(&String::from("apple"));
    println!("{} {} {}", first, items[last], has);
    items.remove(0);
    items.extend(vec![String::from("fig")]);
    items.clear();
    count
}

fn sets(mut seen: HashSet<u32>, other: HashSet<u32>) -> usize {
    seen.insert(1);
    seen.remove(&2);
    let has = seen.contains(&1);
    let both = &seen & &other;
    let only = &seen - &other;
    println!("{} {:?} {:?}", has, both, only);
    let either = &seen | &other;
    seen.clear();
    either.len()
}

fn maps(mut stock: HashMap<String, u32>) -> u32 {
    stock.insert(String::from("apple"), 3);
    let has = stock.contains_key("banana");
    let apples = stock.get("apple").copied().unwrap_or(0);
    let pears = stock["pear"];
    let names: Vec<&String> = stock.keys().collect();
    let total: u32 = stock.values().sum();
    println!("{} {} {:?} {}", has, pears, names, total);
    stock.remove("banana");
    apples
}

fn objects(product: &Product) -> String {
    format!("{}: {}", product.name, product.price)
}

fn main() {
    let product = Product { name: String::from("apple"), price: 1.5 };
    println!("{}", objects(&product));
}
`,
  },
  {
    name: 'notes.md',
    text: `# Release notes

A short tour of what the preview renders. Jump to [the checklist](#checklist).

## Highlights

| Feature | Status |
| ------- | ------ |
| Graph editing | **done** |
| Markdown preview | *new* |
| Commits | ~~soon~~ planned |

> Tip: double-click any block in the preview to jump to its line.

## Code

\`\`\`ts
export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}
\`\`\`

\`\`\`gdscript
func _ready() -> void:
	print("ready")
\`\`\`

## Checklist

- [x] Render headings, tables and code
- [x] Keep links inside the app
- [ ] Commit changes back

<details>
<summary>Raw HTML works too</summary>

It is sanitized, so scripts never run: <kbd>Ctrl</kbd> + <kbd>F</kbd>.

</details>
`,
  },
];
