# AGENTS.md

Guidance for AI agents and contributors working in this repository.

## Documentation

- **README.md** is the overview and showcase for users: what vizscript does and how to try it.
- **Mouse and keyboard controls** are listed in the app (`apps/web/src/components/ShortcutsDialog.vue`, opened with `?`), not in the README. Update it when you add or change a shortcut.
- **CONTRIBUTING.md** holds everything technical: setup, architecture, persistence, scripts, verifying changes, commit rules.
- Update the matching file when a change affects it.

## Layout

pnpm workspace with apps in `apps/*` and libraries in `packages/*`.

- **Packages** are consumed as TypeScript source (`exports: ./src/index.ts`) and have no build step.
- **Apps** build on their own: the web app with Vite, the API with tsdown, which bundles `@vizscript/*`.

## Conventions

- **Formatting:** oxfmt (single quotes, trailing commas `es5`, print width 80, sorted imports). Run `pnpm format`.
- **Linting:** oxlint, type-aware. Run `pnpm lint`.
  - Use explicit return types on exported functions.
  - No non-null assertions.
  - Use `ReadonlyArray<T>` instead of `readonly T[]`.
  - Use `import type`.
- **File names:** kebab-case. Vue SFCs use PascalCase.
- **Tests** live in `<package>/test/*.spec.ts`, not next to the source. Graph lowering uses readable snapshots (`summarizeGraph` from `@vizscript/core`).
- **Corpus checks:** `GD_CORPUS=/path/to/godot/project pnpm exec vitest run packages/lang-gdscript` (and `PY_CORPUS=… packages/lang-python`) parse every `.gd` / `.py` file of a real project and fail on any diagnostic. Run them after parser changes.
- **Python grammar gaps:** `@lezer/python` rejects a few valid constructs; `convert.ts` works around them (`isKnownGap`, `maskForParser`, same-length rewrites so offsets stay valid). Add a test when you add a workaround.
- **Commits:** conventional commits (`feat:`, `fix:`, `chore:` …). PR titles are validated.
- **TypeScript:** stays on 6.x until `vue-tsc` and the browser tooling support the TS 7 native compiler.

## Working files

- **`tmp/`** (git-ignored) is for scratch files: scripts, logs, intermediate output. Use it instead of the system temp folder.
- **`local/`** (git-ignored) is for files worth keeping but not committing, e.g. Markdown drafts to copy from.

## Architecture rules

- **Language-agnostic code** stays in `@vizscript/core`. Renderer, layout and persistence must never import a language backend.
- **Graph edits** are expressed as `GraphOp`s. Each backend turns them into minimal `TextEdit`s on the original source, normally through the shared `applyTextOp` with its own `StatementSyntax`. Never regenerate a whole file from an AST.
- **Node ids** must stay stable across unrelated edits. If you change how ids or `path` are built, update the reconciliation tests.
- **The web app** only imports language backends inside the worker (`apps/web/src/graph/registry.ts`). This keeps parsers out of the main bundle.
- **Workbench views** (`apps/web/src/workbench`) are rendered once and teleported into their zone, so moving a view keeps its state. Add new views to `VIEW_IDS` in `@vizscript/workbench`; `normalizeLayout` must keep accepting older stored layouts.
- **Light mode** mirrors the color scales (50 ↔ 950 …) of `zinc`, `red`, `amber`, `sky`, `purple` and `yellow` in `uno.config.ts`, so write UI classes for dark mode only and don't add `dark:` variants. Colors used in plain CSS must come from those scales (`var(--colors-zinc-300)`). The canvas has its own `DARK_THEME` / `LIGHT_THEME`. Pin colors come from `pinColor(type, scheme)`. Monaco uses `monacoTheme(scheme)`.
- **Problems** come from the editor's markers (Monaco's TypeScript worker, plus parser diagnostics set as markers for other languages); `problemsByNode` maps them to nodes.
- **Symbols** (`GraphDocument.symbols`: functions, variables, parameters, types, signals with their types) are collected by each backend's `symbols.ts` from the AST, not from graph nodes. "My Script" and the Details panel use them; `linkSymbolGraphs` connects functions to their graphs. Adding, renaming and deleting symbols goes through `DeclarationSyntax` (core places and validates; each backend's `rename.ts` resolves uses with its scope rules).
- **Comments** are attached in core (`attachComments`): backends only report the ranges of all comments their parser saw. Comment bubbles and boxes come from the code (leading comments, regions), never from the layout store.
- **File references** (Ctrl/Cmd+click on imports) come from the optional `LanguageBackend.references()`. Backends report candidate paths; `resolveModuleReference` in core picks the first one that exists in the repository.
- **NestJS providers** use explicit `@Inject(...)` tokens. The build tools (tsdown, Vite) are not guaranteed to emit decorator metadata.
- **Database changes** go through node-pg-migrate migrations in `apps/api/migrations` (`pnpm migrate create <name> -j ts`). tsdown bundles each one automatically.

## Verifying changes

```sh
pnpm db:up && pnpm preflight
set -a && . ./.env && set +a && pnpm exec vitest run   # includes API e2e tests
```

For UI changes, run `pnpm dev` and check the playground (`/playground`) with the Playwright MCP from `.mcp.json`.
