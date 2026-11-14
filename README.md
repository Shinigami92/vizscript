# vizscript

Visualize source code as Unreal-Engine-Blueprint-style node graphs.

![A TypeScript function shown as a node graph above its code, with a comment box, a comment bubble and a For Each loop, next to the My Script and Details panels](docs/screenshot.png)

Open a repository and pick a script. vizscript shows it as a node graph with the code below it (or side by side, or just one of them), and keeps them in sync. The graph has two kinds of wires:

- **Exec wires** (white) show the order in which the code runs.
- **Data wires** (colored by type) connect values, such as variables, parameters and call results, to the inputs that use them.

Editing the graph edits the code: every change becomes a minimal text edit, so formatting and comments survive.

> Status: proof of concept. JavaScript/TypeScript, Python, GDScript (Godot 4) and Rust are supported. Committing changes back, more languages and more providers are planned (see [Roadmap](#roadmap)).

## Highlights

- **Blueprint concepts for any script.** Statements become nodes on the exec chain, expressions become pure nodes, and `if`, loops, `switch` and `try` become flow-control nodes. Every function gets its own graph; double-click one to see it on its own, like UE's graph tabs (double-clicking a call or a callback opens its graph too, like UE's function and collapsed graph nodes; the breadcrumb shows the graph a callback sits in, and _Jump to usage_ on a graph's entry node leads back to the callback node or each call), with a breadcrumb and back / forward (the link keeps it, `?fn=`). Nodes look like UE's: functions start with a purple entry node and events (the module's code, Godot callbacks and signal handlers) with a red one, headers carry ƒ, event, branch and loop icons, `await` gets the latent clock, variables are set with compact SET nodes, Get pills are dark capsules lit by their type's color with the name next to the pin, like UE's, operators show as one large symbol (`×`, `+`, `==`), and a method's own object shows as a `self` box on the Target pin instead of a wire.
- **Code and graph stay linked.** Hovering or selecting nodes highlights their code; moving the cursor in the editor highlights the matching node. Double-click a node to jump to its code.
- **Call nodes show the whole signature.** Calling a function of the file, or one imported from another file of the repository, shows one pin per parameter, named and typed like it; missing arguments are unconnected pins that fill in when you wire or type a value (in Python as `name=value`). Arguments left at their default fold behind a ▼ under the node, like UE's advanced pins. Calls of other functions get more pins with "Add argument pin", like UE's Add pin. Right-click a pin for UE's pin menu: remove an argument pin, reset an argument to its parameter's default (the last one is left out), promote an input or output to a variable (UE's Promote to Variable, also first in the menu after dragging off a pin; an empty input starts the variable with its type's default), or break one of its several links.
- **Use functions of other files.** The action menu also offers the functions and values exported by other files of the repository (nearest folders first). Picking one adds the node and writes the import in the file's own style (`import { a } from './x'`, `from x import a`, `const X = preload("res://x.gd")`), joined into an existing import of that file when there is one; one undo removes both.
- **Libraries too.** Python's common standard-library modules (`math`, `json`, `os.path`, `re`, …) and the npm packages a TypeScript file imports from get their signatures, so their calls get pins and the action menu offers their other functions (`math.sqrt` adds `import math`, `computed` joins `import { ref } from 'vue'`). npm types are read from the packages' `.d.ts` files on [jsDelivr](https://www.jsdelivr.com/), at the version in your `package.json`.
- **Godot classes.** A part of Godot 4's class reference is built in: dragging from a value of type `Area2D` offers its methods and properties with the inherited ones (`is_in_group`, `get_children`), the script's base class adds `move_and_slide()`, `velocity` and the like, and `Input`, `Engine`, `Time` and `OS` are there to call. Calls of these methods get named and typed pins.
- **Flow control from the action menu.** For Each, counting `for`, `while`, `switch` / `match`, `try` / `catch`, `throw`, `break` and `continue`, written in the language's own syntax (GDScript has no `try`, Rust has `match`, `loop` and `while let`).
- **Operators and values from the action menu.** Math, comparison, logic, joining text and values (text, numbers, lists, objects) in the language's own syntax. Drag a wire from a pin into empty space to use its value (`person` → **+** gives `person + undefined`), pick one for an input to fill it, or right-click empty space for a lone node; wire it on and type into its empty inputs (`Hello, ` becomes `"Hello, "`).
- **Edit in either view.** Switch an assignment between `=`, `+=`, `-=` … in Details, rewire pins (like UE, a message tells why a pin doesn't fit or that a wire gets replaced; wiring a number into a string input goes through UE's autocast — "Convert number to string" — and writes `String(x)` / `str(x)` / `x.to_string()`, drawn as a small conversion node), copy, cut, paste and duplicate nodes (as code, so code from anywhere can be pasted as nodes), collapse selected statements into a new function like UE's "Collapse to Function" (variables they read become its inputs, a variable used afterwards its result), move all wires of a pin with Ctrl/⌘-drag, wire a SET's output straight into other inputs like in UE (the code reads the variable there; a read in the very next node is drawn that way by itself), align and straighten nodes with UE's shortcuts, reorder statements, edit values inline (true / false as a checkbox), add nodes from a searchable action menu (right-click empty space for all actions, with UE's folded categories and _Add Comment…_, or drag a wire into empty space — "Place a new node." — and start typing; a **Context Sensitive** filter like Blueprint's hides functions and variables whose type doesn't fit the pin, and on empty space the names of other files and libraries; dragging from a value of a type of the file offers its fields and methods, like UE's "Target is …" actions (`item` → `.price`); every variable in scope gets a Get and a Set entry, like UE's "Get Velocity" / "Set Velocity"; categories fold, ★ pins favorites on top, and a function's signature and description show below the list; hold B, L or R and click empty space for a Branch, For Each loop or Return), delete nodes or just their wires. A node's right-click menu has UE's Cut, Copy, Paste, Find references (selects every Get / Set of the variable or call of the function), Replace variable / function (another variable for a Get or Set, another function for a call, the wires stay) and Break node links. Undo and redo cover both views.
- **Comments from the code.** A comment above a statement becomes a bubble over its node; a region (`// #region Title` in TypeScript, `#region` in GDScript, `# region` in Python, `// region: Title` in Rust) becomes a comment box around its nodes. Editing them in the graph rewrites the comment.
- **Graphs may be unfinished, like in UE.** Break an exec wire (Alt + click), wire a statement where the code can't follow yet, or drop a node where no code can go (it floats until you wire it in), and the graph keeps it: dashed wires, NOT IN CODE on the nodes that are cut off, and a warning that the graph is out of sync, so saving waits. As soon as the graph can be code again, the code follows in one edit (one undo); you can keep typing in the code meanwhile, and Discard drops the graph-only changes.
- **Problems like Compiler Results.** Nodes with an error or warning get a red **ERROR!** or yellow **WARNING!** banner, and a Problems panel lists them all (Shift + Ctrl/Cmd + M). TypeScript and JavaScript are type-checked; GDScript, Python and Rust report syntax errors.
- **Go to file and definition.** Ctrl/Cmd + click an import to open that file, or press `F12` on a node to jump to its definition, like in VS Code.
- **Local folders.** Open a project folder from your computer, without uploading anything. In Chrome and Edge, changes are saved back into the folder (⌘S / Ctrl+S) and the folder is remembered; other browsers open it read-only.
- **Shared layouts.** A file you open for the first time is laid out automatically. Once someone with write access to the repository rearranges it, the layout, including reroute points, is shared with everyone who opens the file on that branch. Everyone else keeps their own moves in their browser, on top of the shared layout.
- **My Script**, like UE's "My Blueprint": the file's functions, variables, local variables, types and signals with their types (in the language's own syntax). Select one to see its inputs, output and uses; double-click to show it in the graph; drag it into the graph for a call, or a Get / Set of a variable (⌘/Ctrl-drag gets, Alt-drag sets), like in UE. Add functions, variables, local variables, signals and types (an empty interface or class) with `+`, rename with F2 (its uses in the file are renamed too, following the language's scope rules) and delete them. Selecting a variable's Get or Set node in the graph shows the same variable details. Imports are listed by module, with the inputs and output of imported functions read from their files; double-click one to open its definition in the other file, drag it into the graph for a call or a Get, or delete it. Functions get UE's Inputs and Output (signals get Inputs, and their `emit` calls follow): add, rename, reorder and remove inputs, set their types and default values, and set the return type; calls in the same file get their arguments updated to match. In the Details panel (collapsible sections like UE's), rename a function or variable, edit its description (the doc comment above it: `/** */`, `##` in GDScript), pick a variable's type from the language's own types and Godot's classes (with Array / Map / Set and Optional, GDScript's `:=`, or any type typed by hand), edit its value with a field that fits the type (text is quoted for you; a field per axis for `Vector2` / `Vector3`, a color picker for `Color`, and the members of an enum or a literal union like `'small' | 'big'` to pick), and switch `const` / `let` / `var`, `export` or GDScript's `@export` / `@onready` / `static`. Functions and methods get their settings too: `export`, `async`, `static` and the access level of class members (`public` / `protected` / `private`). GDScript variables pick their export hint (`@export_range` with min / max / step fields, `@export_enum`, …, like UE's Slider Range), changed values and types get a reset ↶ back to the saved version (last commit, file on disk), TypeScript class fields can be exposed on spawn (moved into the constructor as `constructor(public speed = 10)`), a Category puts GDScript variables into export groups (`@export_group`, shown as folders in My Script), a Private switch renames to the `_name` convention in GDScript and Python, an eye in My Script exports a variable like UE's Instance Editable, comment boxes get a title and a color (kept in the layout, not in the code), and the Details panel has a search field and a lock that keeps it on the current selection. With nothing selected, Details shows the script's settings (GDScript's `@tool`, `class_name`, `extends`) and the default values of all variables, like UE's Class Settings and Class Defaults.
- **Tabs for open files**, like VS Code: preview tabs that the next file replaces, tabs that stay once you edit or double-click them, and each file keeps its unsaved changes, undo history and scroll position while you switch.
- **A workbench like VS Code's.** Explorer, My Script, Code, Graph, Details and Problems views can be moved, split, resized and hidden; preset layouts are one click away. Light and dark mode follow your system or your choice.
- **Links keep the view.** The graph's position and zoom are part of the URL, so a shared link shows exactly what you saw.
- **Smooth, but only if you want it.** The graph eases to its new view when you frame or zoom, nodes moved by an edit slide to their new place, new nodes fade in, and a ring marks the nodes you jump to, so you see what changed. Menus, dialogs and new entries in My Script get a short animation too. With reduced motion turned on in your system, everything jumps at once.
- **Markdown preview** with GitHub-flavoured Markdown, highlighted code blocks and links that open repository files inside vizscript.

## Try it

Run everything in containers, then open http://localhost:8080:

```sh
APP_SECRET=$(openssl rand -base64 48) docker compose up --build
```

- The **playground** (`/playground`) works without signing in and comes with samples in every supported language.
- **Local** opens a folder from your computer, also without signing in.
- **Public GitHub repositories** open without signing in too: type `owner/name` under Repositories. Your browser then talks to GitHub directly, which allows 60 requests per hour per IP address (files don't count, opening a repository or branch does). Node moves, recently opened repositories and unsaved changes are kept in your browser only.
- **Signing in** with a GitHub [fine-grained token](https://github.com/settings/personal-access-tokens/new) that has read access to _Contents_ and _Metadata_ lists your repositories, opens private ones, lifts the limit to GitHub's 5,000 requests per hour, and keeps your recent repositories and workbench layout on every device. On repositories you can push to, your layout changes are shared with everyone; elsewhere they stay in your browser.

To run it from source or to contribute, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Working with the graph

Press `?` in the app, or use the keyboard button in the top bar, to see all mouse and keyboard controls.

On phones the viewer is read-only: you can switch between code and graph, pan and pinch-zoom.

## Roadmap

- Commit graph edits back to the repository
- Sign-in through Keycloak with GitHub as identity provider
- GitLab provider
- More languages (C#, Go, C++, Ruby, …)
- Real type information for pins in all typed languages (e.g. through the TypeScript language service), and with it the members of types from libraries and other files in the action menu (`response.ok`, `response.json()`)
- Events in the action menu, like UE's "Add Event": GDScript callbacks (`_ready`, `_process`, `_input`) and signal handlers, overridable methods of a base class in TypeScript and Python
- Disable a node, like UE's Enabled State (the statement is commented out)
- Side-by-side editor groups (two files next to each other), with cross-file rename and find references
- Desktop app based on Tauri
- VS Code extension that shows the graph view inside VS Code

## Contributing

Contributions are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers the setup, architecture, scripts and how to verify a change.

## License

[MIT](LICENSE)
