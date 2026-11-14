# Contributing to vizscript

Thanks for helping! This guide covers the development setup, the architecture and how to get a change merged. The coding conventions and architecture rules live in [AGENTS.md](AGENTS.md); they apply to human and AI contributors alike.

## Development setup

Requirements: Node.js ≥ 24 (the version in `.nvmrc` is the default), pnpm 12 and Docker.

```sh
pnpm install
cp .env.example .env        # then set APP_SECRET (openssl rand -base64 48)
pnpm db:up                  # starts Postgres via docker compose
pnpm dev                    # API on :3333 (migrates on start), web on :5173
```

- http://localhost:5173/playground works without signing in.
- Public repositories open without signing in (`/repos`, type `owner/name`). To list and open your own, sign in with a GitHub [fine-grained token](https://github.com/settings/personal-access-tokens/new) with read access to _Contents_ and _Metadata_.
- The web dev server proxies `/api` to the API.

### Environment

| Variable         | Purpose                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`   | Postgres for the API, migrations and the API e2e tests                                                  |
| `APP_SECRET`     | Signs sessions and encrypts stored tokens; at least 32 characters                                       |
| `SECURE_COOKIES` | `true` when served over HTTPS                                                                           |
| `PORT`           | API port (default `3333`); the web dev server reads `API_PORT` for its proxy                            |
| `GITHUB_API_URL` | GitHub REST API (default `https://api.github.com`); GitHub Enterprise: `https://<host>/api/v3`          |
| `GITHUB_RAW_URL` | Raw file contents (default `https://raw.githubusercontent.com`, or `https://<host>/raw` for Enterprise) |

### Docker

`docker compose up --build` runs Postgres, the API (which migrates on start) and the web app behind nginx on http://localhost:8080. It needs `APP_SECRET` in the environment.

### Working files

`tmp/` (scratch files) and `local/` (notes and drafts worth keeping) are git-ignored. Use `tmp/` instead of the system temp folder.

## Scripts

| Script                | What it does                                                                      |
| --------------------- | --------------------------------------------------------------------------------- |
| `pnpm dev`            | API (tsdown watch) and web (Vite) dev servers                                     |
| `pnpm build`          | Builds `apps/*`                                                                   |
| `pnpm test`           | Vitest for all packages; API e2e tests need `DATABASE_URL`                        |
| `pnpm lint`           | oxlint (type-aware)                                                               |
| `pnpm format`         | oxfmt                                                                             |
| `pnpm ts-check`       | `tsc` / `vue-tsc` in every package                                                |
| `pnpm preflight`      | install, format, build, lint, update snapshots, type-check                        |
| `pnpm migrate <cmd>`  | node-pg-migrate (e.g. `up`, `create add-foo -j ts`)                               |
| `pnpm db:up` / `down` | Start / stop the Postgres container                                               |
| `pnpm clean`          | Removes everything git ignores except `.env`, `.claude`, `.mcp.json` and `local/` |

## Architecture

```
apps/
  web/              Vue 3 + Vite + UnoCSS (Tailwind preset) + Monaco
  api/              NestJS (Fastify) + Kysely + node-pg-migrate
packages/
  core/             Language-agnostic graph IR, layout, id reconciliation, edit ops
  lang-typescript/  JS/TS backend: Babel AST → graph
  lang-gdscript/    GDScript backend: own error-tolerant parser → graph
  lang-python/      Python backend: Lezer syntax tree → graph
  lang-rust/        Rust backend: Lezer syntax tree → graph
  canvas/           Framework-agnostic Canvas2D renderer and interaction controller
  workbench/        Workbench layout model: views, zones, presets, validation
  api-contract/     Types shared by web and api
```

Packages are consumed as TypeScript source and have no build step. Only the apps build: the web app with Vite, the API with tsdown.

### Graph IR

Every language backend lowers its AST into the IR of `@vizscript/core`:

- Functions contain nodes, nodes have pins, and edges connect pins. Exec edges and data edges are kept separate.
- Each node keeps its source range, which drives the code ↔ graph linking.
- Statements become impure nodes on the exec chain; expressions become pure nodes, like Blueprint pure functions.
- `if`, loops, `switch` and `try` become flow-control nodes with a **Completed** output that continues to the next statement, so the exec flow stays a tree.
- Every function, method and callback gets its own graph with an entry node. Top-level statements form a **Module** graph.
- Module exports are the module's outputs: `export default x` and `export { a, b }` become **Export** nodes (re-exports show their source), and exported declarations are labelled `export`.

**Stable node ids.** Ids are derived from the function, the kind and the normalized source text, so they survive formatting changes and edits elsewhere in the file. When a node's own text changes, its saved position is matched by its structural path instead. Equal code is counted (`greeter(user)#0`, `#1`), so when one of two equal nodes changes, the other one takes its id: positions are therefore first carried through the change itself (`reconcilePositions` with a `TextChange`: an op's edits, or a diff of the text for typing, undo and redo). Moved code (removed here, the same text inserted elsewhere) is followed to its new place; nested nodes that start at the same offset (`a * b * 100`) are told apart by their length. The diff (`diffEdits`) compares lines, then changed lines token by token, so code an op moved is followed back on undo. Positions of nodes that disappear are kept in the workspace's position memory (the `memory` argument), and a node that comes back with the same id (undo, redo) gets its place again instead of landing on its twin.

