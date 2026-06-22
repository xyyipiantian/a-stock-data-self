const { analyzeStock, findStock, listStocks, monitorStocks, searchStocks } = require("../src/strategy-engine");
const { runAlertDispatch } = require("../src/monitor-dispatch");
const { enrichPortfolioPosition, summarizePortfolio } = require("../src/portfolio-advice");
const { buildPortfolioBriefing } = require("../src/market-briefing");
const { getPublicRuntimeConfig } = require("../src/supabase-server");

function isAuthorizedCronRequest(req, reqUrl) {
  const legacySecret = process.env.MONITOR_CRON_SECRET || "";
  const vercelCronSecret = process.env.CRON_SECRET || "";
  const authHeader = req.headers.authorization || "";
  const providedLegacySecret = req.headers["x-monitor-secret"] || reqUrl.searchParams.get("secret") || "";

  if (vercelCronSecret && authHeader === `Bearer ${vercelCronSecret}`) {
    return true;
  }

  if (legacySecret && providedLegacySecret === legacySecret) {
    return true;
  }

  return !legacySecret && !vercelCronSecret;
}

function jsonResponse(res, statusCode, body) {
  const payload = JSON.stringify(body, null, 2);
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.statusCode = statusCode;
  res.end(payload);
}

async function handleApi(reqUrl, res, req) {
  if (reqUrl.pathname === "/api/stocks") {
    const query = reqUrl.searchParams.get("query") || "";
    const stocks = query ? await searchStocks(query) : listStocks();
    jsonResponse(res, 200, { stocks });
    return true;
  }

  if (reqUrl.pathname === "/api/strategy") {
    const query = reqUrl.searchParams.get("query") || "600519";
    const stock = await findStock(query);
    if (!stock) {
      jsonResponse(res, 404, {
        error: "没有找到匹配股票，请换代码、简称或完整名称再试",
        suggestions: await searchStocks(query)
      });
      return true;
    }

    jsonResponse(res, 200, analyzeStock(stock));
    return true;
  }

  if (reqUrl.pathname === "/api/monitor") {
    const raw = reqUrl.searchParams.get("items") || "[]";
    let items;
    try {
      items = JSON.parse(raw);
    } catch {
      jsonResponse(res, 400, { error: "监控参数格式不正确" });
      return true;
    }

    const alerts = await monitorStocks(Array.isArray(items) ? items : []);
    jsonResponse(res, 200, {
      alerts,
      updatedAt: new Date().toISOString()
    });
    return true;
  }

  if (reqUrl.pathname === "/api/runtime-config") {
    jsonResponse(res, 200, getPublicRuntimeConfig());
    return true;
  }

  if (reqUrl.pathname === "/api/portfolio/preview") {
    const raw = reqUrl.searchParams.get("items") || "[]";
    let items;
    try {
      items = JSON.parse(raw);
    } catch {
      jsonResponse(res, 400, { error: "模拟仓参数格式不正确" });
      return true;
    }

    const positions = await Promise.all(
      (Array.isArray(items) ? items : []).map(async (item) => {
        const stock = await findStock(item.code || item.query || "");
        if (!stock) {
          return {
            id: item.id || null,
            code: item.code || "",
            name: item.name || item.code || "",
            shares: Number(item.shares || 0),
            costBasis: Number(item.costBasis || 0),
            notes: item.notes || "",
            error: "未找到匹配股票"
          };
        }

        return enrichPortfolioPosition(
          {
            id: item.id || null,
            shares: item.shares,
            costBasis: item.costBasis,
            notes: item.notes
          },
          analyzeStock(stock)
        );
      })
    );

    const validPositions = positions.filter((item) => !item.error);
    jsonResponse(res, 200, {
      positions,
      summary: summarizePortfolio(validPositions),
      updatedAt: new Date().toISOString()
    });
    return true;
  }

  if (reqUrl.pathname === "/api/portfolio/briefing") {
    const raw = reqUrl.searchParams.get("items") || "[]";
    let items;
    try {
      items = JSON.parse(raw);
    } catch {
      jsonResponse(res, 400, { error: "投研发言参数格式不正确" });
      return true;
    }

    const briefing = await buildPortfolioBriefing(items);
    jsonResponse(res, 200, {
      ...briefing,
      updatedAt: new Date().toISOString()
    });
    return true;
  }

  if (reqUrl.pathname === "/api/cron/dispatch") {
    if (!isAuthorizedCronRequest(req, reqUrl)) {
      jsonResponse(res, 401, { error: "Unauthorized" });
      return true;
    }

    const result = await runAlertDispatch();
    jsonResponse(res, 200, result);
    return true;
  }

  return false;
}

module.exports = async (req, res) => {
  const reqUrl = new URL(req.url, "http://" + (req.headers.host || "localhost"));

  try {
    if (await handleApi(reqUrl, res, req)) return;
    jsonResponse(res, 404, { error: "Not found" });
  } catch (error) {
    jsonResponse(res, 500, {
      error: error.message,
      stack: process.env.NODE_ENV === "production" ? undefined : error.stack
    });
  }
};
