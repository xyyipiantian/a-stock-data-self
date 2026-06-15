const stockUniverse = require("../data/stock-universe.json");

const EASTMONEY_SEARCH_TOKEN = "D43BF722C8E33BDC906FB84D85E326E8";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function normalizeCode(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^(sh|sz|bj)/, "")
    .replace(/\.(sh|sz|bj)$/, "")
    .replace(/[^0-9]/g, "")
    .slice(0, 6);
}

function forwardPe(price, epsForecast) {
  if (!Number.isFinite(price) || !Number.isFinite(epsForecast) || epsForecast <= 0) {
    return null;
  }
  return price / epsForecast;
}

function peDigestion(currentPe, cagr, targetPe = 30) {
  if (!Number.isFinite(currentPe) || currentPe <= targetPe) return 0;
  if (!Number.isFinite(cagr) || cagr <= 0) return null;
  return Math.log(currentPe / targetPe) / Math.log(1 + cagr);
}

function calcPeg(pe, cagr) {
  if (!Number.isFinite(pe) || !Number.isFinite(cagr) || cagr <= 0) return null;
  return pe / (cagr * 100);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value, digits = 1) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function scoreTrend(stock) {
  return clamp(
    50 + stock.ma20GapPct * 1.8 + stock.ma60GapPct * 1.1 + stock.dayChangePct * 1.2 + (stock.volumeRatio - 1) * 14,
    0,
    100
  );
}

function scoreValuation(forwardPeValue, pegValue) {
  let score = 55;
  if (forwardPeValue !== null) {
    if (forwardPeValue <= 18) score += 18;
    else if (forwardPeValue <= 28) score += 10;
    else if (forwardPeValue <= 40) score += 2;
    else score -= 10;
  }

  if (pegValue !== null) {
    if (pegValue < 0.9) score += 18;
    else if (pegValue <= 1.3) score += 10;
    else if (pegValue <= 1.8) score += 2;
    else score -= 12;
  }

  return clamp(score, 0, 100);
}

function scoreQuality(stock) {
  return clamp(45 + stock.roe * 1.4 + stock.growthQuality * 0.35 - stock.debtPressure * 0.5, 0, 100);
}

function scoreCapital(stock) {
  return clamp(50 + stock.capitalFlowScore * 0.4 + stock.northboundScore * 0.3 + stock.eventHeat * 0.35, 0, 100);
}

function scoreRisk(stock) {
  return clamp(35 + stock.volatility * 0.8 + stock.debtPressure * 0.7 + stock.policyRisk * 0.8, 0, 100);
}

function stanceFromScore(totalScore, riskScore) {
  if (totalScore >= 82 && riskScore < 76) return "积极布局";
  if (totalScore >= 70 && riskScore < 82) return "偏多跟踪";
  if (totalScore >= 58) return "中性观察";
  return "谨慎防守";
}

function confidenceFromScore(totalScore, riskScore) {
  if (totalScore >= 76 && riskScore <= 70) return "高";
  if (totalScore >= 64 && riskScore <= 80) return "中";
  return "低";
}

function bandLabel(score) {
  if (score >= 78) return "强";
  if (score >= 62) return "中";
  return "弱";
}

function summarizeSignals({ trendScore, valuationScore, qualityScore, capitalScore, riskScore }) {
  return [
    `趋势 ${bandLabel(trendScore)}`,
    `估值 ${bandLabel(valuationScore)}`,
    `质量 ${bandLabel(qualityScore)}`,
    `资金 ${bandLabel(capitalScore)}`,
    `风险 ${riskScore >= 68 ? "高" : riskScore >= 54 ? "中" : "低"}`
  ];
}

