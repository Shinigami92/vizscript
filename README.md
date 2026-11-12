# vizscript

Visualize source code as Unreal-Engine-Blueprint-style node graphs.

![A TypeScript function shown as a node graph above its code, with a comment box, comment bubbles and a For Each loop](docs/screenshot.png)

Open a repository and pick a script. vizscript shows it as code, as a node graph, or both side by side, and keeps them in sync. The graph has two kinds of wires:

- **Exec wires** (white) show the order in which the code runs.
- **Data wires** (colored by type) connect values, such as variables, parameters and call results, to the inputs that use them.

Editing the graph edits the code: every change becomes a minimal text edit, so formatting and comments survive.

> Status: proof of concept. JavaScript/TypeScript, Python and GDScript (Godot 4) are supported. Committing changes back, more languages and more providers are planned (see [Roadmap](#roadmap)).

## Highlights

- **Blueprint concepts for any script.** Statements become nodes on the exec chain, expressions become pure nodes, and `if`, loops, `switch` and `try` become flow-control nodes. Every function gets its own graph. Nodes look like UE's: functions start with a purple entry node and events (the module's code, Godot callbacks and signal handlers) with a red one, headers carry ƒ, event, branch and loop icons, `await` gets the latent clock, and variables are set with compact SET nodes.
- **Code and graph stay linked.** Hovering or selecting nodes highlights their code; moving the cursor in the editor highlights the matching node. Double-click a node to jump to its code.
- **Call nodes show the whole signature.** Calling a function of the file, or one imported from another file of the repository, shows one pin per parameter, named and typed like it; missing arguments are unconnected pins that fill in when you wire or type a value (in Python as `name=value`). Calls of other functions get more pins with "Add argument pin", like UE's Add pin.
- **Use functions of other files.** The action menu also offers the functions and values exported by other files of the repository (nearest folders first). Picking one adds the node and writes the import in the file's own style (`import { a } from './x'`, `from x import a`, `const X = preload("res://x.gd")`), joined into an existing import of that file when there is one; one undo removes both.
- **Libraries too.** Python's common standard-library modules (`math`, `json`, `os.path`, `re`, …) and the npm packages a TypeScript file imports from get their signatures, so their calls get pins and the action menu offers their other functions (`math.sqrt` adds `import math`, `computed` joins `import { ref } from 'vue'`). npm types are read from the packages' `.d.ts` files on [jsDelivr](https://www.jsdelivr.com/), at the version in your `package.json`.
- **Operators and values from the action menu.** Math, comparison, logic, joining text and values (text, numbers, lists, objects) in the language's own syntax. Drag a wire from a pin into empty space to use its value (`person` → **+** gives `person + undefined`), pick one for an input to fill it, or right-click empty space for a lone node; wire it on and type into its empty inputs (`Hello, ` becomes `"Hello, "`).
- **Edit in either view.** Rewire pins (like UE, a message tells why a pin doesn't fit or that a wire gets replaced), copy, cut, paste and duplicate nodes (as code, so code from anywhere can be pasted as nodes), collapse selected statements into a new function like UE's "Collapse to Function" (variables they read become its inputs, a variable used afterwards its result), move all wires of a pin with Ctrl/⌘-drag, align and straighten nodes with UE's shortcuts, reorder statements, edit values inline (true / false as a checkbox), add nodes from a searchable action menu (drag a wire into empty space and start typing, with a **Context Sensitive** filter like Blueprint's), delete nodes or just their wires. Undo and redo cover both views.
- **Comments from the code.** A comment above a statement becomes a bubble over its node; a region (`// #region Title` in TypeScript, `#region` in GDScript, `# region` in Python) becomes a comment box around its nodes. Editing them in the graph rewrites the comment.
- **Problems like Compiler Results.** Nodes with an error or warning get a red **ERROR!** or yellow **WARNING!** banner, and a Problems panel lists them all (Shift + Ctrl/Cmd + M). TypeScript and JavaScript are type-checked; GDScript and Python report syntax errors.
- **Go to file and definition.** Ctrl/Cmd + click an import to open that file, or press `F12` on a node to jump to its definition, like in VS Code.
- **Local folders.** Open a project folder from your computer, without uploading anything. In Chrome and Edge, changes are saved back into the folder (⌘S / Ctrl+S) and the folder is remembered; other browsers open it read-only.
- **Shared layouts.** A file you open for the first time is laid out automatically. Once you rearrange it, the layout, including reroute points, is shared with everyone who opens the file on that branch.
- **My Script**, like UE's "My Blueprint": the file's functions, variables, local variables, types and signals with their types (in the language's own syntax). Select one to see its inputs, output and uses; double-click to show it in the graph; drag it into the graph for a call, or a Get / Set of a variable (⌘/Ctrl-drag gets, Alt-drag sets), like in UE. Add functions, variables, local variables and signals with `+`, rename with F2 (its uses in the file are renamed too, following the language's scope rules) and delete them. Selecting a variable's Get or Set node in the graph shows the same variable details. Imports are listed by module, with the inputs and output of imported functions read from their files; double-click one to open its definition in the other file, drag it into the graph for a call or a Get, or delete it. Functions get UE's Inputs and Output: add, rename, reorder and remove inputs, set their types and default values, and set the return type; calls in the same file get their arguments updated to match. In the Details panel (collapsible sections like UE's), rename a function or variable, edit its description (the doc comment above it: `/** */`, `##` in GDScript), pick a variable's type from the language's own types (with Array / Map / Set and Optional, or any type typed by hand), edit its value with a field that fits the type (text is quoted for you), and switch `const` / `let` / `var`, `export` or GDScript's `@export` / `@onready` / `static`.
- **Tabs for open files**, like VS Code: preview tabs that the next file replaces, tabs that stay once you edit or double-click them, and each file keeps its unsaved changes, undo history and scroll position while you switch.
- **A workbench like VS Code's.** Explorer, My Script, Code, Graph, Details and Problems views can be moved, split, resized and hidden; preset layouts are one click away. Light and dark mode follow your system or your choice.
- **Links keep the view.** The graph's position and zoom are part of the URL, so a shared link shows exactly what you saw.
- **Markdown preview** with GitHub-flavoured Markdown, highlighted code blocks and links that open repository files inside vizscript.

## Try it

Run everything in containers, then open http://localhost:8080:

```sh
APP_SECRET=$(openssl rand -base64 48) docker compose up --build
```

- The **playground** (`/playground`) works without signing in and comes with samples in every supported language.
- **Local** opens a folder from your computer, also without signing in.
- To browse your repositories, sign in with a GitHub [fine-grained token](https://github.com/settings/personal-access-tokens/new) that has read access to _Contents_ and _Metadata_.

To run it from source or to contribute, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Working with the graph

Press `?` in the app, or use the keyboard button in the top bar, to see all mouse and keyboard controls.

On phones the viewer is read-only: you can switch between code and graph, pan and pinch-zoom.

## Roadmap

- Commit graph edits back to the repository
- Sign-in through Keycloak with GitHub as identity provider
- GitLab provider
- More languages (C#, Rust, Go, C++, Ruby, …)
- Real type information for pins in all typed languages (e.g. through the TypeScript language service)
- Collapsing nodes to functions, comment boxes and reroute nodes
- Desktop app based on Tauri
- VS Code extension that shows the graph view inside VS Code

## Contributing

Contributions are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers the setup, architecture, scripts and how to verify a change.

## License

[MIT](LICENSE)
