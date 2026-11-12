# vizscript

Visualize source code as Unreal-Engine-Blueprint-style node graphs.

Open a repository and pick a script. vizscript shows it as code with syntax highlighting and IntelliSense, as a node graph, or both side by side. The graph has two kinds of wires:

- **Exec wires** (white) show the order in which the code runs.
- **Data wires** (colored by type) connect values, such as variables, parameters and call results, to the inputs that use them.

Node positions are stored in Postgres per repository, branch and file. A file you open for the first time gets an automatic layout. Once you rearrange it, that layout is shared with everyone who opens the file.

> Status: proof of concept. JavaScript/TypeScript, Python and GDScript (Godot 4) are supported. Other languages, providers and commits are planned (see [Roadmap](#roadmap)).

## Quick start

Requirements: Node.js ≥ 24, pnpm 12, Docker.

```sh
pnpm install
cp .env.example .env        # then set APP_SECRET (openssl rand -base64 48)
pnpm db:up                  # starts Postgres via docker compose
pnpm dev                    # API on :3333 (migrates on start), web on :5173
```

- Open http://localhost:5173/playground to try the editor without signing in.
- Sign in with a GitHub [fine-grained token](https://github.com/settings/personal-access-tokens/new) that has read access to _Contents_ and _Metadata_ to browse your repositories.

Everything in containers:

```sh
APP_SECRET=$(openssl rand -base64 48) docker compose up --build   # http://localhost:8080
```

## Working with the graph

| Action                       | Input                                                                                                |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| Pan                          | Right or middle drag, Space + drag, or two-finger scroll                                             |
| Zoom                         | Mouse wheel, Ctrl + scroll, or pinch                                                                 |
| Select / multi-select        | Click, Shift + click (add), Ctrl/Cmd + click (toggle), drag a marquee                                |
| Select a whole function      | Click its frame title                                                                                |
| Move                         | Drag a node; all selected nodes (and reroute points) move together                                   |
| Frame selection / everything | `F` / `Home`                                                                                         |
| Find nodes                   | Ctrl/Cmd + F, then Enter / Shift + Enter to step through the results                                 |
| Context menu                 | Right-click a node, pin, wire, reroute point, frame title or empty space                             |
| Jump to code                 | Double-click a node                                                                                  |
| Go to definition             | `F12` or right-click → Go to definition on a call or variable node                                   |
| Edit a value                 | Double-click an inline value on a pin, or use the details panel                                      |
| Rewire                       | Drag from a pin to another pin                                                                       |
| Reorder statements           | Drag an exec output onto another node's exec input                                                   |
| Add a node                   | Drag a wire out of any pin and release it on empty space (actions depend on the pin), or right-click |
| Add a reroute point          | Double-click a wire; Alt + click a reroute point removes it                                          |
| Disconnect                   | Alt + click a pin                                                                                    |
| Problems panel               | Shift + Ctrl/Cmd + M, or the error / warning counter in the toolbar                                  |
| Delete                       | `Delete` / `Backspace`                                                                               |
| Undo / redo                  | Toolbar buttons, Ctrl/Cmd + Z, Ctrl/Cmd + Shift + Z                                                  |
| Comment a node               | Double-click its comment bubble, or right-click → Add comment                                        |
| Comment box around selection | `C`; double-click the box title to rename it, click it to select and move its nodes                  |

**Comments.** Comments live in the code, so they survive any tool. A comment directly above a statement or function becomes a comment bubble over its node, like Unreal's node comments. A region becomes a comment box around the nodes inside it: `// #region Title` … `// #endregion` in TypeScript/JavaScript, `#region` / `#endregion` in GDScript and `# region` / `# endregion` in Python. Editing a bubble or box title in the graph rewrites the comment, `C` wraps the selected statements in a new region, and deleting a node also deletes its comment. Comments show up in the Details panel and in Find, and the Outline lists the comment boxes.

**Problems.** Like Blueprint nodes that fail to compile, nodes with a problem get a red **ERROR!** (or yellow **WARNING!**) banner; hover it for the message. The Problems panel (bottom, like VS Code's and Unreal's Compiler Results) lists every problem of the file, and clicking one shows it in the code and the graph. TypeScript and JavaScript are type-checked by the editor; GDScript and Python report syntax errors.

**Removing wires keeps nodes.** Alt + click on a pin removes only the wire, like in Blueprints. The nodes that computed the value stay as a statement of their own (`return load(path)` → `load(path);` and `return;`; `return a + b` → `a + b;`), shown as unconnected nodes, and deleting a statement keeps the calls inside it. Wiring an unconnected value into a later input moves it there (a call only into the statement right after it, to keep the order).

**Details panel.** Like Unreal's Details and My Blueprint panels, the panel on the right shows the selected node: kind, location, inputs with editable values, connections and source. Its Outline tab lists the functions and variables of the file.

**Wires dropped on empty space** open a searchable action menu for that pin, like Blueprint's: just start typing. After or before an exec pin you add a statement; from a value you call a function with it or store it in a variable; into an input you call a function, enter a value or pick a variable that is in scope. Functions called in the file, its own functions and imported names are listed, and whatever you type can be used directly (`Call name()`, `Use 42`). **Context Sensitive** hides actions whose types don't fit the pin. Right-clicking empty space opens the same menu.

**Recently opened.** The repositories page lists the repositories you opened last, each reopening on the branch and file you left off; the history button in the header reaches them from anywhere. The list is stored per user on the server (`recent_projects`, the newest 20).

**Go to file / definition.** Ctrl/Cmd + click an import path in the code view to open that repository file, like in VS Code. Uses of imported names (`fakeStringHexadecimal(…)`, `utils.pad`, a preloaded GDScript `Bullet.new()`) open the file at their definition; in the graph, `F12` does the same for the selected node (or jumps to a function of the same file). Supported: relative TypeScript/JavaScript imports, exports, `require()`, `import()` and `new URL(…, import.meta.url)` (`./x.js` finds `./x.ts`, folders find `index.ts`), GDScript `"res://…"` paths and relative `preload()` / `load()` paths, and Python modules next to the file, in the repository root or relative (`from .utils import x`). The browser's Back button returns to the previous file.

**Markdown preview.** Markdown files get a rendered **Preview** view next to the code, like in VS Code: GitHub-flavoured Markdown (tables, task lists, heading anchors, sanitized inline HTML), code blocks highlighted like the editor, links to repository files open inside vizscript and images load from the repository. The preview follows the editor's scroll position; double-click a block to jump to its line.

**Links keep the view.** The graph's position and zoom live in the URL (`?view=x,y,zoom`), so a reload shows exactly the same view. The share button copies a link to the file, with or without the current view (your choice is remembered). Playground links also carry the sample (`?sample=…`).

**One undo history.** Undo and redo cover code edits and layout changes (moves, reroute points, layout resets) in the order they happened, whether made in the graph or in the editor.

**Reroute points** are part of the layout: they are stored with the node positions and shared the same way.

**Code and graph stay linked:**

- Hovering or selecting nodes highlights their code.
- Moving the cursor in the editor highlights the matching node.

**Graph edits are code edits.** Every graph change becomes a minimal text edit to the source, so formatting and comments survive. Changes are kept as a local draft; committing them back is on the roadmap.

## Arranging the workbench

The page is a workbench like VS Code's: the **Explorer**, **Code**, **Graph** and **Details** views sit in a left sidebar, the main area, a right sidebar and a bottom panel.

- **Move a view:** drag its tab or title onto another area. While dragging, empty areas (for example the right sidebar) show a drop zone.
- **Tabs or side by side:** an area with several views shows them as tabs; use the split button in its tab bar to show them side by side (stacked in sidebars), and the tab button to go back.
- **Resize:** drag the borders between areas and between views.
- **Show and hide:** close a view from its tab, or use the layout menu in the toolbar. The menu also has preset layouts (explorer on the right, graph focus, code focus, graph only, …) and **Reset layout**. Code / Split / Viz in the toolbar is a quick switch for the code and graph views.

The layout is stored per user in the database (`user_preferences`, key `workbench.layout`) and cached in the browser. The playground works without signing in and only uses the cache.

On phones the viewer is read-only: you can switch between code and graph, pan and pinch-zoom.

**Light and dark mode:** the button in the top bar cycles between System, Light and Dark. The choice is stored in the browser.

## Architecture

```
apps/
  web/              Vue 3 + Vite + UnoCSS (Tailwind preset) + Monaco
  api/              NestJS (Fastify) + Kysely + node-pg-migrate
packages/
  core/             Language-agnostic graph IR, layout, id reconciliation, edit-op types
  lang-typescript/  JS/TS backend: Babel AST → graph
  lang-gdscript/    GDScript backend: own error-tolerant parser → graph
  lang-python/      Python backend: Lezer syntax tree → graph
  canvas/           Framework-agnostic Canvas2D renderer and interaction controller
  workbench/        Workbench layout model: views, zones, presets, validation
  api-contract/     Types shared by web and api
```

**Graph IR (`@vizscript/core`).** Every language backend lowers its AST into the same IR:

- Functions contain nodes, nodes have pins, and edges connect pins.
- Exec edges and data edges are kept separate.
- Each node keeps its source range, which drives the code ↔ graph linking.

**Mapping to Blueprint concepts:**

- Statements become impure nodes on the exec chain.
- Expressions become pure nodes, like Blueprint pure functions.
- `if`, loops, `switch` and `try` become flow-control nodes with a **Completed** output that continues to the next statement, so the exec flow stays a tree.
- Every function, method and callback gets its own graph with an entry node.
- Module exports are the module's outputs: `export default x` and `export { a, b }` become **Export** nodes (re-exports show their source), exported declarations are labelled `export`, and the Outline lists them under **Exports**.

**Stable node ids.** Ids are derived from function, kind and normalized source text, so they survive formatting changes and edits elsewhere in the file. When a node's own text changes, its saved position is matched by its structural path instead.

**Parsing runs in a Web Worker,** so large files don't block the UI.

### Extension points

- **Languages:** implement `LanguageBackend` (`parse` + `applyOp`) and register it in `apps/web/src/graph/registry.ts` (plus the extension in `languages.ts`, and a Monaco grammar if Monaco lacks one).
  - `parse` lowers the AST to the graph IR and attaches edit metadata (`StatementMeta`, `InsertPoint`, … in `@vizscript/core`).
  - `applyOp` is usually just `applyTextOp(text, doc, op, SYNTAX)`: the edit logic is shared, a `StatementSyntax` describes placeholders, declarations, quoting and templates.
  - Shared graph building lives in `GraphBuilderBase` (`@vizscript/core`); backends add the AST walk.
  - Parsers must run in the browser worker. Python uses `@lezer/python` (pure JS, error tolerant); GDScript, which has no such parser, has a small hand-written one.
- **Source providers:** implement `ScmProvider` in `apps/api/src/scm/` and add it to the `SCM_PROVIDERS` factory. GitLab and local folders would go here.
- **Identity:** login currently goes through `AuthService.loginWithToken`. An OIDC login (Keycloak with a GitHub identity provider) can reuse the same user, identity and credential tables.
- **Layout storage:** the web app talks to a `LayoutStore` interface. There is an API-backed store and a `localStorage` store.

## Scripts

| Script               | What it does                                               |
| -------------------- | ---------------------------------------------------------- |
| `pnpm dev`           | API (tsdown watch) and web (Vite) dev servers              |
| `pnpm build`         | Builds `apps/*`                                            |
| `pnpm test`          | Vitest for all packages; API e2e tests need `DATABASE_URL` |
| `pnpm lint`          | oxlint (type-aware)                                        |
| `pnpm format`        | oxfmt                                                      |
| `pnpm ts-check`      | `tsc` / `vue-tsc` in every package                         |
| `pnpm preflight`     | format, build, lint, update snapshots, type-check          |
| `pnpm migrate <cmd>` | node-pg-migrate (e.g. `up`, `create add-foo`)              |

## Roadmap

- Commit graph edits back to the repository (`ScmProvider.commit`)
- Keycloak login with a GitHub identity provider
- GitLab and local folder providers
- More languages (C#, Ruby, …)
- Real type information for pins through the TypeScript language service
- Collapsing nodes to functions, comment boxes and reroute nodes

## License

[MIT](LICENSE)
