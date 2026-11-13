// Run with browser_run_code_unsafe (filename) until `next` equals `total`.
// For each item from `window.__run.next` (at most `batch`): center it,
// snapshot, remove it like a user (Alt+click the wire's input pin, or
// click + Delete), Undo (toolbar), snapshot again and compare, plus a pixel
// diff of the canvas without overlays (toasts, zoom controls, banners).
// Progress is saved after every item, so a failed call can just be rerun.
async (page) => {
  const state = await page.evaluate(() => window.__run);
  const snap = () => page.evaluate(() => window.__undoCheck.snapshot());
  const rect = await page.evaluate(() => window.__undoCheck.canvasRect());
  const clip = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  const viewport = page.viewportSize() ?? { width: 1733, height: 1009 };
  // A spot outside the canvas, so no hover highlight is in the screenshots.
  const neutral = async () => {
    await page.mouse.move(viewport.width - 20, viewport.height / 2, {
      steps: 4,
    });
    await page.waitForTimeout(150);
  };
  const clearSelection = async () => {
    await page.evaluate(() => window.__undoCheck.clearSelection());
    await page.waitForTimeout(120);
  };
  const save = (record) =>
    page.evaluate((r) => {
      window.__run.results.push(r);
      window.__run.next = r.i + 1;
    }, record);

  const compare = (a, b) => {
    const out = [];
    const bn = new Map(b.nodes.map((n) => [n.id, n]));
    const an = new Map(a.nodes.map((n) => [n.id, n]));
    for (const [id, n] of an) {
      const m = bn.get(id);
      if (!m) {
        out.push(`node missing: ${n.kind} "${n.title}" (${id})`);
        continue;
      }

      for (const k of [
        'x',
        'y',
        'w',
        'h',
        'pins',
        'comment',
        'title',
        'graphOnly',
      ]) {
        if (JSON.stringify(n[k]) !== JSON.stringify(m[k])) {
          out.push(
            `node "${n.title}" ${k}: ${JSON.stringify(n[k])} → ${JSON.stringify(m[k])}`
          );
        }
      }
    }

    for (const [id, m] of bn) {
      if (!an.has(id)) out.push(`new node: ${m.kind} "${m.title}" (${id})`);
    }

    const ae = new Set(a.edges);
    const be = new Set(b.edges);
    for (const e of ae) if (!be.has(e)) out.push(`wire missing: ${e}`);
    for (const e of be) if (!ae.has(e)) out.push(`new wire: ${e}`);
    const bf = new Map(b.frames.map((f) => [`${f.kind}:${f.id}`, f]));
    for (const f of a.frames) {
      const g = bf.get(`${f.kind}:${f.id}`);
      if (!g) out.push(`frame missing: ${f.kind} "${f.name}"`);
      else if (JSON.stringify(f) !== JSON.stringify(g)) {
        out.push(
          `frame ${f.kind} "${f.name}": ${JSON.stringify(f.bounds)} → ${JSON.stringify(g.bounds)}`
        );
      }
    }

    if (JSON.stringify(a.reroutes) !== JSON.stringify(b.reroutes))
      out.push('reroute points changed');
    if (JSON.stringify(a.camera) !== JSON.stringify(b.camera))
      out.push(`camera: ${a.camera} → ${b.camera}`);
    if (a.banner !== b.banner)
      out.push(`out-of-sync banner: ${a.banner} → ${b.banner}`);
    return out;
  };

  const pixelDiff = (before, after) =>
    page.evaluate(
      async ({ a, b, ox, oy }) => {
        const masks = [
          ...document.querySelectorAll(
            '[data-ui=zoom-controls], [role=status], [role=alert], [data-ui=graph-sync-warning], [data-ui=graph-breadcrumb]'
          ),
        ]
          .map((el) => el.getBoundingClientRect())
          .filter((r) => r.width > 0);
        // Where toasts appear (they may be gone by now).
        masks.push({
          left: innerWidth - 420,
          right: innerWidth,
          top: innerHeight - 120,
          bottom: innerHeight,
        });
        const masked = (x, y) =>
          masks.some(
            (r) =>
              x >= r.left - 8 &&
              x <= r.right + 8 &&
              y >= r.top - 8 &&
              y <= r.bottom + 8
          );
        const load = (src) =>
          new Promise((res) => {
            const img = new Image();
            img.onload = () => res(img);
            img.src = src;
          });
        const [ia, ib] = await Promise.all([load(a), load(b)]);
        const c = document.createElement('canvas');
        c.width = ia.width;
        c.height = ia.height;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(ia, 0, 0);
        const da = ctx.getImageData(0, 0, c.width, c.height).data;
        ctx.clearRect(0, 0, c.width, c.height);
        ctx.drawImage(ib, 0, 0);
        const db = ctx.getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        let x0 = 1e9;
        let y0 = 1e9;
        let x1 = -1;
        let y1 = -1;
        for (let k = 0; k < da.length; k += 4) {
          const d =
            Math.abs(da[k] - db[k]) +
            Math.abs(da[k + 1] - db[k + 1]) +
            Math.abs(da[k + 2] - db[k + 2]);
          if (d <= 24) continue;
          const px = (k / 4) % c.width;
          const py = Math.floor(k / 4 / c.width);
          if (masked(px + ox, py + oy)) continue;
          n++;
          x0 = Math.min(x0, px);
          y0 = Math.min(y0, py);
          x1 = Math.max(x1, px);
          y1 = Math.max(y1, py);
        }
        return n === 0
          ? null
          : { pixels: n, box: [x0 + ox, y0 + oy, x1 + ox, y1 + oy] };
      },
      {
        a: `data:image/png;base64,${before.toString('base64')}`,
        b: `data:image/png;base64,${after.toString('base64')}`,
        ox: clip.x,
        oy: clip.y,
      }
    );

  const done = [];
  const end = Math.min(state.items.length, state.next + state.batch);
  for (let i = state.next; i < end; i++) {
    const item = state.items[i];
    const label =
      item.type === 'wire'
        ? `wire ${item.id}`
        : `node ${item.kind} "${item.title}" (${item.id})`;
    const nodeId = item.type === 'wire' ? item.to.node : item.id;
    if (
      !(await page.evaluate((id) => window.__undoCheck.hasNode(id), nodeId))
    ) {
      const r = { i, label, skipped: 'node no longer exists', problems: [] };
      done.push(r);
      await save(r);
      continue;
    }

    await page.evaluate((id) => window.__undoCheck.center(id), nodeId);
    await page.waitForTimeout(250);
    await clearSelection();
    await neutral();
    const before = await snap();
    if (item.type === 'wire' && !before.edges.includes(item.id)) {
      const r = { i, label, skipped: 'wire no longer exists', problems: [] };
      done.push(r);
      await save(r);
      continue;
    }

    const beforeShot = await page.screenshot({ clip });

    // Remove it like a user.
    if (item.type === 'wire') {
      const p = await page.evaluate(
        ({ n, pin }) => window.__undoCheck.pinClient(n, pin),
        { n: item.to.node, pin: item.to.pin }
      );
      await page.mouse.move(p.x, p.y, { steps: 6 });
      await page.keyboard.down('Alt');
      await page.mouse.click(p.x, p.y);
      await page.keyboard.up('Alt');
    } else {
      const p = await page.evaluate(
        (id) => window.__undoCheck.nodeClient(id),
        item.id
      );
      await page.mouse.move(p.x, p.y, { steps: 6 });
      await page.mouse.click(p.x, p.y);
      await page.waitForTimeout(150);
      await page.keyboard.press('Delete');
    }

    await page.waitForTimeout(900);
    await neutral();
    const removed = compare(before, await snap()).length > 0;
    const undo = page.locator('button[aria-label="Undo"]');
    if (await undo.isDisabled()) {
      const toast = (
        await page.locator('[role=status], [role=alert]').allTextContents()
      )
        .map((t) => t.trim())
        .filter(Boolean)
        .join(' / ');
      const r = {
        i,
        label,
        removed,
        toast,
        problems: removed ? ['removed, but Undo is disabled'] : [],
        undoDisabled: true,
      };
      done.push(r);
      await save(r);
      continue;
    }

    await undo.click();
    await page.waitForTimeout(900);
    await neutral();
    let after = await snap();
    const problems = compare(before, after);
    const selected = after.selection.length;
    if (selected > 0) {
      await clearSelection();
      await neutral();
      after = await snap();
    }

    const afterShot = await page.screenshot({ clip });
    const pixels = beforeShot.equals(afterShot)
      ? null
      : await pixelDiff(beforeShot, afterShot);
    const r = {
      i,
      label,
      removed,
      problems,
      ...(selected > 0 ? { selectedAfterUndo: selected } : {}),
      ...(pixels ? { pixels } : {}),
    };
    done.push(r);
    await save(r);
  }

  return {
    next: end,
    total: state.items.length,
    notable: done.filter(
      (r) =>
        r.skipped ||
        r.removed === false ||
        r.problems.length > 0 ||
        r.pixels ||
        r.selectedAfterUndo
    ),
  };
}
