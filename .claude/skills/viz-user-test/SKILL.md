---
name: viz-user-test
description: Act like a real user in the vizscript web app with the Playwright MCP. First rebuild a script from an empty file using only the My Script, Details and graph panels (plus their menus), then make random removals and edits. Collect bugs and UX problems in a findings file. Call it with a playground URL or path, e.g. `http://localhost:5173/playground?sample=greeter.ts&view=-63,-186,0.766`, `/playground?sample=inventory.ts` or `weather.py`.
argument-hint: <url | path | sample name> [mouse | hotkeys]
---

# viz-user-test

Act like a real user of vizscript: rebuild a script by hand in the graph, then edit and remove things at random. Find problems, collect them, and fix nothing without asking.

The user watches the browser. Work slowly and visibly:

- move the mouse in steps (`page.mouse.move(x, y, { steps: 10–20 })`);
- interact the way the input mode says (below);
- take a screenshot after each meaningful step and look at it.

Input: `$ARGUMENTS`

## Input mode (optional)

An optional word in the arguments picks how to interact: `mouse` (default) or `hotkeys` (also `keys`, `keyboard`, `--input=hotkeys`). It is not part of the target.

- **mouse** (default): menus, buttons, drags and double-clicks. Hotkeys only where the mouse has no way (none so far), plus the hotkey + click tests in phase 2.
- **hotkeys**: use the app's keyboard shortcuts wherever one exists, the way a power user works. Use the mouse only for what has no shortcut: pointing at nodes and pins, drags, choosing in menus. The shortcuts are listed in `apps/web/src/components/ShortcutsDialog.vue` (opened with `?` in the app); read it first. Examples: Delete / Backspace, ⌘/Ctrl+Z / ⇧⌘Z, ⌘/Ctrl+C / X / V / D, ⌘/Ctrl+A, ⌘/Ctrl+F, F (zoom to selection), Home (fit all), C (comment box), Q and ⇧W/A/S/D (alignment), F2 (rename in My Script), F12 (go to definition), ⇧F10 (context menu), Alt+click (break a link), B / L / R + click. The canvas only gets keys while it has focus: click empty space first. Note shortcuts that are missing, don't work, or clash.

Report the mode in the findings file.

## 1. Resolve the target

Read the argument and ignore everything that doesn't pick the file. Unimportant parts include the camera (`view=…`), focus mode (`fn=…`) and any other query parameters. Keep only what selects the file:

| Argument                                                               | Open                                                                                 |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `http(s)://host/playground?sample=X&…`                                 | `http(s)://host/playground?sample=X`                                                 |
| `/playground?sample=X…` or `playground?sample=X`                       | `http://localhost:5173/playground?sample=X`                                          |
| `X` (a sample name such as `greeter.ts`, `weather.py`, `collector.gd`) | `http://localhost:5173/playground?sample=X`                                          |
| Another app route (a repository or local folder file)                  | That route, **but ask the user first**: there is no Reset, edits change their draft. |
| Nothing (or only an input mode)                                        | `http://localhost:5173/playground?sample=greeter.ts`                                 |

**Check the sample:** sample names are listed in `apps/web/src/views/playground-samples.ts`. If the name is unknown, say so and list the samples.

**Find the target code:**

- **Playground:** the sample's original text is in `apps/web/src/views/playground-samples.ts`.
- **Other routes:** read the code panel after loading.
- Note its functions, variables, statements and their order before you start.

**Check the dev server:** `curl -s -o /dev/null -w '%{http_code}' http://localhost:5173/` must answer 200. If it doesn't, start it in the background:

```sh
set -a && . ./.env && set +a && pnpm dev > tmp/dev.log 2>&1
```

Don't start a second copy.

## 2. Set up the browser

- First remember the current viewport size, to restore it at the end: `async (page) => page.viewportSize() ?? { width: await page.evaluate(() => window.innerWidth), height: await page.evaluate(() => window.innerHeight) }` (`browser_run_code_unsafe`).
- Viewport **1733×1009** (`browser_resize`): the user's real Chrome size. Dark theme, the app's default.
- Open the target URL. On the playground, click **Reset** in the top bar to start from the original sample.
- Click the "fit all" button in the zoom controls (bottom right of the graph) so the whole graph is visible.

## 3. Phase 1: rebuild the script by hand

1. **Clean up:**
   - Right-click empty space → type `select all` → **Select all** (hotkeys: ⌘/Ctrl+A).
   - Right-click a selected node → **Delete nodes** (hotkeys: Delete).
   - Delete the remaining functions, variables, signals and other declarations in **My Script** (right-click → **Delete**).
   - The file should be empty, or contain only what can't be removed.
2. **Recreate the original as closely as possible.** Use only:
   - **My Script:** `+` for functions, variables, locals and signals; inline rename; dragging a function or variable into the graph; right-click menus.
   - **Details:** name, type picker, default value, `const` / `let` / `var`, modifiers, Inputs (`+ Input`, rename, type, default, reorder, remove) and Output.
   - **The graph:**
     - Drag from a pin into empty space for the action menu; type into its search.
     - Wire pins and double-click inline values to edit them.
     - Right-click nodes, pins and wires for their menus.