function baseHeaders(extra = {}) {
  return {
    "User-Agent": UA,
    Referer: "https://quote.eastmoney.com/",
    ...extra
  };
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: baseHeaders(options.headers)
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

function localListStocks() {
  return stockUniverse
    .map((stock) => ({
      code: stock.code,
      name: stock.name,
      sector: stock.sector,
      tags: stock.tags,
      price: stock.price,
      dayChangePct: stock.dayChangePct
    }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

function localMatches(query) {
  const normalized = normalizeCode(query);
  const text = String(query || "").trim().toLowerCase();

  return localListStocks().filter((stock) => {
    if (!query) return true;
    if (normalized && stock.code.includes(normalized)) return true;
    return (
      stock.name.toLowerCase().includes(text) ||
      stock.sector.toLowerCase().includes(text) ||
      stock.tags.some((tag) => tag.toLowerCase().includes(text))
    );
  });
}

async function remoteSuggest(query) {
  const keyword = String(query || "").trim();
  if (!keyword) return [];

  const url =
    "https://searchapi.eastmoney.com/api/suggest/get?" +
    new URLSearchParams({
      input: keyword,
      type: "14",
      token: EASTMONEY_SEARCH_TOKEN
    });

  const payload = await fetchJson(url);
  const rows = payload?.QuotationCodeTable?.Data || [];
  return rows
    .filter((item) => item.Classify === "AStock")
    .map((item) => ({
      code: item.Code,
      name: item.Name,
      sector: item.SecurityTypeName || "A股",
      tags: [item.SecurityTypeName || "A股", item.MarketType === "1" ? "沪市" : item.MarketType === "2" ? "深市" : "北交所"],
      quoteId: item.QuoteID,
      marketType: item.MarketType
    }));
}

async function findRemoteByCode(code) {
  const matches = await remoteSuggest(code);
  return matches.find((item) => item.code === code) || matches[0] || null;
}

function tencentPrefixedCode(code) {
  if (code.startsWith(("6", "9"))) return `sh${code}`;
  if (code.startsWith("8")) return `bj${code}`;
  return `sz${code}`;
}

async function fetchTencentQuote(code) {
  const url = `https://qt.gtimg.cn/q=${tencentPrefixedCode(code)}`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": UA
    }
  });
  const bytes = await response.arrayBuffer();
  const raw = new TextDecoder("gbk").decode(bytes);
  const match = raw.match(/="([^"]+)"/);
  if (!match) {
    throw new Error("行情数据解析失败");
  }
  const vals = match[1].split("~");
  if (vals.length < 53) {
    throw new Error("行情字段不足");
  }
  return {
    name: vals[1],
    price: Number(vals[3]) || 0,
    lastClose: Number(vals[4]) || 0,
    open: Number(vals[5]) || 0,
    changePct: Number(vals[32]) || 0,
    high: Number(vals[33]) || 0,
    low: Number(vals[34]) || 0,
    amountWan: Number(vals[37]) || 0,
    turnoverPct: Number(vals[38]) || 0,
    peTtm: Number(vals[39]) || 0,
    amplitudePct: Number(vals[43]) || 0,
    marketCapYi: Number(vals[44]) || 0,
    floatMarketCapYi: Number(vals[45]) || 0,
    pb: Number(vals[46]) || 0,
    limitUp: Number(vals[47]) || 0,
    limitDown: Number(vals[48]) || 0,
    volumeRatio: Number(vals[49]) || 1
  };
}

async function fetchEastmoneyStockInfo(code) {
  const marketCode = code.startsWith("6") ? 1 : 0;
  const url =
    "https://push2.eastmoney.com/api/qt/stock/get?" +
    new URLSearchParams({
      fltt: "2",
      invt: "2",
      fields: "f57,f58,f84,f85,f127,f116,f117,f189,f43",
      secid: `${marketCode}.${code}`
    });

  const payload = await fetchJson(url);
  const data = payload?.data || {};
  return {
    code: data.f57 || code,
    name: data.f58 || "",
    industry: data.f127 || "A股",
    price: Number(data.f43) / 100 || 0
  };
}

function growthPresetBySector(sector) {
  const text = String(sector || "");
  if (/(算力|芯片|半导体|软件|AI|光模块|服务器)/.test(text)) return 0.3;
  if (/(新能源|电池|整车|机器人|自动化)/.test(text)) return 0.24;
  if (/(白酒|消费|家电)/.test(text)) return 0.14;
  if (/(银行|保险|红利)/.test(text)) return 0.08;
  if (/(有色|资源|黄金|铜)/.test(text)) return 0.12;
  return 0.16;
}

