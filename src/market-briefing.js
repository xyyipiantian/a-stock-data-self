const { analyzeStock, findStock } = require("./strategy-engine");
const { enrichPortfolioPosition } = require("./portfolio-advice");

const UA = "Mozilla/5.0";

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function formatPct(value) {
  const number = Number(value || 0);
  return `${number > 0 ? "+" : ""}${round(number, 2)}%`;
}

function symbolForIndex(key) {
  const map = {
    sh_index: "sh000001",
    hs300: "sh000300",
    sz_index: "sz399001",
    cyb: "sz399006"
  };
  return map[key];
}

async function fetchTencentSymbol(symbol) {
  const url = `https://qt.gtimg.cn/q=${symbol}`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": UA
    }
  });
  const bytes = await response.arrayBuffer();
  const raw = new TextDecoder("gbk").decode(bytes);
  const match = raw.match(/="([^"]+)"/);
  if (!match) {
    throw new Error(`指数行情解析失败: ${symbol}`);
  }
  const vals = match[1].split("~");
  if (vals.length < 35) {
    throw new Error(`指数行情字段不足: ${symbol}`);
  }
  return {
    symbol,
    name: vals[1],
    price: Number(vals[3]) || 0,
    lastClose: Number(vals[4]) || 0,
    changePct: Number(vals[32]) || 0,
    high: Number(vals[33]) || 0,
    low: Number(vals[34]) || 0,
    amountWan: Number(vals[37]) || 0
  };
}

async function fetchMarketSnapshot() {
  const [shIndex, hs300, szIndex, cyb] = await Promise.all([
    fetchTencentSymbol(symbolForIndex("sh_index")),
    fetchTencentSymbol(symbolForIndex("hs300")),
    fetchTencentSymbol(symbolForIndex("sz_index")),
    fetchTencentSymbol(symbolForIndex("cyb"))
  ]);

  const breadthScore =
    (shIndex.changePct * 0.28) +
    (hs300.changePct * 0.26) +
    (szIndex.changePct * 0.22) +
    (cyb.changePct * 0.24);

  const temperature =
    breadthScore >= 1.2 ? "risk-on" :
    breadthScore >= 0.2 ? "balanced" :
    breadthScore <= -1.2 ? "risk-off" :
    "cautious";

  const summary =
    temperature === "risk-on"
      ? "市场风险偏好偏强，强势方向更容易延续，但高位追价仍需控制节奏。"
      : temperature === "balanced"
        ? "市场整体偏均衡，机会存在，但更适合结构性参与而不是全面进攻。"
        : temperature === "risk-off"
          ? "市场整体偏弱，今天更强调防守和仓位管理，弱势票不适合硬扛。"
          : "市场有分化，轮动较快，今天更适合先看确认，再决定是否加动作。";

  return {
    indexes: [shIndex, hs300, szIndex, cyb],
    breadthScore: round(breadthScore, 2),
    temperature,
    summary
  };
}

function inferSectorMood(sector, market) {
  const text = String(sector || "");
  if (/(机器人|自动化|AI|算力|芯片|半导体|软件)/.test(text)) {
    if (market.temperature === "risk-on") return "题材成长方向有承接，强势票更容易得到资金关注。";
    if (market.temperature === "risk-off") return "题材成长方向容易先被资金兑现，弱势票承压会更明显。";
    return "题材成长方向仍有博弈空间，但分化会很快，不能把反弹直接当反转。";
  }
  if (/(银行|保险|红利|电力|煤炭)/.test(text)) {
    return market.temperature === "risk-off"
      ? "防守类方向相对更稳，环境越弱，资金越容易回流这类资产。"
      : "防守类方向更多承担稳定器角色，爆发力通常不如高弹性题材。";
  }
  if (/(家电|消费|白酒)/.test(text)) {
    return "消费方向更看估值和预期修复，适合耐心跟踪，不适合情绪化追单。";
  }
  return market.temperature === "risk-off"
    ? "当前环境对中低强度标的并不友好，先看防守再谈进攻。"
    : "当前环境更偏结构性轮动，板块是否有持续性比单日涨跌更重要。";
}

