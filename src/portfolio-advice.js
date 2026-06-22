function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function classifyAdvice(position, analysis) {
  const currentPrice = Number(analysis?.stock?.price || 0);
  const costBasis = Number(position?.costBasis || 0);
  const totalScore = Number(analysis?.snapshot?.totalScore || 0);
  const supportPrice = Number(analysis?.snapshot?.supportPrice || 0);
  const resistancePrice = Number(analysis?.snapshot?.resistancePrice || 0);
  const pnlPct = costBasis > 0 ? ((currentPrice - costBasis) / costBasis) * 100 : 0;

  if (currentPrice > 0 && supportPrice > 0 && currentPrice < supportPrice) {
    return {
      level: "defensive",
      label: "减仓防守",
      summary: "价格已落到策略支撑位下方，先把满仓思路切回防守。",
      detail: `若反抽不能重新站回 ${supportPrice} 上方，优先把高仓位降下来，等待下一次更明确的机会提醒。`
    };
  }

  if (pnlPct <= -15 && totalScore < 60) {
    return {
      level: "defensive",
      label: "优先降仓",
      summary: "当前处于较深回撤，同时规则评分偏弱，不适合继续硬扛满仓。",
      detail: "更稳妥的做法是先释放部分资金，等信号重新转强后再回补。"
    };
  }

  if (currentPrice >= resistancePrice && totalScore >= 70) {
    return {
      level: "watch",
      label: "持有观察",
      summary: "价格已经接近或触达突破区，适合看量价确认，不建议在模拟仓里盲目追高。",
      detail: `若后续能稳住 ${resistancePrice} 一带并维持高评分，再考虑把腾出的资金回补到强势标的。`
    };
  }

  if (totalScore >= 72) {
    return {
      level: "positive",
      label: "继续持有",
      summary: "规则评分仍在偏强区，当前更适合持有并等待下一次明确加速信号。",
      detail: `支撑位参考 ${supportPrice}，只要不明显跌破，模拟仓可以保持跟踪。`
    };
  }

  if (totalScore >= 60) {
    return {
      level: "neutral",
      label: "观察等待",
      summary: "结构还没完全走坏，但也没有强到适合加仓的程度。",
      detail: `先围绕 ${supportPrice} 到 ${resistancePrice} 的区间观察，等规则分数再抬升。`
    };
  }

  return {
    level: "defensive",
    label: "控制仓位",
    summary: "当前评分偏弱，策略更倾向于把仓位留给更强的机会。",
    detail: "如果后续机会池出现更高分标的，优先考虑轮动，而不是在弱势票里继续加码。"
  };
}

function enrichPortfolioPosition(position, analysis) {
  const shares = Number(position?.shares || 0);
  const costBasis = Number(position?.costBasis || 0);
  const currentPrice = Number(analysis?.stock?.price || 0);
  const marketValue = round(shares * currentPrice);
  const costValue = round(shares * costBasis);
  const pnlAmount = round(marketValue - costValue);
  const pnlPct = costBasis > 0 ? round(((currentPrice - costBasis) / costBasis) * 100, 1) : 0;
  const advice = classifyAdvice(position, analysis);

  return {
    id: position.id || null,
    code: analysis.stock.code,
    name: analysis.stock.name,
    shares,
    costBasis,
    notes: position.notes || "",
    currentPrice,
    marketValue,
    costValue,
    pnlAmount,
    pnlPct,
    stance: analysis.snapshot.stance,
    totalScore: analysis.snapshot.totalScore,
    supportPrice: analysis.snapshot.supportPrice,
    resistancePrice: analysis.snapshot.resistancePrice,
    actionPlan: analysis.plan || [],
    candidates: (analysis.candidates || []).slice(0, 2),
    advice,
    updatedAt: new Date().toISOString()
  };
}

function summarizePortfolio(positions) {
  const summary = positions.reduce(
    (acc, item) => {
      acc.marketValue += Number(item.marketValue || 0);
      acc.costValue += Number(item.costValue || 0);
      acc.pnlAmount += Number(item.pnlAmount || 0);
      if ((item.advice?.level || "") === "positive") acc.positiveCount += 1;
      if ((item.advice?.level || "") === "defensive") acc.defensiveCount += 1;
      return acc;
    },
    {
      marketValue: 0,
      costValue: 0,
      pnlAmount: 0,
      positiveCount: 0,
      defensiveCount: 0
    }
  );

  summary.marketValue = round(summary.marketValue);
  summary.costValue = round(summary.costValue);
  summary.pnlAmount = round(summary.pnlAmount);
  summary.pnlPct = summary.costValue > 0 ? round((summary.pnlAmount / summary.costValue) * 100, 1) : 0;
  return summary;
}

module.exports = {
  classifyAdvice,
  enrichPortfolioPosition,
  summarizePortfolio
};