function buildRemoteStockProfile(searchHit, quote, info) {
  const sector = info.industry || searchHit.sector || "A股";
  const growthRate = growthPresetBySector(sector);
  const basePe = quote.peTtm > 0 ? quote.peTtm : 22;
  const epsCurrent = basePe > 0 ? quote.price / basePe : Math.max(0.2, quote.price / 22);
  const epsNext = epsCurrent * (1 + growthRate);
  const amplitude = quote.amplitudePct || 6.5;
  const trendBias = clamp(quote.changePct * 1.3 + amplitude * 0.35, -6, 12);
  const ma20GapPct = round(clamp(trendBias, -8, 12), 1);
  const ma60GapPct = round(clamp(trendBias + 3, -6, 16), 1);
  const volumeRatio = clamp(quote.volumeRatio || 1, 0.7, 3.5);
  const roe = clamp((quote.pb > 0 && basePe > 0 ? (quote.pb / basePe) * 100 : 12) + growthRate * 24, 8, 30);
  const policyRisk = /(银行|保险|地产|医药|资源)/.test(sector) ? 28 : 20;
  const tags = Array.from(
    new Set([
      sector,
      searchHit.tags?.[0],
      quote.marketCapYi > 3000 ? "大市值" : quote.marketCapYi > 800 ? "中大市值" : "高弹性",
      growthRate >= 0.24 ? "成长" : growthRate <= 0.1 ? "防守" : "均衡"
    ].filter(Boolean))
  );

  return {
    code: searchHit.code,
    name: info.name || searchHit.name,
    sector,
    tags,
    price: quote.price || info.price || 0,
    dayChangePct: quote.changePct || 0,
    volumeRatio,
    epsCurrent,
    epsNext,
    roe,
    growthQuality: clamp(58 + growthRate * 100 * 0.9 + volumeRatio * 6, 45, 88),
    debtPressure: clamp(35 - roe * 0.6 + (quote.marketCapYi < 300 ? 8 : 0), 10, 48),
    capitalFlowScore: clamp(55 + quote.changePct * 3 + (volumeRatio - 1) * 18, 30, 90),
    northboundScore: clamp(45 + (quote.marketCapYi > 1000 ? 12 : 4) + (quote.changePct > 0 ? 6 : 0), 35, 78),
    eventHeat: clamp(50 + Math.abs(quote.changePct) * 4 + (volumeRatio - 1) * 15, 38, 92),
    volatility: clamp(22 + amplitude * 2.1, 18, 56),
    policyRisk,
    ma20GapPct,
    ma60GapPct,
    pullbackBufferPct: clamp(amplitude * 0.72, 2.8, 7.8),
    breakoutBufferPct: clamp(amplitude * 0.88, 3.5, 8.8),
    catalyst: `${sector} 方向近期处于 ${quote.changePct >= 0 ? "修复/强化" : "震荡分歧"} 阶段，当前价格、量比与估值组合适合做规则化跟踪`,
    watchItems: ["量比是否维持", "板块强度", "关键价位承接"],
    risks: [
      quote.changePct >= 0 ? "冲高回落" : "弱势反抽失败",
      `${sector} 板块轮动过快`,
      "资金持续性不足"
    ],
    timeline: [
      { date: "今日", label: "实时行情", detail: `当前涨跌幅 ${round(quote.changePct, 1)}%，量比 ${round(volumeRatio, 2)}。` },
      { date: "观察", label: "估值框架", detail: `按前向 PE / PEG 规则做仓位分层，不直接追单次情绪波动。` },
      { date: "策略", label: "执行提醒", detail: `优先围绕支撑与突破位执行，避免一次打满。` }
    ]
  };
}

function buildPositionScenario(stock, context, exposure) {
  const { totalScore, riskScore, supportPrice, resistancePrice } = context;
  const actionBias = totalScore - riskScore;

  let title = "";
  let action = "";
  let trigger = "";
  let guardrail = "";
  let sizing = "";

  if (exposure === 10) {
    title = "轻仓试错";
    action =
      actionBias >= 18
        ? "允许先开观察仓，优先等回踩确认后吸纳。"
        : "只保留底仓观察，不追高，等待量价二次确认。";
    trigger = `靠近 ${supportPrice} 一线企稳，或放量突破 ${resistancePrice} 后再加。`;
    guardrail = `跌破 ${round(supportPrice * 0.97, 2)} 视为试错失败，直接收回。`;
    sizing = "单次动作不超过总计划仓位的 1/3。";
  } else if (exposure === 30) {
    title = "标准配置";
    action =
      actionBias >= 12
        ? "可以围绕主逻辑做第一笔正式配置，保留机动仓等待确认。"
        : "只在情绪回落时低吸，避免在高波动时一次打满。";
    trigger = `若 2 个交易日维持在 ${supportPrice} 上方，可逐步抬到 30%。`;
    guardrail = `若量能跌回均量下方且失守 ${supportPrice}，先降回 10%-15%。`;
    sizing = "把仓位分成 2 到 3 笔执行，优先把均价压在计划区间内。";
  } else if (exposure === 50) {
    title = "进攻半仓";
    action =
      totalScore >= 72 && riskScore < 62
        ? "只有在主升段逻辑完整时才考虑半仓，核心是顺趋势而不是抄底。"
        : "当前不建议主动上半仓，除非出现超预期催化或强分歧低点。";
    trigger = `站稳 ${resistancePrice} 且资金流连续转强后，再考虑从 30% 提到 50%。`;
    guardrail = `半仓状态下，任何一条核心逻辑被证伪，都要先退回 20%-30%。`;
    sizing = "半仓只适用于胜率和赔率同时在线的阶段。";
  } else {
    title = "高仓应对";
    action =
      totalScore >= 82 && riskScore <= 52
        ? "仅限强趋势龙头或业绩超预期确认后的持有，不建议普通阶段满仓。"
        : "不建议推进到高仓位，宁可错过，不用仓位承受不确定性。";
    trigger = `高仓应建立在趋势、业绩、资金三项共振，且股价远离 ${supportPrice} 失败位。`;
    guardrail = `高仓下跌破 ${supportPrice} 必须降杠杆，优先回到 30% 以下。`;
    sizing = "高仓是结果，不是起手动作；先让利润垫替你承担波动。";
  }

  return {
    exposure,
    title,
    action,
    trigger,
    guardrail,
    sizing
  };
}

