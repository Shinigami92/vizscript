// After the last batch: totals, the differing items, and whether the graph
// at the end equals the start (helper.js `summary()`).
async (page) => page.evaluate(() => window.__undoCheck.summary());
