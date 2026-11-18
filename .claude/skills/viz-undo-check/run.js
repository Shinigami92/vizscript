// Run until `next` equals `total`: the next batch (helper.js `run()`).
async (page) => page.evaluate(() => window.__undoCheck.run());