function buildCandidateCard(stock, rankedPeer) {
  return {
    code: rankedPeer.code,
    name: rankedPeer.name,
    sector: rankedPeer.sector,
    tags: rankedPeer.tags,
    score: rankedPeer.totalScore,
    reason:
      rankedPeer.sector === stock.sector
        ? `同属 ${stock.sector}，适合作为同逻辑对照。`
        : `共享 ${stock.tags.find((tag) => rankedPeer.tags.includes(tag)) || "景气度"} 主题，可做轮动替补。`
  };
}

function buildTimeline(stock) {
  return stock.timeline.map((item, index) => ({
    id: `${stock.code}-${index}`,
    ...item
  }));
}

function analyzeStockLite(stock) {
  const cagr = stock.epsCurrent > 0 && stock.epsNext > 0 ? stock.epsNext / stock.epsCurrent - 1 : null;
  const forwardPeValue = forwardPe(stock.price, stock.epsCurrent);
  const pegValue = calcPeg(forwardPeValue, cagr);
  const trendScore = scoreTrend(stock);
  const valuationScore = scoreValuation(forwardPeValue, pegValue);
  const qualityScore = scoreQuality(stock);
  const capitalScore = scoreCapital(stock);
  const riskScore = scoreRisk(stock);
  return {
    totalScore: round(
      trendScore * 0.24 + valuationScore * 0.22 + qualityScore * 0.2 + capitalScore * 0.22 + (100 - riskScore) * 0.12,
      1
    )
  };
}

