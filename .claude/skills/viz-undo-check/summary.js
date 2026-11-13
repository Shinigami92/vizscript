// Run with browser_run_code_unsafe (filename) after the last batch: totals,
// the differing items, and whether the graph at the end equals the start.
async (page) => {
  return page.evaluate(() => {
    const { results, start } = window.__run;
    const end = window.__undoCheck.snapshot();
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
  });
}
