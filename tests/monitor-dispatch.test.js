const test = require("node:test");
const assert = require("node:assert/strict");

const { buildWebhookMessage } = require("../src/monitor-dispatch");

test("builds readable webhook message", () => {
  const message = buildWebhookMessage({
    name: "贵州茅台",
    code: "600519",
    signal: "突破提醒",
    price: 1738.5,
    changePct: 3.2,
    totalScore: 81.4,
    stance: "积极布局",
    reason: "站上关键压力位",
    action: "可提高到 30% 仓位"
  });

  assert.match(message, /贵州茅台 600519/);
  assert.match(message, /突破提醒/);
  assert.match(message, /可提高到 30% 仓位/);
});