function analyzeStock(stock) {
  const cagr = stock.epsCurrent > 0 && stock.epsNext > 0 ? stock.epsNext / stock.epsCurrent - 1 : null;
  const forwardPeValue = forwardPe(stock.price, stock.epsCurrent);
  const pegValue = calcPeg(forwardPeValue, cagr);
  const digestionYears = peDigestion(forwardPeValue, cagr);
  const trendScore = scoreTrend(stock);
  const valuationScore = scoreValuation(forwardPeValue, pegValue);
  const qualityScore = scoreQuality(stock);
  const capitalScore = scoreCapital(stock);
  const riskScore = scoreRisk(stock);
  const totalScore = round(
    trendScore * 0.24 + valuationScore * 0.22 + qualityScore * 0.2 + capitalScore * 0.22 + (100 - riskScore) * 0.12,
    1
  );
  const supportPrice = round(stock.price * (1 - stock.pullbackBufferPct / 100), 2);
  const resistancePrice = round(stock.price * (1 + stock.breakoutBufferPct / 100), 2);
  const stance = stanceFromScore(totalScore, riskScore);
  const confidence = confidenceFromScore(totalScore, riskScore);
  const signals = summarizeSignals({ trendScore, valuationScore, qualityScore, capitalScore, riskScore });

  const peerCandidates = stockUniverse
    .filter((item) => item.code !== stock.code)
    .map((item) => {
      const peerAnalysis = analyzeStockLite(item);
      const sharedTags = item.tags.filter((tag) => stock.tags.includes(tag)).length;
      return {
        ...item,
        totalScore: peerAnalysis.totalScore + sharedTags * 2
      };
    })
    .sort((a, b) => b.totalScore - a.totalScore)
    .slice(0, 4)
    .map((item) => buildCandidateCard(stock, item));

  const context = { totalScore, riskScore, supportPrice, resistancePrice };

  return {
    stock: {
      code: stock.code,
      name: stock.name,
      sector: stock.sector,
      price: stock.price,
      dayChangePct: stock.dayChangePct,
      tags: stock.tags
    },
    snapshot: {
      stance,
      confidence,
      totalScore,
      supportPrice,
      resistancePrice,
      targetRange: `${round(stock.price * 1.08, 2)} - ${round(stock.price * 1.15, 2)}`,
      metrics: [
        { label: "前向 PE", value: forwardPeValue === null ? "-" : `${round(forwardPeValue, 1)}x` },
        { label: "PEG", value: pegValue === null ? "-" : round(pegValue, 2) },
        { label: "ROE", value: `${round(stock.roe, 1)}%` },
        { label: "量比", value: round(stock.volumeRatio, 2) },
        { label: "主力资金分", value: round(stock.capitalFlowScore, 0) },
        { label: "PE 消化", value: digestionYears === null ? "-" : `${round(digestionYears, 1)} 年` }
      ],
      signals
    },
    thesis: {
      trend: `股价位于 20 日线 ${stock.ma20GapPct >= 0 ? "上方" : "下方"} ${Math.abs(round(stock.ma20GapPct, 1))}% ，60 日趋势 ${stock.ma60GapPct >= 0 ? "抬升" : "转弱"}，当前更适合 ${trendScore >= 70 ? "顺趋势跟随" : trendScore >= 58 ? "等确认再参与" : "先观察等待修复"}。`,
      valuation: `以 a-stock-data 里的前向 PE / PEG / PE 消化框架看，当前前向 PE ${forwardPeValue === null ? "-" : `${round(forwardPeValue, 1)}x`}，PEG ${pegValue === null ? "-" : round(pegValue, 2)}，属于 ${valuationScore >= 70 ? "估值承接尚可" : valuationScore >= 58 ? "估值中性" : "估值偏挤"} 区间。`,
      catalyst: `${stock.catalyst}；接下来优先盯 ${stock.watchItems.join("、")}。`,
      risk: `风险点集中在 ${stock.risks.join("、")}。若跌破 ${supportPrice} 或资金流评分连续两日回落，则先把节奏切回防守。`
    },
    plan: [
      `优先在 ${supportPrice} 一带观察承接，确认企稳再开第一笔。`,
      `突破 ${resistancePrice} 且量比维持在 ${round(Math.max(1.2, stock.volumeRatio * 0.85), 2)} 以上，才允许扩大仓位。`,
      `若 3 日内没有出现资金接力或事件兑现，策略自动降级为区间交易。`
    ],
    positions: [10, 30, 50, 80].map((exposure) => buildPositionScenario(stock, context, exposure)),
    candidates: peerCandidates,
    timeline: buildTimeline(stock),
    meta: {
      analysisMode: "rule-engine",
      updatedAt: new Date().toISOString(),
      universeSize: stockUniverse.length,
      source: stock._source || "local-universe"
    }
  };
}

async function findStock(query) {
  const normalized = normalizeCode(query);
  if (normalized) {
    const exactByCode = stockUniverse.find((stock) => stock.code === normalized);
    if (exactByCode) return exactByCode;
  }

  const text = String(query || "").trim().toLowerCase();
  if (text) {
    const exactLocal =
      stockUniverse.find((stock) => stock.name.toLowerCase() === text || stock.code === normalized) ||
      stockUniverse.find((stock) => stock.name.toLowerCase().includes(text) || stock.sector.toLowerCase().includes(text));
    if (exactLocal) return exactLocal;
  }

  const remoteMatches = await remoteSuggest(query);
  const best = normalized ? remoteMatches.find((item) => item.code === normalized) || remoteMatches[0] : remoteMatches[0];
  if (!best) return null;

  return buildLiveProfileFromSearchHit(best);
}

async function buildLiveProfileFromSearchHit(best) {
  const [quote, info] = await Promise.all([fetchTencentQuote(best.code), fetchEastmoneyStockInfo(best.code)]);
  const remoteProfile = buildRemoteStockProfile(best, quote, info);
  remoteProfile._source = "live-quote";
  return remoteProfile;
}

