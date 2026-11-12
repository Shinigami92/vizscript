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

console.log(greeter(user));
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
