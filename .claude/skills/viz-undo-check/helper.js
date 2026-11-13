// Injected into the page (page.addInitScript): reads the graph view's state
// through Vue's dev handle, for exact before/after comparisons.
// Works with the dev server only (`__vueParentComponent` is a dev feature).
(() => {
  const view = () =>
    document.querySelector('[data-ui=graph-canvas]').__vueParentComponent
      .setupState.view;
  const round = (n) => Math.round(n * 10) / 10;

  window.__undoCheck = {
    /** Everything that should look the same after an undo. */
    snapshot() {
      const v = view();
      const nodes = [...v.nodes.values()]
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
      const edges = v.edges.map((e) => e.edge.id).sort();
      v.updateFrames?.();
      const frames = v.frames
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
        [...v.reroutes.entries()].map(([k, pts]) => [
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

    /** Client position of a pin, or null. */
    pinClient(nodeId, pinId) {
      const v = view();
      const ns = v.nodes.get(nodeId);
      const pg = ns?.geom.pins.get(pinId);
      if (!ns || !pg) {
        return null;
      }

      const cam = v.camera;
      const rect = v.canvas.getBoundingClientRect();
      return {
        x: rect.left + (ns.x + pg.x - cam.x) * cam.zoom,
        y: rect.top + (ns.y + pg.y - cam.y) * cam.zoom,
      };
    },

    /** Client position of a node's header. */
    nodeClient(nodeId) {
      const v = view();
      const ns = v.nodes.get(nodeId);
      if (!ns) {
        return null;
      }

      const cam = v.camera;
      const rect = v.canvas.getBoundingClientRect();
      return {
        x:
          rect.left +
          (ns.x + Math.min(40, ns.geom.width / 2) - cam.x) * cam.zoom,
        y: rect.top + (ns.y + 8 - cam.y) * cam.zoom,
      };
    },

    hasNode(nodeId) {
      return view().nodes.has(nodeId);
    },

    /** Centers the camera on a node (keeps the zoom). */
    center(nodeId) {
      const v = view();
      const ns = v.nodes.get(nodeId);
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

    canvasRect() {
      const r = view().canvas.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    },

    edgeList() {
      return view().edges.map((e) => ({
        id: e.edge.id,
        kind: e.edge.kind,
        from: e.edge.from,
        to: e.edge.to,
      }));
    },
  };
})();
