// Run with browser_run_code_unsafe (filename) after the target is loaded and
// reset. Lists what to remove: every wire, then every node but the entry
// nodes (they can't be deleted), and keeps the starting state.
async (page) => {
  return page.evaluate(() => {
    const check = window.__undoCheck;
    if (!check) {
      throw new Error('helper.js is not injected: run the setup snippet first');
    }

    const start = check.snapshot();
    const wires = check.edgeList().map((e) => ({ type: 'wire', ...e }));
    const nodes = start.nodes
      .filter((n) => n.kind !== 'entry')
      .map((n) => ({ type: 'node', id: n.id, kind: n.kind, title: n.title }));
    window.__run = {
      items: [...wires, ...nodes],
      next: 0,
      batch: 40,
      results: [],
      start,
    };
    return {
      wires: wires.length,
      nodes: nodes.length,
      total: wires.length + nodes.length,
    };
  });
}