**Parsing runs in a Web Worker,** so large files don't block the UI. The web app only imports language backends inside the worker.

### Graph edits

Graph changes are `GraphOp`s. Each backend turns them into minimal text edits on the original source, normally through the shared `applyTextOp` with its own `StatementSyntax`. A few rules that keep edits predictable:

- **Auto-casting** (UE's autocast): `TypeSystemInfo.conversions` lists each language's conversions between pin types (`Conversion` in `packages/core/src/conversions.ts`, templates with `$value`: `String($value)`, `str($value)`, `$value.to_string()`). The canvas allows a wire that one of them converts (`findConversion`, message "Convert number to string") and sends it as `connect` with `convert`; `connectData` writes the template around the value (`applyConversion` adds parentheses before a postfix template). One-argument calls of a conversion function are lowered as compact pure nodes (`conversionCall`), like UE's autocast node; as a statement of their own they stay ordinary calls. Moving wires (Ctrl/⌘-drag) never converts.
- **Removing wires keeps nodes.** Alt + click on a pin removes only the wire. The expression that fed it stays as a statement of its own (`return load(path)` → `load(path);` and `return;`), shown as unconnected nodes. Deleting a statement keeps the calls inside it. Deleting a value node keeps the nodes wired into it, like UE: they become statements of their own right before its statement (`keptInputs` in `delete-ops.ts`: `const cart = [{…}, {…}]` → `({…});`, `({…});`, `const cart = undefined;`).
- **Wiring an unconnected value** into a later input moves it there. A call only moves into the statement right after it, so the order of side effects never changes.
- **Adding a node after a nested call** (e.g. after the call in `return f(x)`) first stores the call's result in a variable.
- Edits go through Monaco, so code edits and graph edits share one undo history with layout changes.

### Graph-only edits

Like UE, a graph may be in states the code can't hold yet: an exec wire broken with Alt + click, a statement wired somewhere the code can't put it yet, a value wired into an input before it is computed.

- **The overlay:** such ops become graph-only edits (`GraphEdit`: `removeEdge`, `addEdge`, `removeNode`, `addNodes`; `graphEditsFor` in `packages/core/src/graph-overlay.ts`), keyed by node and pin ids like layout entries. While a file has any, the next wire and delete ops join them, so the code follows what the graph shows. Commands (collapse, extract, comments, …) and invalid input keep their error.
- **What is shown:** `applyOverlay` draws them on the parsed graph: graph-only wires are dashed (`GraphEdge.graphOnly`), and `overlayIssues` names what keeps the graph from being code (a statement cut off from the flow, entered twice, a cycle). Those nodes get a NOT IN CODE banner and a dashed outline, and the issues are listed in Problems.
- **Back to code:** `resolveOverlay` (`overlay-sync.ts`, run in the parser worker) writes them once the graph is valid: deletions and statement moves from the difference between the parsed and the shown graph (in the order the code runs; a call inside an expression moves its statement), then each data wire as `connect` / `disconnect`. Every step is an ordinary op on a copy of the text, re-parsed in between; if one fails, the code stays as it is. The result is one edit in Monaco and one undo step with the overlay (`use-layout-history.ts`).
- **Floating nodes:** a node added where no code can go (the top level of a GDScript or Rust file, which holds declarations only) becomes an `addNodes` edit. `floatingNodes` (`overlay-snippets.ts`, run in the worker) writes the template at the end of a function of a copy of the code and keeps the nodes it makes, with ids `overlay:<group>/…` and the code they stand for. They are drawn outside the function frames (`GraphNode.floating`) until something is wired to them; then they join that function. `resolveOverlay` writes them once they are wired into the flow (`addNode` with their code after the wired exec pin) or, for a value, into an input (`setInput`); `placedNodes` pairs them with the written nodes, so wires and positions follow. Deleting them again leaves nothing behind (`compactOverlay`). Nodes not in the code yet can't be edited until they are wired in.
- **Code edits meanwhile:** the overlay follows the code like positions do (`remapOverlay` with `renamedNodes`); edits whose nodes are gone are dropped with a message.
- **Persistence:** the overlay is stored with the file's draft (`overlay` in the repository and local folder drafts, `vizscript:playground:overlays` in the playground) and counts as unsaved. Saving a local folder is blocked while the graph is out of sync (`out-of-sync` of `ScriptWorkspace`); Discard drops it.

### Comments, problems and references

- **Symbols** list what a file declares, like UE's "My Blueprint": functions and methods with their parameters and return type, module and class variables, locals, classes, types, enums, GDScript signals and imports (`module` and `imported`: an exported name, `default` or `*`; GDScript's `const X = preload(…)`, Python's from lezer in `imports.ts`). Each backend collects them from its AST in `symbols.ts`; types stay in the language's own syntax (`TypeRef.text`) next to a pin type for colors. The "My Script" panel and the Details panel show them. Imports resolve to repository files through the module references (`importTarget` in `script-workspace/use-imports.ts`); deleting one name of an import list removes just it and its comma (`removeListItem`). The workspace reads imported files (`readFile` from the repository or local folder view, open tabs first), parses them in the worker and keeps what they export (`exportedSymbols`: declarations without ranges into the other file, defaults as text). These `ImportedDeclaration`s go along with every parse and op (`ParseOptions.imports`); `linkImports` gives import symbols their kind, inputs and output, and `completeCallPins` gives calls of imported functions (`fn()`, `ns.fn()`) their pins. Using a name of another file is a `withImport` op: the inner op plus `addImport` in one edit. `DeclarationSyntax.addImport` writes the import per language (`add-import.ts` in TypeScript and GDScript, `imports.ts` in Python) with the shared `joinImport` (add to an import of the same module) and `insertImport` (below the last import, a docstring or `extends`). Libraries: a backend may know library modules (`LanguageBackend.library`, `libraries`), as stubs in its own language that are parsed like files (Python's standard library in `lang-python/src/stdlib.ts`). npm packages are read in the browser from jsDelivr (`apps/web/src/graph/npm-types.ts`): the version range of the nearest `package.json`, the `types` entry of the package, and its re-exports, also into other packages (`GraphDocument.reexports`, `withReexports`). Imports of libraries name the module directly (`ImportRequest.module`). Engine classes: `TypeSystemInfo.classes` lists classes a language knows without an import (`EngineClass` in `packages/core/src/engine-classes.ts`: name, base class, members as portable symbols, `singleton` for global objects like `Input`). GDScript's are a part of Godot 4's class reference written as GDScript declarations (`lang-gdscript/src/godot-api.ts`), parsed once like a script (`godot.ts`). The type picker lists them, the action menu offers the members of a value's class with the inherited ones (`classMembers`) and the members the script inherits from its `extends` class (`engine-entries.ts`), `completeCallPins` names and types the pins of their methods (`CallPinOptions.classes`, `selfClass`; the class comes from the value wired into Target, the variable's declared type, or the script's base class), and inherited properties type their Get nodes. `TypeSystemInfo.inferredType` (GDScript's `:=`) adds "Type of the value" to the type picker of variables (`setSymbolType` with it as the type). Callbacks (functions written as an argument, `on('x', (e) => …)`) have graphs of their own; the TypeScript backend gives them symbols with the `callback` modifier, which core names after their graph (`linkSymbolGraphs`). My Script lists them under Graphs, and Details edits their inputs and output (no name, no modifiers but `async`). "Create callback" writes the language's empty callback (`TypeSystemInfo.callback`: `() => {}`, `lambda: None`, `func(): pass`, `|| {}`) into an input. Values of unknown types still get members: a typed name offers `.name()` / `.name` on a value (`useValue` with `$value.name()`); on a call's unused result it continues the chain in place (`chainedCall` in `insert-ops.ts`: `program.name('x').version()`) instead of binding the result first. TypeScript classes of other files, libraries and imports are offered as `new X()` ("Construct", `ExternalName.kind` `class`). `TypeSystemInfo.globals` lists built-in functions offered without an import (`console.log`, `print`); `keywords` keeps reserved words out of the typed entries ("Call return()"), which are also hidden when the menu lists that name already. Action menu entries can carry a `detail` (the signature from `signatureText` and the function's doc comment), shown below the list; favorites and folded categories are kept per browser. The action menu's Get / Set entries list the variables in scope of the function at the menu (`scopeVariables` in `graph-canvas/graph-helpers.ts`: its parameters and locals, module and class variables with their member access); `fits` compares a pin's type with a callable's first parameter or return type (`signature` in `project-index.ts`), unknown types always fit. The action menu's names of other files come from `project-index.ts`: the first time the menu opens, the workspace reads the exports of up to 150 files of the same language, nearest folders first.
- **Types and values:** each backend describes its types as data (`TypeSystemInfo`: basic types with pin colors and default values, container templates such as `list[T]`, modifiers per kind of symbol), sent to the type picker through the parser worker. `setSymbolType`, `setSymbolValue` and `setModifier` write them; backends validate types (`validType`), quote strings and switch keywords or annotations.
- **Dragging from "My Script"** adds a statement at the end of the function under the drop point (`endOfFunction`, before a final `return`): a call with placeholder arguments, an assignment for Set, or a lone value (the `value` node template) for Get, which the graph shows as unconnected nodes until it is wired into an input.
- **Collapse to function** (`collapse.ts`) takes the statements of the selection (one run in one block), finds its inputs (wires coming in, Gets of the enclosing function's variables, and variables a compound assignment like `+=` or `++` reads) and its result (a variable set inside and read after it), and writes the function and the call with `DeclarationSyntax.extract`. One result at most; `return` and jumps out of the selection are refused.
- **Details panel** sections are `DetailsSection` components (collapsed state per section in the browser). A symbol's description is the comment of its entry node (functions, classes) or Set node (variables), written with `setComment` and `doc: true` as a documentation comment (`CommentSyntax.doc`: `block` for `/** */`, or a marker like `##`); edits keep the marker a comment already has.
- **Modifiers** offered by Details come from `TypeSystemInfo.modifiers` per kind (`variable`, `constant`, `local`, `member`, `function`, `method`: declaration `keywords`, `access` levels, `flags`) and are written by each backend's `setModifier` in the language's order (`private static async`). Script settings (`GraphDocument.settings`) are reported by the backend (GDScript: `settings.ts`) and written with `setScriptSetting`.
- **Comment box colors** are layout entries like reroute points (`~color|<boxId>`, palette index in `x`, `COMMENT_BOX_COLORS`), so they're shared, undoable and never written into the code. The Details search is section-level: `DetailsSection` hides sections whose title, text and field values don't contain the query.
- **Categories** are GDScript export groups: `groups.ts` reads them like Godot's inspector (the parser attaches `@export_group(…)` lines to the next variable) and moves a variable's lines into another group (`setSymbolGroup`).
- **Value fields** (`value-fields.ts` in core): vectors and colors come from `TypeSystemInfo.valueEditors` (GDScript: `Vector2` …, `Color`), enum choices from enum symbols (`members`; Python's enum members are constants of the class) and literal unions. The value is written back as code in the form it had (`Color("#…")` stays html).
- **Reset ↶** compares symbols with the saved version of the file (`baseText` from the view: the file's content from the API, the file on disk, the original sample), parsed once (`baseDoc`); symbols match by id. **Expose on Spawn** (TypeScript) is the `constructor` modifier: parameter properties are collected as class fields, `setConstructorParameter` moves a field into the constructor and back.
- **Opening graphs from usage nodes:** double-clicking a call or a callback node (`functionRef`) runs Go to definition (`findDefinitionTarget` in `script-workspace/symbol-lookup.ts`): a callback finds its graph by its range, a call its function by name, and both open it in focus mode; imported functions open their file. Other nodes jump to their code. `parentGraphs` gives the breadcrumb the graphs a callback sits in.
- **Focus mode** (`script-workspace/use-focus-mode.ts`): the canvas gets a document with only the focused function (`shownDoc`), so search, menus and layout stay as they are; ops still work on the whole file. Navigation that targets hidden nodes (`selectNodes`, Go to definition) switches the focus first.
- **Type members:** interfaces and object types list their fields and methods (`ScriptSymbol.fields`, TypeScript `symbols.ts`); classes have member symbols. The action menu offers them for a dragged value whose type is declared in the file (`memberEntries` in `graph-canvas/action-entries.ts`, written with `useValue` as `$value.price`). `addType` adds an empty type per language (`DeclarationSyntax.typeDeclaration`) after the file's last type, else below its imports or header. `setAssignOperator` switches `=` / `+=` / … of an assignment (`ASSIGN_OPERATORS`).
- **Zoomed out** (below `PIN_MENU_ZOOM`, 50 %) a right-click on a pin opens its node's menu.
- **Motion:** `GraphView` eases camera moves (`moveCamera`: fit, zoom to selection, reveal, zoom buttons) and slides nodes that an edit or an alignment moved (`NodeState.tween`; `x` / `y` is where a node is drawn, `getPositions` returns the targets). Panning, wheel, pinch and drags stay instant, and a click or key finishes a slide first. The web app turns it off for `prefers-reduced-motion: reduce` (`motion` option, `setMotion`). Pure helpers (`easeOut`, `lerpCamera`) live in `camera.ts`. Nodes an edit added fade in (`NodeState.appear`, only when some nodes stay, so opening another file doesn't), and `pulseNodes` draws a ring around nodes jumped to (`selectNodes` in `GraphCanvas.vue`: Find references, graph search, problems, Go to definition).
- **UI motion** is plain CSS in `styles.css` under `prefers-reduced-motion: no-preference`: `motion-pop` for menus, popovers and dialogs, `motion-fade`, `motion-toast`, `motion-drawer`, `motion-rotate` (chevrons) and `motion-flash` (My Script rows that were just added or renamed). The enter animations use opacity and translation only, since menus measure their size to stay inside the window. Collapsible content (Details sections, My Script sections, action menu categories) opens and closes with `CollapseTransition`, a height animation (Web Animations API) around one `v-if` element.
- **Node menu ops:** `disconnectNode` clears every data wire of a node in one edit (its own inputs are cleared inside the code kept when its output is cleared); `replaceReference` swaps the name a Get, an assignment or a call starts with (`referenceName`), declarations are refused.
- **Argument pins** (`arg0`, `arg1`, … written in a call; `ARG_PIN`) know their parameter's default (`InputPinMeta.defaultValue`, from `completeCallPins`). `removeArgument` removes one with its comma and a `...`, `*` or `name=` before it; "Reset to default" removes the last argument and writes the default into earlier ones.
- **Copy and paste** work on code: copying takes the statements of the selected nodes, pasting is an `addNode` with a `code` template that `reindentCode` fits into the target block (indent unit of the file). Paste and duplicate select the new nodes.
- **Moving wires** (Ctrl/⌘-drag of a pin) is one `moveWires` op: the `connectData` edits of every moved wire on the same text, merged (`mergeEdits`: identical edits once, overlapping ones fail). Alignment (`GraphView.alignSelection`) only changes positions.
- **Flow-control nodes** are `{ type: 'flow', flow }` node templates; each backend writes them in its `template` and lists the ones it has in `TypeSystemInfo.flow`.
- **Operators and values** come from `TypeSystemInfo.expressions` (`ExpressionTemplate`: label, category, template with `$1`, `$2` …, result type), one list per backend in its `*_TYPES`. The web app fills `$1` with the dragged value and the other slots with the language's `placeholder` (`undefined`, `None`, `null`). A wire dragged from an output becomes a `useValue` op: a lone value after the producing statement, which the graph shows as an unconnected pure node until it is wired. Empty values don't narrow an input's type (`refinesType`), so placeholders take any wire. `looksLikeCode` decides whether typed text is code (numbers, quoted values, known names) or text to quote.
- **Node look** is decided in core (`geometry.ts`), so layout and canvas agree: `isCompact` (getters, operators and setters drawn without a header), `compactTitle` (`SET`), `pinLabel` (a setter's input is labeled with the variable) and `headerIcon` / `isLatent`. Entry nodes use the `entry` category (purple) for functions and `event` (red) for code that runs on its own: the module, class bodies, Godot callbacks and `_on_…` signal handlers.
- **Call pins** (`call-pins.ts`): after parsing, calls of the file's own functions get a pin per parameter (`completeCallPins`). Missing arguments are pins without code that insert the argument at the call's `)` (`insertInitAt`), with placeholders for skipped parameters, or `name=` in Python.
- **Result types:** `setReturnType` also adds a Return node at the end of the flow (`endOfFunction` in `flow.ts`) when the function has none, like UE adds one with the first output.
- **Inferred types** (`infer-types.ts`, after the call pins): a Return's untyped value takes the function's declared result, and an untyped variable the type of the value it is declared with (`const t = greet(user)`).
- **Row wrapping:** exec chains wider than `maxRowWidth` continue on a new row, but a node that ends the flow (Return, throw, break, continue) stays on its row. Rows break between statements: a statement of several nodes (a chain `a.b().c()`) starts a new row when it doesn't fit, and never breaks in the middle (unless twice too wide).
- **New nodes and functions:** a node without a saved position follows the node its value feeds (`new X()` with its SET), else the node before it. A function without saved positions in a file that has some (a callback just written) goes right below the placed functions.
- **Placing new nodes:** the node an edit asked for goes where the menu was opened; the other new nodes of the same edit (a hoisted call, the parts of an expression) keep their auto-layout offset to it.
- **Function frames** never overlap: `layoutDocument` moves a function down when its nodes (saved positions included) come within `frameGap` of an earlier function in the same columns.
- **Signatures** (`signature-ops.ts`): adding, removing, moving, renaming and typing parameters and the return type. Backends report the same-file calls of a function (`callSites`), so arguments stay in sync like UE's call nodes: a new input gets a placeholder argument, a removed one loses it, a moved one moves it.
- **Symbol ops** (`addFunction`, `addVariable`, `addSignal`, `renameSymbol`, `deleteSymbol`) are placed and validated in core (`symbol-ops.ts`, `symbol-edits.ts`) with each language's `DeclarationSyntax`. Renames are backend specific (`rename.ts`): each resolves the uses of a name with its language's scope rules (block scopes and hoisting in TypeScript, assignment makes a name local in Python, function-wide `var` in GDScript), and renames class members through `this.x` / `self.x`.
- **Comments** are attached in core (`attachComments`). Backends only report the ranges of all comments their parser saw. A comment directly above a statement becomes the node's comment; regions become comment boxes. Comments are never stored in the layout.
- **Problems** come from the editor's markers: Monaco's TypeScript worker for TS/JS, plus parser diagnostics set as markers for the other languages. `problemsByNode` maps them to nodes.
- **File references** come from the optional `LanguageBackend.references()`. Backends report candidate paths and `resolveModuleReference` picks the first one that exists in the repository. Supported:
  - TypeScript/JavaScript: relative imports, exports, `require()`, `import()` and `new URL(…, import.meta.url)` (`./x.js` finds `./x.ts`, folders find `index.ts`).
  - GDScript: `"res://…"` paths and relative `preload()` / `load()` paths.
  - Python: modules next to the file, in the repository root or relative (`from .utils import x`).
  - Rust: `mod x;` (`x.rs`, `x/mod.rs`) and `use crate::…` / `self::` / `super::` paths; `crate::` starts in the `src` folder next to the nearest `Cargo.toml`.

### Persistence

| Data                              | Where                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------ |
| Node positions and reroute points | `file_layouts`, per repository, branch and file, shared by all users                             |
| Workbench layout                  | `user_preferences` (key `workbench.layout`), cached in the browser                               |
| Recently opened projects          | `recent_projects`, the newest 20 per user                                                        |
| Unsaved code edits                | Local draft in the browser                                                                       |
| Local folders                     | Handles in IndexedDB (`vizscript` → `folders`), their layouts and drafts in browser storage      |
| Open tabs                         | Browser storage per repository branch or local folder; their Monaco models stay alive while open |
| Camera, color scheme              | URL (`?view=x,y,zoom`) and browser storage                                                       |

Repositories are keyed by the provider's numeric id, so layouts survive renames. The playground uses browser storage only.

### Signed in or not

Signing in is optional. Without a session:

- **Reading repositories:** the web app reads public repositories straight from GitHub without a token (`apps/web/src/api/github-public.ts`, chosen by `repoSource`), so every visitor has GitHub's 60 requests per hour of their own IP instead of sharing the server's. Files come from the raw host (`ClientConfig.github.rawUrl`, no API request; their git blob sha is computed in the browser), so only the repository, its tree and its branches count. The status bar shows the requests left (`GithubLimitStatus`, in `#workbench-status-end`): it updates from the headers of each request and polls GitHub's free `/rate_limit` every minute while the page is visible, which also counts requests of other tabs and notices the hourly reset. `GET /api/config` tells the web app where GitHub is (`GITHUB_API_URL`, `GITHUB_RAW_URL`, e.g. GitHub Enterprise in an internal network).
- **Layouts:** `GET /api/layouts/…` works without a session for public repositories (`OptionalSessionGuard`). Changing a shared layout needs a session and push access (`RepoAccessService` asks the provider with the user's token, cached for 5 minutes; `LayoutResponse.canWrite`). Without it, `repoLayoutStore` keeps the user's moves in browser storage on top of the shared layout.
- **Recent projects** stay in browser storage (`vizscript:recent`), the **workbench layout** in its browser cache; drafts are local either way.

Signed in, the API reads through the user's stored token (private repositories, 5,000 requests per hour) and keeps recent projects and preferences per user.

### Extension points

- **Languages:** implement `LanguageBackend` (`parse` + `applyOp`, optionally `references`) and register it in `apps/web/src/graph/registry.ts`, plus the extension in `languages.ts` and a Monaco grammar if Monaco lacks one.
  - `parse` lowers the AST to the graph IR and attaches edit metadata (`StatementMeta`, `InsertPoint`, … in `@vizscript/core`). Shared graph building lives in `GraphBuilderBase`; backends add the AST walk.
  - `parse` also fills `symbols` (see `summarizeSymbols` for snapshot tests) and calls `linkSymbolGraphs`.
  - `applyOp` is usually just `applyTextOp(text, doc, op, SYNTAX)`. A `StatementSyntax` describes placeholders, declarations, quoting, comments and templates.
  - Parsers must run in the browser worker. Python and Rust use `@lezer/python` / `@lezer/rust` (pure JS, error tolerant); GDScript has a small hand-written parser.
  - Rust specifics (`lang-rust`): a block's last expression is the function's value and becomes a Return node; macro arguments (`println!`, `format!`, `vec!` …) are parsed as expressions on their own; `if let` / `while let` and match arms get output pins for the names their pattern binds; methods go into the type's inherent `impl` block (a new one when there is none), fields into the struct; parameters have no defaults (`TypeSystemInfo.noParameterDefaults`); the placeholder is `todo!()`.
- **Source providers:** implement `ScmProvider` in `apps/api/src/scm/` and add it to the `SCM_PROVIDERS` factory.
- **Identity:** login goes through `AuthService.loginWithToken`. An OIDC login can reuse the same user, identity and credential tables.
- **Local folders** (`apps/web/src/local/`) are read in the browser with the File System Access API, so nothing goes through the API. `LocalProject` hides whether a folder has a handle (Chrome, Edge: remembered, writable) or comes from `<input webkitdirectory>` (other browsers: read-only, this tab only). Listing skips `.git`, `node_modules` and the root `.gitignore` rules.
- **Layout storage:** the web app talks to a `LayoutStore` interface, with an API-backed and a `localStorage` implementation.

## Verifying a change

CI runs install (frozen lockfile), lint, format check, type check, build, the tests against Postgres on Node 24 and 26, and a Docker image build. Locally:

```sh
pnpm db:up && pnpm preflight
set -a && . ./.env && set +a && pnpm exec vitest run   # includes API e2e tests
```

- **Snapshots:** graph lowering uses readable snapshots (`summarizeGraph`). `pnpm preflight` updates them; review the diff.
- **Parser changes:** run the corpus checks against a real project, e.g. `GD_CORPUS=/path/to/godot/project pnpm exec vitest run packages/lang-gdscript` (and `PY_CORPUS=… packages/lang-python`, `RS_CORPUS=… packages/lang-rust`). They fail on any diagnostic.
- **Naming UI parts:** important containers have a `data-ui` name (`workspace-toolbar`, `view-graph`, `details-panel`, …); search the inspector for `data-ui` to find them. New panels, toolbars, menus and dialogs get one too.
- **UI changes:** check them in the running app, especially the playground, in light and dark mode. The repository's `.mcp.json` sets up the Playwright MCP for AI agents. The Claude Code skill `/viz-user-test <playground URL or sample>` (`.claude/skills/viz-user-test`) acts like a user: it rebuilds a sample by hand in the graph, then edits it at random, and writes its findings to `local/`.

## Commits and pull requests

- Use [conventional commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `chore:` …); PR titles are validated.
- Keep titles at most 64 characters, so they stay under 72 with a `(#1234)` suffix.
- Prefer small commits with a clear scope, and keep every commit green in CI on its own.
- Database changes need a migration (`pnpm migrate create <name> -j ts`).
- Bugs and feature requests go through the [issue forms](https://github.com/Shinigami92/vizscript/issues/new/choose).
