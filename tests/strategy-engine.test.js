const test = require("node:test");
const assert = require("node:assert/strict");

const { analyzeStock, calcPeg, findStock, forwardPe, monitorStocks, normalizeCode, peDigestion, searchStocks } = require("../src/strategy-engine");

test("normalizes stock code formats", () => {
  assert.equal(normalizeCode("SH600519"), "600519");
  assert.equal(normalizeCode("000333.SZ"), "000333");
  assert.equal(normalizeCode(" bj832000 "), "832000");
});

test("implements valuation formulas from the skill", () => {
  assert.equal(forwardPe(100, 5), 20);
  assert.equal(calcPeg(20, 0.25), 0.8);
  assert.equal(peDigestion(45, 0.2).toFixed(2), "2.22");
});

test("finds stock by code and returns analysis structure", async () => {
  const stock = await findStock("600519");
  assert.ok(stock);

  const analysis = analyzeStock(stock);
  assert.equal(analysis.stock.code, "600519");
  assert.equal(analysis.positions.length, 4);
  assert.equal(analysis.snapshot.metrics.length >= 5, true);
  assert.equal(analysis.meta.analysisMode, "rule-engine");
});

test("supports fuzzy search by name or theme", async () => {
  const byName = await searchStocks("茅台");
  const byTheme = await searchStocks("AI");

  assert.equal(byName[0].code, "600519");
  assert.equal(byTheme.length > 0, true);
});

test("evaluates watchlist monitoring results", async () => {
  const alerts = await monitorStocks([{ code: "600519", preferredScore: 60 }]);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].code, "600519");
  assert.equal(typeof alerts[0].signal, "string");
});