async function buildLiveProfileByCode(code) {
  const normalized = normalizeCode(code);
  if (!normalized) return null;
  const local = stockUniverse.find((item) => item.code === normalized);
  if (local) {
    try {
      const quote = await fetchTencentQuote(normalized);
      return {
        ...local,
        price: quote.price || local.price,
        dayChangePct: quote.changePct || local.dayChangePct,
        volumeRatio: quote.volumeRatio || local.volumeRatio,
        _source: "live-quote"
      };
    } catch {
      return { ...local, _source: "local-universe" };
    }
  }

  const hit = await findRemoteByCode(normalized);
  if (!hit) return null;
  return buildLiveProfileFromSearchHit(hit);
}

async function searchStocks(query) {
  const locals = localMatches(query).slice(0, 8);
  const seen = new Set(locals.map((item) => item.code));
  let merged = [...locals];

  if (String(query || "").trim()) {
    try {
      const remotes = await remoteSuggest(query);
      for (const item of remotes) {
        if (seen.has(item.code)) continue;
        merged.push(item);
        seen.add(item.code);
        if (merged.length >= 8) break;
      }
    } catch {
      // Keep local results if remote suggestion fails.
    }
  }

  return merged.slice(0, 8);
}

function evaluateMonitor(analysis, options = {}) {
  const support = analysis.snapshot.supportPrice;
  const resistance = analysis.snapshot.resistancePrice;
  const price = analysis.stock.price;
  const changePct = analysis.stock.dayChangePct;
  const totalScore = analysis.snapshot.totalScore;
  const allowPushPct = Number(options.breakoutPct ?? 0.8);
  const pullbackPct = Number(options.pullbackPct ?? 1.5);
  const preferredScore = Number(options.preferredScore ?? 68);
  const maxRiskAlertScore = Number(options.maxRiskAlertScore ?? 60);
  const watchName = options.name || `${analysis.stock.name} ${analysis.stock.code}`;

  let severity = "idle";
  let signal = "继续观察";
  let action = "暂无新动作，维持原计划。";
  let reason = `当前总分 ${totalScore}，价格 ${price}，继续观察支撑与突破位。`;

  if (price >= resistance * (1 + allowPushPct / 100) && totalScore >= preferredScore) {
    severity = "high";
    signal = "突破提醒";
    action = "可把计划上调到 30% 或 50% 仓位，前提是量价继续共振。";
    reason = `${watchName} 已明显站上压力位 ${resistance}，且评分达到 ${totalScore}。`;
  } else if (price <= support * (1 + pullbackPct / 100) && totalScore >= preferredScore - 8) {
    severity = "medium";
    signal = "回踩试仓";
    action = "靠近支撑区，可按轻仓或首笔计划试错。";
    reason = `${watchName} 接近支撑位 ${support}，更适合按计划低吸而不是追高。`;
  } else if (changePct <= -3 || totalScore < maxRiskAlertScore) {
    severity = "medium";
    signal = "风险降温";
    action = "缩回观察仓，暂停加仓，等待新的趋势确认。";
    reason = `${watchName} 当前涨跌幅 ${round(changePct, 1)}%，策略评分 ${totalScore}，风险收益比在下降。`;
  } else if (changePct >= 4 && totalScore >= preferredScore - 3) {
    severity = "low";
    signal = "情绪走强";
    action = "加入机会观察列表，等待更明确的突破确认。";
    reason = `${watchName} 当日强势，但还需要确认不是单日脉冲。`;
  }

  return {
    code: analysis.stock.code,
    name: analysis.stock.name,
    price,
    changePct,
    totalScore,
    support,
    resistance,
    signal,
    severity,
    action,
    reason,
    stance: analysis.snapshot.stance,
    updatedAt: new Date().toISOString()
  };
}

async function monitorStocks(items = []) {
  const results = [];

  for (const item of items) {
    const code = normalizeCode(item.code || item.query || "");
    if (!code) continue;
    const stock = await buildLiveProfileByCode(code);
    if (!stock) {
      results.push({
        code,
        name: item.name || code,
        severity: "error",
        signal: "未找到股票",
        action: "请检查代码或名称。",
        reason: "监控项未命中股票检索。",
        updatedAt: new Date().toISOString()
      });
      continue;
    }

    const analysis = analyzeStock(stock);
    results.push(evaluateMonitor(analysis, item));
  }

  return results;
}

module.exports = {
  analyzeStock,
  findStock,
  listStocks: localListStocks,
  monitorStocks,
  normalizeCode,
  peDigestion,
  calcPeg,
  forwardPe,
  searchStocks
};