3. **Never type into the code panel.** Typing is allowed only in inputs of the panels and menus: names, values and searches.
4. After each step, read the code (see Tips) and compare it with the target. Note every detour, surprise, error banner and wrong placement.
5. At the end, frame the graph and compare the code with the original. List the differences (order, blank lines, quotes, types) and whether the UI could have avoided them.

## 4. Phase 2: random removals and edits

Reset again. Then make about 15–25 varied edits, picked at random from below and adapted to the script.

Check after each edit:

- The code is what you expect.
- Every node kept its place: no swapped or stacked nodes, no wires suddenly crossing the graph.
- The problems count in the status bar makes sense.

Every few edits, undo and redo (toolbar buttons; hotkeys: ⌘/Ctrl+Z, ⇧⌘/Ctrl+Shift+Z) and check the graph again.

Edits to try:

- **Delete:** a statement, a value node, several nodes at once (marquee or Select all), a function or variable that is still used (confirm the dialog), a comment box.
- **Values:** edit inline values (double-click), Details default values, reset ↶.
- **Rename:** a function, variable or input (Details name field), then check the uses.
- **Rewire:** wire an input to another output; break a link (pin menu); Break node links; Ctrl/⌘-drag a pin's wires to another pin.
- **Reorder:** drag an exec output onto another node's exec input.
- **Node menu:** Cut / Copy / Paste / Duplicate, Collapse to function…, Replace variable / function…, Find references, Add / remove argument pin, Reset to default, Promote to variable.
- **Comments:** Create comment box…, add comment…, comment box color and title in Details.
- **Types and inputs:** change a type, the Output type, add and remove inputs (Details) while calls exist.
- **Action menu:** add nodes (flow control, operators, Get / Set, built-ins), with and without Context Sensitive.
- **Hotkey + click:** B, L or R + click on empty space (in mouse mode the only hotkeys to test; in hotkeys mode also all other shortcuts above).

## 5. Report

Write the findings to `local/<sample>-user-test.md` (e.g. `local/greeter-user-test.md`). Overwrite an earlier one only after reading it.

Sections:

- **Result of phase 1:** the rebuilt code next to the original, and the steps used.
- **Bugs:** what happened, what was expected, how to reproduce. Investigate the cause when it is cheap: read the code and probe with a vitest file in `tmp/` (see Tips). Rank them most severe first.
- **UX:** detours, missing defaults, confusing menus or labels, placement, focus.
- **Worked well:** short.

Then summarize the most important findings for the user and ask whether to fix them. **Don't change code in this skill.** Finally:

- Reset the playground so it isn't left in an edited state.
- Set the viewport back to the size remembered in step 2 (`browser_resize`), also when the run stopped early. If that size was already 1733×1009 (left over from an earlier run), use Playwright's default instead: **1280×720**.

## Tips (learned the hard way)

**Motion:** camera moves (fit all, zoom to selection, reveal, zoom buttons) ease over 250 ms and moved nodes slide for 200 ms. Wait about 300 ms before a screenshot or before reading the zoom. Animations follow `prefers-reduced-motion`; `page.emulateMedia({ reducedMotion: 'reduce' })` turns them off.

**Read the code panel:**

```js
async (page) =>
  await page.locator('.view-line').evaluateAll((els) =>
    els
      .map((e) => [parseFloat(e.style.top), e.textContent])
      .sort((a, b) => a[0] - b[0])
      .map((x) => x[1])
  );
```

Monaco renders only the visible lines; scroll the code panel for long files.

**Screenshots:** `browser_take_screenshot` with a relative path may not land in the repo. Use `browser_run_code_unsafe` with `page.screenshot({ path: '<repo>/tmp/<name>.png', clip: … })` and read the file afterwards.

**`browser_run_code_unsafe` takes plain JavaScript:** no TypeScript (`as`, type annotations), or it fails with a syntax error.

**Drag:** `mouse.move` to the pin → `mouse.down()` → several `mouse.move(…, { steps })` → `mouse.up()`. Dropping on empty space opens the action menu: type into its search, then click an entry or press Enter.

**Menus:**

- Click entries with `page.getByRole('menuitem', { name: /^Delete/ })`. `getByText('Delete')` also matches the shortcuts dialog.
- The action menu is `[data-ui=action-menu]`, and its rows are `role=option`.

**Prompts:** prompt dialogs (names) are a form with an input; type and press Enter. Native `confirm` dialogs (deleting a used symbol) need `browser_handle_dialog`.

**Panels:** they carry `data-ui` names: `my-script`, `details-panel`, `graph-canvas`, `zoom-controls`, `action-menu`. In Details, "+ Input" is `button[title="Add an input"]`.

**Synthetic drags from My Script carry no modifier keys,** so the Get / Set menu appears instead of a direct Get or Set.

**Console errors** like `dialog.accept: Cannot accept dialog which is already handled!` come from earlier Playwright sessions, not from the app.

**Probe parser and op behavior without the browser:** write `tmp/probe/probe.spec.ts` with an empty `tmp/probe/vitest.config.mjs` (`export default {}`), import from `../../packages/…/src`, write results with `writeFileSync`, and run:

```sh
timeout 100 pnpm exec vitest run --root tmp/probe --config vitest.config.mjs < /dev/null
```

Never run a command that reads stdin without a redirect, or it hangs.

**Can't `rm`?** Leave the cleanup of `tmp/` to the user.
