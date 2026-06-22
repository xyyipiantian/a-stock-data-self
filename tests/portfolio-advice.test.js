const test = require("node:test");
const assert = require("node:assert/strict");

const { classifyAdvice, enrichPortfolioPosition, summarizePortfolio } = require("../src/portfolio-advice");

test("classifies broken-support holdings as defensive", () => {
  const advice = classifyAdvice(
    { costBasis: 17.4 },
    {
      stock: { price: 13.9 },
      snapshot: { totalScore: 58, supportPrice: 14.1, resistancePrice: 14.8 }
    }
  );

  assert.equal(advice.level, "defensive");
  assert.equal(advice.label, "减仓防守");
});

test("enriches a portfolio position with pnl and strategy references", () => {
  const enriched = enrichPortfolioPosition(
    { code: "002639", shares: 1800, costBasis: 17.4, notes: "满仓" },
    {
      stock: { code: "002639", name: "雪人集团", price: 13.94 },
      snapshot: { stance: "谨慎观察", totalScore: 61.2, supportPrice: 13.7, resistancePrice: 14.5 },
      plan: ["优先等支撑确认", "站上压力后再看"],
      candidates: [{ code: "000333", name: "美的集团" }]
    }
  );

  assert.equal(enriched.code, "002639");
  assert.equal(enriched.marketValue, 25092);
  assert.equal(enriched.costValue, 31320);
  assert.equal(enriched.pnlAmount, -6228);
  assert.equal(enriched.candidates.length, 1);
});

test("summarizes portfolio totals", () => {
  const summary = summarizePortfolio([
    { marketValue: 1000, costValue: 1200, pnlAmount: -200, advice: { level: "defensive" } },
    { marketValue: 2000, costValue: 1800, pnlAmount: 200, advice: { level: "positive" } }
  ]);

  assert.equal(summary.marketValue, 3000);
  assert.equal(summary.costValue, 3000);
  assert.equal(summary.pnlAmount, 0);
  assert.equal(summary.pnlPct, 0);
  assert.equal(summary.defensiveCount, 1);
  assert.equal(summary.positiveCount, 1);
});
