---
name: viz-undo-check
description: Systematic undo check of the vizscript graph view with the Playwright MCP. Removes every wire (Alt+click) and every node (Delete) of a file one by one, clicks Undo after each, and compares the graph before and after exactly (node positions and sizes, wires, frames, comment boxes, reroutes, camera, selection, out-of-sync banner, and a pixel diff of the canvas). Reports what an undo did not restore. Use after changes to node ids, position reconciliation, layout or undo. Call it with a playground URL, path or sample name, e.g. `inventory.ts`, `/playground?sample=collector.gd`.
argument-hint: <url | path | sample name>
---

# viz-undo-check

Checks that Undo brings the graph back exactly as it was, for every wire and node of a file. The user watches the browser. The scripts in this folder do the work; run them with `browser_run_code_unsafe` and its `filename` parameter, from the repository root:

| Script       | Does                                                                               |
| ------------ | ---------------------------------------------------------------------------------- |
| `helper.js`  | Injected into the page: reads the graph view's state (`window.__undoCheck`).       |
| `setup.js`   | Lists every wire and every node but the entry nodes, and keeps the starting state. |
| `run.js`     | Removes, undoes and compares the next batch (40 by default).                       |
| `summary.js` | Totals, the differing items, and whether the graph at the end equals the start.    |
| `repro.js`   | Looks at one item again and saves before / removed / undone screenshots.           |

The helper reads the canvas through Vue's dev handle (`__vueParentComponent`), so this works with the dev server only, not with a production build.

## 1. Resolve the target

Same rules as `viz-user-test`:

- **The file:**
  - A sample name (`inventory.ts`, `collector.gd`, `weather.py`, `cart.rs`) or a playground URL opens `http://localhost:5173/playground?sample=<name>`.
  - Ignore the camera (`view=…`) and other parameters.
  - Sample names are listed in `apps/web/src/views/playground-samples.ts`.
- **Other routes** (a repository or local folder file): ask the user first. There is no Reset there, and the check edits the draft (each edit is undone, but a failure can leave a change behind).
- **The dev server:**
  - `curl -s -o /dev/null -w '%{http_code}' http://localhost:5173/` must answer 200.
  - Otherwise start it in the background: `set -a && . ./.env && set +a && pnpm dev > tmp/dev.log 2>&1`.

## 2. Set up

1. **Remember the viewport.** Get the current size, to restore it at the end:

   ```js
   async (page) =>
     page.viewportSize() ?? {
       width: await page.evaluate(() => innerWidth),
       height: await page.evaluate(() => innerHeight),
     };
   ```

2. **Use a real screen size:** 1733×1009 (`browser_resize`). Use the dark theme, the app's default.
3. **Inject the helper and open the target.** Use the absolute path of the repository (`pwd`):

   ```js
   async (page) => {
     await page.addInitScript({
       path: '<repo>/.claude/skills/viz-undo-check/helper.js',
     });
     await page.goto('http://localhost:5173/playground?sample=<name>');
     await page.waitForTimeout(1500);
     // Reset is only shown when the sample was changed.
     const reset = page.locator('[data-ui=playground-reset]');
     if (await reset.isVisible()) {
       await reset.click();
       await page.waitForTimeout(1000);
     }
     return page.evaluate(() => typeof window.__undoCheck);
   };
   ```

   - It must return `object`.
   - `addInitScript` adds the helper again on every call. Add it once per browser session; after that, `goto` alone is enough.

4. **Switch to the graph alone.** Click **Viz** in the editor bar if it isn't active, so the graph has the whole width.
5. **List the items:** run `setup.js`. It returns the number of wires and nodes.

## 3. Run

- **Batches:** run `run.js` again and again until `next` equals `total`.
  - Each batch takes about 2–3 minutes and may move to the background; wait for its notification.
  - Progress is saved after every item, so after an error just run it again.
- **What it does per item:**
  1. Centers the item and clears the selection.
  2. Snapshots the state and takes a screenshot.
  3. Removes the item: Alt+click on the wire's input pin, or click + Delete on the node.
  4. Clicks the toolbar's Undo.
  5. Snapshots, screenshots and compares again.
- **What it returns:** only the notable items:
  - `problems`: what differs after the undo;
  - `pixels`: the bounding box of changed canvas pixels, toasts and zoom controls left out;
  - `selectedAfterUndo`;
  - items that weren't removed or were skipped.

After the last batch, run `summary.js`.

## 4. Look closer

For items with `problems` or large `pixels`, reproduce one:

```js
async (page) => page.evaluate(() => { window.__run.repro = { index: <i>, dir: '<repo>/tmp/undo-check' }; })
```

Then run `repro.js` and read the three screenshots. Typical findings:

- **Stacked or swapped nodes:** two nodes with the same code (`total#0` / `#1`). See `reconcilePositions` and `renamedNodes` in `packages/core/src/reconcile.ts`.
- **Frames that grow or shrink:** a node moved to a new row, and every frame below shifts with it.
- **Small pixel bands along long wires with an identical state:** usually a moment of an animation. Retry with `repro.js` before reporting them.

Investigate the cause when it is cheap: write a probe in `tmp/probe/` (see `viz-user-test`). `packages/lang-typescript/test/undo-layout.spec.ts` shows how to reproduce an op and its undo without the browser.

## 5. Report

- **The findings file:** write `local/<sample>-undo-check.md`. Overwrite an earlier one only after reading it. Include:
  - the setup: target, viewport, mode;
  - a table: wires and nodes removed, restored exactly, layout differed, pixels only, selected after undo;
  - the differences, most severe first, with item numbers and screenshots (`tmp/undo-check/r<i>-*.png`);
  - whether the graph at the end equals the start.
- **To the user:** summarize the most important differences and ask whether to fix them. Don't change code in this skill.
- **Clean up:**
  - reset the playground;
  - set the viewport back to the size from step 2, or to 1280×720 if it was already 1733×1009.
