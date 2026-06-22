const test = require("node:test");
const assert = require("node:assert/strict");

const { buildPortfolioBriefing } = require("../src/market-briefing");

test("builds online briefing content for a portfolio position", async () => {
  const originalFetch = global.fetch;

  global.fetch = async (url) => {
    const symbol = String(url).split("q=")[1];
    const datasets = {
      sh000001: `v_sh000001="1~SHINDEX~000001~3200~3180~3190~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0.63~3210~3170~0~1200000";`,
      sh000300: `v_sh000300="1~HS300~000300~3800~3770~3780~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0.8~3810~3760~0~980000";`,
      sz399001: `v_sz399001="1~SZINDEX~399001~10500~10420~10460~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0.77~10560~10390~0~860000";`,
      sz399006: `v_sz399006="1~CYB~399006~2100~2070~2085~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~1.45~2118~2064~0~560000";`
    };

    const raw = datasets[symbol];
    if (!raw) {
      throw new Error(`unexpected symbol ${symbol}`);
    }

    return {
      arrayBuffer: async () => Buffer.from(raw, "utf8")
    };
  };

  try {
    const result = await buildPortfolioBriefing([
      { code: "002639", name: "雪人集团", shares: 1800, costBasis: 17.4, notes: "满仓" }
    ]);

    assert.equal(result.market.temperature, "balanced");
    assert.equal(result.scripts.length, 1);
    assert.equal(result.scripts[0].code, "002639");
    assert.match(result.scripts[0].speech, /雪人集团/);
    assert.match(result.headline, /市场环境/);
  } finally {
    global.fetch = originalFetch;
  }
});
