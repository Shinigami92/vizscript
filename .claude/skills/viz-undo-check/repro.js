// Run with browser_run_code_unsafe (filename) to look at one item again:
// set `window.__run.repro = { index, dir }` first (`dir`: absolute path,
// e.g. `<repo>/tmp/undo-check`). Saves r<index>-1-before.png,
// -2-removed.png and -3-undone.png of the canvas.
async (page) => {
  const { index, dir } = await page.evaluate(() => window.__run.repro);
  const item = await page.evaluate((n) => window.__run.items[n], index);
  const nodeId = item.type === 'wire' ? item.to.node : item.id;
  const rect = await page.evaluate(() => window.__undoCheck.canvasRect());
  const clip = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  const viewport = page.viewportSize() ?? { width: 1733, height: 1009 };
  const neutral = () =>
    page.mouse.move(viewport.width - 20, viewport.height / 2);
  const selection = () =>
    page.evaluate(() => window.__undoCheck.snapshot().selection);

  await page.evaluate((id) => window.__undoCheck.center(id), nodeId);
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__undoCheck.clearSelection());
  await neutral();
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${dir}/r${index}-1-before.png`, clip });

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
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${dir}/r${index}-2-removed.png`, clip });
  const selectedRemoved = await selection();
  await page.locator('button[aria-label="Undo"]').click();
  await page.waitForTimeout(1000);
  await neutral();
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${dir}/r${index}-3-undone.png`, clip });
  return { index, item, selectedRemoved, selectedUndone: await selection() };
}
