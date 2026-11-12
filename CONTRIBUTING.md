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
- To browse repositories, sign in with a GitHub [fine-grained token](https://github.com/settings/personal-access-tokens/new) with read access to _Contents_ and _Metadata_.
- The web dev server proxies `/api` to the API.

### Environment

| Variable         | Purpose                                                                      |
| ---------------- | ---------------------------------------------------------------------------- |
| `DATABASE_URL`   | Postgres for the API, migrations and the API e2e tests                       |
| `APP_SECRET`     | Signs sessions and encrypts stored tokens; at least 32 characters            |
| `SECURE_COOKIES` | `true` when served over HTTPS                                                |
| `PORT`           | API port (default `3333`); the web dev server reads `API_PORT` for its proxy |

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

**Stable node ids.** Ids are derived from the function, the kind and the normalized source text, so they survive formatting changes and edits elsewhere in the file. When a node's own text changes, its saved position is matched by its structural path instead.

**Parsing runs in a Web Worker,** so large files don't block the UI. The web app only imports language backends inside the worker.

### Graph edits

Graph changes are `GraphOp`s. Each backend turns them into minimal text edits on the original source, normally through the shared `applyTextOp` with its own `StatementSyntax`. A few rules that keep edits predictable:

- **Removing wires keeps nodes.** Alt + click on a pin removes only the wire. The expression that fed it stays as a statement of its own (`return load(path)` → `load(path);` and `return;`), shown as unconnected nodes. Deleting a statement keeps the calls inside it.
- **Wiring an unconnected value** into a later input moves it there. A call only moves into the statement right after it, so the order of side effects never changes.
- **Adding a node after a nested call** (e.g. after the call in `return f(x)`) first stores the call's result in a variable.
- Edits go through Monaco, so code edits and graph edits share one undo history with layout changes.

### Comments, problems and references

- **Symbols** list what a file declares, like UE's "My Blueprint": functions and methods with their parameters and return type, module and class variables, locals, classes, types, enums and GDScript signals. Each backend collects them from its AST in `symbols.ts`; types stay in the language's own syntax (`TypeRef.text`) next to a pin type for colors. The "My Script" panel and the Details panel show them.
- **Types and values:** each backend describes its types as data (`TypeSystemInfo`: basic types with pin colors and default values, container templates such as `list[T]`, modifiers per kind of symbol), sent to the type picker through the parser worker. `setSymbolType`, `setSymbolValue` and `setModifier` write them; backends validate types (`validType`), quote strings and switch keywords or annotations.
- **Dragging from "My Script"** adds a statement at the end of the function under the drop point (`endOfFunction`, before a final `return`): a call with placeholder arguments, an assignment for Set, or a lone value (the `value` node template) for Get, which the graph shows as unconnected nodes until it is wired into an input.
- **Signatures** (`signature-ops.ts`): adding, removing, moving, renaming and typing parameters and the return type. Backends report the same-file calls of a function (`callSites`), so arguments stay in sync like UE's call nodes: a new input gets a placeholder argument, a removed one loses it, a moved one moves it.
- **Symbol ops** (`addFunction`, `addVariable`, `addSignal`, `renameSymbol`, `deleteSymbol`) are placed and validated in core (`symbol-ops.ts`) with each language's `DeclarationSyntax`. Renames are backend specific (`rename.ts`): each resolves the uses of a name with its language's scope rules (block scopes and hoisting in TypeScript, assignment makes a name local in Python, function-wide `var` in GDScript), and renames class members through `this.x` / `self.x`.
- **Comments** are attached in core (`attachComments`). Backends only report the ranges of all comments their parser saw. A comment directly above a statement becomes the node's comment; regions become comment boxes. Comments are never stored in the layout.
- **Problems** come from the editor's markers: Monaco's TypeScript worker for TS/JS, plus parser diagnostics set as markers for the other languages. `problemsByNode` maps them to nodes.
- **File references** come from the optional `LanguageBackend.references()`. Backends report candidate paths and `resolveModuleReference` picks the first one that exists in the repository. Supported:
  - TypeScript/JavaScript: relative imports, exports, `require()`, `import()` and `new URL(…, import.meta.url)` (`./x.js` finds `./x.ts`, folders find `index.ts`).
  - GDScript: `"res://…"` paths and relative `preload()` / `load()` paths.
  - Python: modules next to the file, in the repository root or relative (`from .utils import x`).

### Persistence

| Data                              | Where                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------- |
| Node positions and reroute points | `file_layouts`, per repository, branch and file, shared by all users                        |
| Workbench layout                  | `user_preferences` (key `workbench.layout`), cached in the browser                          |
| Recently opened projects          | `recent_projects`, the newest 20 per user                                                   |
| Unsaved code edits                | Local draft in the browser                                                                  |
| Local folders                     | Handles in IndexedDB (`vizscript` → `folders`), their layouts and drafts in browser storage |
| Camera, color scheme              | URL (`?view=x,y,zoom`) and browser storage                                                  |

Repositories are keyed by the provider's numeric id, so layouts survive renames. The playground uses browser storage only.

### Extension points

- **Languages:** implement `LanguageBackend` (`parse` + `applyOp`, optionally `references`) and register it in `apps/web/src/graph/registry.ts`, plus the extension in `languages.ts` and a Monaco grammar if Monaco lacks one.
  - `parse` lowers the AST to the graph IR and attaches edit metadata (`StatementMeta`, `InsertPoint`, … in `@vizscript/core`). Shared graph building lives in `GraphBuilderBase`; backends add the AST walk.
  - `parse` also fills `symbols` (see `summarizeSymbols` for snapshot tests) and calls `linkSymbolGraphs`.
  - `applyOp` is usually just `applyTextOp(text, doc, op, SYNTAX)`. A `StatementSyntax` describes placeholders, declarations, quoting, comments and templates.
  - Parsers must run in the browser worker. Python uses `@lezer/python` (pure JS, error tolerant); GDScript has a small hand-written parser.
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
- **Parser changes:** run the corpus checks against a real project, e.g. `GD_CORPUS=/path/to/godot/project pnpm exec vitest run packages/lang-gdscript` (and `PY_CORPUS=… packages/lang-python`). They fail on any diagnostic.
- **UI changes:** check them in the running app, especially the playground, in light and dark mode. The repository's `.mcp.json` sets up the Playwright MCP for AI agents.

## Commits and pull requests

- Use [conventional commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `chore:` …); PR titles are validated.
- Keep titles at most 64 characters, so they stay under 72 with a `(#1234)` suffix.
- Prefer small commits with a clear scope, and keep every commit green in CI on its own.
- Database changes need a migration (`pnpm migrate create <name> -j ts`).
- Bugs and feature requests go through the [issue forms](https://github.com/Shinigami92/vizscript/issues/new/choose).
