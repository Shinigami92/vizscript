// Set `window.__run.repro = { index, dir }` first (`dir`: absolute path).
async (page) =>
  page.evaluate(() => {
    const { index, dir } = window.__run.repro;
    return window.__undoCheck.repro(index, dir);
  });
