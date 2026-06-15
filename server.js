const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");

const { analyzeStock, findStock, listStocks, monitorStocks, searchStocks } = require("./src/strategy-engine");
const { runAlertDispatch } = require("./src/monitor-dispatch");
const { getPublicRuntimeConfig } = require("./src/supabase-server");

const rootDir = __dirname;
const publicDir = path.join(rootDir, "public");
const port = Number(process.env.PORT || 3987);
const host = process.env.HOST || "0.0.0.0";

function jsonResponse(res, statusCode, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(payload);
}

function serveStatic(res, pathname) {
  const normalized = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(publicDir, normalized));
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType =
    ext === ".html"
      ? "text/html; charset=utf-8"
      : ext === ".css"
        ? "text/css; charset=utf-8"
        : ext === ".js"
          ? "text/javascript; charset=utf-8"
          : ext === ".json"
            ? "application/json; charset=utf-8"
            : "application/octet-stream";

  res.writeHead(200, {
    "content-type": contentType,
    "cache-control": "no-store"
  });
  fs.createReadStream(filePath).pipe(res);
}

async function handleApi(reqUrl, res) {
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

  if (reqUrl.pathname === "/api/cron/dispatch") {
    const expectedSecret = process.env.MONITOR_CRON_SECRET || "";
    const providedSecret = req.headers["x-monitor-secret"] || reqUrl.searchParams.get("secret") || "";
    if (expectedSecret && providedSecret !== expectedSecret) {
      jsonResponse(res, 401, { error: "Unauthorized" });
      return true;
    }

    const result = await runAlertDispatch();
    jsonResponse(res, 200, result);
    return true;
  }

  return false;
}

async function handleRequest(req, res) {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (await handleApi(reqUrl, res)) return;
    serveStatic(res, reqUrl.pathname);
  } catch (error) {
    jsonResponse(res, 500, {
      error: error.message,
      stack: process.env.NODE_ENV === "production" ? undefined : error.stack
    });
  }
}

async function main() {
  if (process.argv.includes("--dispatch-alerts")) {
    const result = await runAlertDispatch();
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  http.createServer(handleRequest).listen(port, host, () => {
    console.log(`A-share strategy panel running at http://${host}:${port}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