function composePositionSpeech(position, market) {
  if (position.error) {
    return `这只持仓目前还没匹配到有效股票数据，先别贸然操作，优先核对代码。`;
  }

  const defensive = position.advice?.level === "defensive";
  const neutral = position.advice?.level === "neutral" || position.advice?.level === "watch";
  const pnlText = `${position.shares}股，成本 ${position.costBasis}，当前浮盈亏 ${position.pnlAmount >= 0 ? "+" : ""}${position.pnlAmount}，约 ${formatPct(position.pnlPct)}`;
  const environmentText = inferSectorMood(position.sector || position.name, market);

  const actionLine = defensive
    ? `今天更重要的是先把风险拆掉。支撑位参考 ${position.supportPrice}，如果再次失守，优先减仓，不要继续满仓硬扛。`
    : neutral
      ? `今天以观察为主。先看 ${position.supportPrice} 到 ${position.resistancePrice} 这个区间，没出现更强确认前，不急着补仓。`
      : `今天可以继续持有观察，但前提是价格不能明显跌回 ${position.supportPrice} 下方，真正加动作要等更强确认。`;

  const candidateLine = position.candidates?.length
    ? `如果你要做轮动，可以留意 ${position.candidates.map((item) => `${item.name}${item.code}`).join("、")} 这类候选。`
    : "当前没有更明确的轮动替代，就先把仓位纪律放在第一位。";

  return [
    `${position.name} ${position.code} 这笔持仓，${pnlText}。`,
    `从今天环境看，${environmentText}`,
    `按当前规则评分 ${round(position.totalScore, 1)} 和位置判断，${actionLine}`,
    candidateLine
  ].join("");
}

async function buildPortfolioBriefing(items = []) {
  const market = await fetchMarketSnapshot();

  const positions = await Promise.all(
    (Array.isArray(items) ? items : []).map(async (item) => {
      const stock = await findStock(item.code || item.query || "");
      if (!stock) {
        return {
          code: item.code || "",
          name: item.name || item.code || "",
          shares: Number(item.shares || 0),
          costBasis: Number(item.costBasis || 0),
          notes: item.notes || "",
          error: "未找到匹配股票"
        };
      }

      const analysis = analyzeStock(stock);
      const enriched = enrichPortfolioPosition(
        {
          id: item.id || null,
          shares: item.shares,
          costBasis: item.costBasis,
          notes: item.notes
        },
        analysis
      );

      enriched.sector = analysis.stock.sector;
      return enriched;
    })
  );

  const validPositions = positions.filter((item) => !item.error);
  const defensiveCount = validPositions.filter((item) => item.advice?.level === "defensive").length;
  const strongest = [...validPositions].sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0))[0] || null;
  const weakest = [...validPositions].sort((a, b) => (a.totalScore || 0) - (b.totalScore || 0))[0] || null;

  const headline = `今天的市场环境是：${market.summary}`;
  const overall = validPositions.length
    ? `你当前模拟仓一共 ${validPositions.length} 笔持仓，其中 ${defensiveCount} 笔更偏防守处理。${strongest ? `相对最能继续观察的是 ${strongest.name}` : ""}${weakest && weakest !== strongest ? `，当前最需要优先管控的是 ${weakest.name}` : ""}。`
    : "你当前还没有录入有效持仓，所以今天的发言先以市场环境为主。";

  const scripts = validPositions.map((item) => ({
    code: item.code,
    name: item.name,
    speech: composePositionSpeech(item, market)
  }));

  return {
    market,
    headline,
    overall,
    scripts,
    positions
  };
}

module.exports = {
  buildPortfolioBriefing,
  fetchMarketSnapshot
};
