// Run with browser_run_code_unsafe (filename) after the target is loaded and
// reset. Gives helper.js Playwright's mouse, keys and screenshots
// (`window.__undoCheckPw`), lists what to remove (every wire, then every
// node but the entry nodes, which can't be deleted) and keeps the start.
async (page) => {
  const ops = {
    move: ({ x, y, steps }) => page.mouse.move(x, y, { steps: steps ?? 1 }),
    click: async ({ x, y, alt }) => {
      if (alt) await page.keyboard.down('Alt');
      await page.mouse.click(x, y);
      if (alt) await page.keyboard.up('Alt');
    },
    press: ({ key }) => page.keyboard.press(key),
    clickSelector: ({ selector }) => page.locator(selector).click(),
    screenshot: async ({ clip, path }) =>
      (await page.screenshot({ clip, path })).toString('base64'),
  };
  // Exposed once per page; later calls (another setup) find it there.
  await page
    .exposeFunction('__undoCheckPw', (op, args) => ops[op](args))
    .catch(() => {});

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
};
