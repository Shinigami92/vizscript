// Injected into the page (page.addInitScript). `window.__undoCheck`:
// - state for exact before/after comparisons (`snapshot`, `compare`), read
//   through Vue's dev handle (dev server only);
// - click targets from the canvas's accessible DOM (`[data-ui=graph-a11y]`),
//   checked against what's really under the point;
// - `settled()`, to wait for an edit instead of sleeping.
(() => {
  const view = () =>
    document.querySelector('[data-ui=graph-canvas]').__vueParentComponent
      .setupState.view;
  const round = (n) => Math.round(n * 10) / 10;
  const a11yNode = (id) =>
    document.querySelector(
      `[data-ui=graph-a11y] [data-node-id="${CSS.escape(id)}"]`
    );
  // What the scene looked like at the last `mark()`, and when it last changed.
  let marked = null;
  let seen = null;
  let changedAt = 0;

  /** A point to click, and what covers it if it isn't the canvas. */
  const target = (el, x, y) => {
    if (!el) {
      return null;
    }

    const hit = document.elementFromPoint(x, y);
    const canvas = view().canvas;
    return {
      x,
      y,
      covered:
        hit === canvas
          ? null
          : (hit?.closest('[data-ui]')?.getAttribute('data-ui') ??
            hit?.tagName ??
            'outside the window'),
    };
  };

  const itemLabel = (item) =>
    item.type === 'wire'
      ? `wire ${item.id}`
      : `node ${item.kind} "${item.title}" (${item.id})`;

  /** Polls `settled()` for at most `timeout` ms; false on a timeout. */
  const settle = async (self, timeout = 2000) => {
    const start = performance.now();
    while (performance.now() - start < timeout) {
      if (self.settled()) {
        return true;
      }

      await new Promise((res) => setTimeout(res, 50));
    }

    return false;
  };

  /**
   * Centers one item, removes it like a user (Alt+click the wire's input
   * pin, or click + Delete), clicks Undo and compares. `hooks` take
   * screenshots for repro.js.
   */
  const removeAndUndo = async (self, pw, item, clip, hooks = {}) => {
    const wire = item.type === 'wire';
    const nodeId = wire ? item.to.node : item.id;
    // Off the canvas, so no hover highlight is in the screenshots.
    const neutral = async () => {
      await pw('move', { x: innerWidth - 20, y: innerHeight / 2 });
      await self.frame();
    };
    if (!self.hasNode(nodeId)) {
      return { skipped: 'node no longer exists' };
    }

    self.center(nodeId);
    self.clearSelection();
    await neutral();
    const before = self.snapshot();
    if (wire && !before.edges.includes(item.id)) {
      return { skipped: 'wire no longer exists' };
    }

    const p = wire
      ? self.pinClient(nodeId, item.to.pin)
      : self.nodeClient(nodeId);
    if (!p || p.covered) {
      return {
        skipped: `target ${p ? `covered by ${p.covered}` : 'not found'}`,
      };
    }

    const beforeShot = await (
      hooks.before ?? (() => pw('screenshot', { clip }))
    )();
    self.mark();
    await pw('move', { x: p.x, y: p.y, steps: 6 });
    await pw('click', { x: p.x, y: p.y, alt: wire });
    if (!wire) {
      await pw('press', { key: 'Delete' });
    }

    await neutral();
    const reparsed = await settle(self);
    await hooks.removed?.();
    const removed = self.compare(before, self.snapshot()).length > 0;
    const undo = document.querySelector('button[aria-label="Undo"]');
    if (!undo || undo.disabled) {
      const toast = [
        ...document.querySelectorAll('[role=status], [role=alert]'),
      ]
        .map((t) => t.textContent.trim())
        .filter(Boolean)
        .join(' / ');
      return {
        removed,
        toast,
        problems: removed ? ['removed, but Undo is disabled'] : [],
        undoDisabled: true,
      };
    }

    self.mark();
    await pw('clickSelector', { selector: 'button[aria-label="Undo"]' });
    await neutral();
    const undone = await settle(self);
    const after = self.snapshot();
    const problems = self.compare(before, after);
    const selected = after.selection.length;
    if (selected > 0) {
      self.clearSelection();
      await self.frame();
    }

    let pixels = null;
    if (!hooks.before) {
      const afterShot = await pw('screenshot', { clip });
      pixels =
        afterShot === beforeShot
          ? null
          : await self.pixelDiff(
              `data:image/png;base64,${beforeShot}`,
              `data:image/png;base64,${afterShot}`,
              clip.x,
              clip.y
            );
    }

    return {
      removed,
      problems,
      ...(reparsed && undone ? {} : { slow: { reparsed, undone } }),
      ...(selected > 0 ? { selectedAfterUndo: selected } : {}),
      ...(pixels ? { pixels } : {}),
    };
  };

  window.__undoCheck = {
    /** Everything that should look the same after an undo. */
    snapshot() {
      const v = view();
      const nodes = [...v.scene.nodes.values()]
        .map((ns) => ({
          id: ns.node.id,
          title: ns.node.title,
          kind: ns.node.kind,
          x: round(ns.x),
          y: round(ns.y),
          w: round(ns.geom.width),
          h: round(ns.geom.height),
          pins: ns.node.pins.map((p) => `${p.id}:${String(p.type)}`).join(','),
          comment: ns.node.comment?.text ?? null,
          graphOnly: !!ns.full.graphOnly,
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
      const edges = v.scene.edges.map((e) => e.edge.id).sort();
      v.scene.updateFrames();
      const frames = v.scene.frames
        .map((f) => ({
          kind: f.kind,
          name: f.name,
          id: f.boxId ?? f.fnId,
          bounds: f.bounds
            ? [
                round(f.bounds.x),
                round(f.bounds.y),
                round(f.bounds.width),
                round(f.bounds.height),
              ]
            : null,
        }))
        .sort((a, b) => `${a.kind}${a.id}`.localeCompare(`${b.kind}${b.id}`));
      const reroutes = Object.fromEntries(
        [...v.scene.reroutes.entries()].map(([k, pts]) => [
          k,
          pts.map((p) => [round(p.x), round(p.y)]),
        ])
      );
      const cam = v.getCamera();
      return {
        nodes,
        edges,
        frames,
        reroutes,
        selection: [...v.getSelection()].sort(),
        camera: [
          round(cam.x),
          round(cam.y),
          Math.round(cam.zoom * 1000) / 1000,
        ],
        banner: !!document.querySelector('[data-ui=graph-sync-warning]'),
      };
    },

    /** What differs between two snapshots (empty: the same). */
    compare(a, b) {
      const out = [];
      const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
      const bn = new Map(b.nodes.map((n) => [n.id, n]));
      const an = new Map(a.nodes.map((n) => [n.id, n]));
      const keys = [
        'x',
        'y',
        'w',
        'h',
        'pins',
        'comment',
        'title',
        'graphOnly',
      ];
      for (const [id, n] of an) {
        const m = bn.get(id);
        if (!m) {
          out.push(`node missing: ${n.kind} "${n.title}" (${id})`);
          continue;
        }

        for (const k of keys) {
          if (!same(n[k], m[k])) {
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
        else if (!same(f, g)) {
          out.push(
            `frame ${f.kind} "${f.name}": ${JSON.stringify(f.bounds)} → ${JSON.stringify(g.bounds)}`
          );
        }
      }

      if (!same(a.reroutes, b.reroutes)) out.push('reroute points changed');
      if (!same(a.camera, b.camera))
        out.push(`camera: ${a.camera} → ${b.camera}`);
      if (a.banner !== b.banner)
        out.push(`out-of-sync banner: ${a.banner} → ${b.banner}`);
      return out;
    },

    /**
     * Bounding box of the canvas pixels that differ between two PNGs (data
     * URLs of a clip at `ox`/`oy`), leaving out overlays and where toasts
     * appear. null: the same.
     */
    async pixelDiff(a, b, ox, oy) {
      const masks = [
        ...document.querySelectorAll(
          '[data-ui=zoom-controls], [role=status], [role=alert], [data-ui=graph-sync-warning], [data-ui=graph-breadcrumb]'
        ),
      ]
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.width > 0);
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

    /** Middle of a pin, from the accessible DOM; null if not there. */
    pinClient(nodeId, pinId) {
      const el = a11yNode(nodeId)?.querySelector(
        `[data-pin="${CSS.escape(pinId)}"]`
      );
      const r = el?.getBoundingClientRect();
      return r ? target(el, r.left + r.width / 2, r.top + r.height / 2) : null;
    },

    /** A point on a node's header (its title row). */
    nodeClient(nodeId) {
      const el = a11yNode(nodeId);
      const r = el?.getBoundingClientRect();
      if (!r) {
        return null;
      }

      const zoom = view().getCamera().zoom;
      return target(
        el,
        r.left + Math.min(40 * zoom, r.width / 2),
        r.top + 8 * zoom
      );
    },

    hasNode(nodeId) {
      return a11yNode(nodeId) !== null;
    },

    /** Centers the camera on a node (keeps the zoom). */
    center(nodeId) {
      const v = view();
      const ns = v.scene.nodes.get(nodeId);
      const rect = v.canvas.getBoundingClientRect();
      const cam = v.getCamera();
      v.setCamera({
        x: ns.x + ns.geom.width / 2 - rect.width / 2 / cam.zoom,
        y: ns.y + ns.geom.height / 2 - rect.height / 2 / cam.zoom,
        zoom: cam.zoom,
      });
    },

    clearSelection() {
      view().setSelection([]);
    },

    /** Resolves after the next drawn frame (the DOM layer is synced then). */
    frame() {
      return new Promise((res) =>
        requestAnimationFrame(() => requestAnimationFrame(res))
      );
    },

    /** Remembers the scene, for `settled()`. */
    mark() {
      marked = view().scene.edges;
      seen = marked;
      changedAt = performance.now();
    },

    /**
     * True once the scene was replaced since `mark()` (a parse after an edit
     * or undo), stayed the same for `quiet` ms, and nothing moves anymore.
     */
    settled(quiet = 150) {
      const v = view();
      const now = performance.now();
      if (v.scene.edges !== seen) {
        seen = v.scene.edges;
        changedAt = now;
      }

      return (
        seen !== marked && v.frameRequest === null && now - changedAt >= quiet
      );
    },

    canvasRect() {
      const r = view().canvas.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    },

    /**
     * Removes, undoes and compares the next items of `window.__run` (at most
     * its `batch`). Mouse, keys and screenshots go through `__undoCheckPw`,
     * which setup.js exposes from Playwright. Progress is saved per item.
     */
    async run() {
      const self = window.__undoCheck;
      const pw = window.__undoCheckPw;
      const state = window.__run;
      const clip = self.canvasRect();
      const done = [];
      const end = Math.min(state.items.length, state.next + state.batch);
      for (let i = state.next; i < end; i++) {
        const item = state.items[i];
        const r = { i, label: itemLabel(item), problems: [] };
        Object.assign(r, await removeAndUndo(self, pw, item, clip));
        state.results.push(r);
        state.next = i + 1;
        done.push(r);
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
            r.selectedAfterUndo ||
            r.slow
        ),
      };
    },

    /** Looks at one item again; saves r<index>-1-before / -2-removed / -3-undone.png in `dir`. */
    async repro(index, dir) {
      const self = window.__undoCheck;
      const pw = window.__undoCheckPw;
      const item = window.__run.items[index];
      const clip = self.canvasRect();
      const shot = (name) =>
        pw('screenshot', { clip, path: `${dir}/r${index}-${name}.png` });
      const r = await removeAndUndo(self, pw, item, clip, {
        before: () => shot('1-before'),
        removed: () => shot('2-removed'),
      });
      await shot('3-undone');
      return { index, label: itemLabel(item), ...r };
    },

    /** Totals, the differing items, and whether the end equals the start. */
    summary() {
      const { results, start } = window.__run;
      const end = this.snapshot();
      const totals = (type) => {
        const list = results.filter((r) => r.label.startsWith(type));
        return {
          total: list.length,
          exact: list.filter(
            (r) =>
              r.removed &&
              r.problems.length === 0 &&
              !r.pixels &&
              !r.selectedAfterUndo
          ).length,
          layout: list.filter((r) => r.problems.length > 0).length,
          pixelsOnly: list.filter((r) => r.problems.length === 0 && r.pixels)
            .length,
          selectedAfterUndo: list.filter((r) => r.selectedAfterUndo).length,
          notRemoved: list
            .filter((r) => r.removed === false || r.skipped)
            .map((r) => r.label),
        };
      };
      const endNodes = new Map(end.nodes.map((n) => [n.id, n]));
      const movedSinceStart = start.nodes
        .filter((n) => {
          const m = endNodes.get(n.id);
          return !m || m.x !== n.x || m.y !== n.y;
        })
        .map((n) => `${n.title} (${n.id})`);
      return {
        wires: totals('wire'),
        nodes: totals('node'),
        layout: results
          .filter((r) => r.problems.length > 0)
          .map((r) => ({ i: r.i, label: r.label, problems: r.problems })),
        pixelsOnly: results
          .filter((r) => r.problems.length === 0 && r.pixels)
          .map((r) => ({ i: r.i, label: r.label, pixels: r.pixels })),
        endEqualsStart: {
          movedSinceStart,
          frames: JSON.stringify(start.frames) === JSON.stringify(end.frames),
          wires: JSON.stringify(start.edges) === JSON.stringify(end.edges),
        },
      };
    },

    edgeList() {
      return view().scene.edges.map((e) => ({
        id: e.edge.id,
        kind: e.edge.kind,
        from: e.edge.from,
        to: e.edge.to,
      }));
    },
  };
})();
