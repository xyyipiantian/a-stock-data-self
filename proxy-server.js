const http = require("http");
const { Readable } = require("stream");

const {
  buildForwardBody,
  buildVisionRequestBody,
  extractTextFromResponseBody,
  loadConfig,
  redactConfig,
  resolveUpstreamUrl,
  shouldBypassVisionPreprocessing
} = require("./src/anthropic-proxy");

const configFileArg = process.argv.find((arg) => arg.startsWith("--config="));
const configPath = configFileArg ? configFileArg.slice("--config=".length) : "./anthropic-proxy.config.json";
const { config, configPath: resolvedConfigPath } = loadConfig(configPath);

function log(message) {
  console.log(`[anthropic-image-proxy] ${message}`);
}

function writeJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(body, null, 2));
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function buildUpstreamHeaders(req, authToken, payloadBuffer) {
  const headers = { ...req.headers };
  delete headers.host;
  delete headers["content-length"];

  if (authToken) {
    headers["x-api-key"] = authToken;
    headers.authorization = `Bearer ${authToken}`;
  }

  if (!headers["anthropic-version"]) {
    headers["anthropic-version"] = "2023-06-01";
  }

  headers["content-type"] = "application/json";
  headers["content-length"] = Buffer.byteLength(payloadBuffer);
  return headers;
}

async function fetchJson(url, req, authToken, body, timeoutMs) {
  const payloadBuffer = Buffer.from(JSON.stringify(body));
  const response = await fetch(url, {
    method: req.method,
    headers: buildUpstreamHeaders(req, authToken, payloadBuffer),
    body: payloadBuffer,
    signal: AbortSignal.timeout(timeoutMs)
  });
  const responseText = await response.text();
  let responseBody;

  try {
    responseBody = responseText ? JSON.parse(responseText) : {};
  } catch (error) {
    responseBody = { raw: responseText };
  }

  if (!response.ok) {
    const failure = new Error(`Upstream returned ${response.status}`);
    failure.statusCode = response.status;
    failure.responseBody = responseBody;
    throw failure;
  }

  return responseBody;
}

async function proxyResponse(url, req, res, authToken, body, timeoutMs) {
  const payloadBuffer = Buffer.from(JSON.stringify(body));
  const upstreamResponse = await fetch(url, {
    method: req.method,
    headers: buildUpstreamHeaders(req, authToken, payloadBuffer),
    body: payloadBuffer,
    signal: AbortSignal.timeout(timeoutMs)
  });

  const headers = {};
  upstreamResponse.headers.forEach((value, key) => {
    if (key.toLowerCase() !== "content-length") {
      headers[key] = value;
    }
  });

  res.writeHead(upstreamResponse.status, headers);
  if (!upstreamResponse.body) {
    res.end();
    return;
  }

  Readable.fromWeb(upstreamResponse.body).pipe(res);
}

async function handleMessages(req, res, reqBody, targetUrl) {
  const timeoutMs = Number(config.upstream.timeoutMs) || 120000;
  const authToken =
    config.upstream.authToken ||
    req.headers["x-api-key"] ||
    (typeof req.headers.authorization === "string" ? req.headers.authorization.replace(/^Bearer\s+/i, "") : "");

  if (shouldBypassVisionPreprocessing(reqBody, config)) {
    log(`forwarding request without vision preprocessing to ${reqBody.model || config.upstream.textModel}`);
    await proxyResponse(targetUrl, req, res, authToken, reqBody, timeoutMs);
    return;
  }

  log(`image detected, preprocessing with ${config.upstream.visionModel} before forwarding to ${reqBody.model || config.upstream.textModel}`);
  const visionBody = buildVisionRequestBody(
    reqBody,
    config.upstream.visionModel,
    config.preprocessing.visionPrompt
  );
  const visionResponse = await fetchJson(targetUrl, req, authToken, visionBody, timeoutMs);
  const summaryText = extractTextFromResponseBody(visionResponse);
  const forwardBody = buildForwardBody(reqBody, config, summaryText);
  await proxyResponse(targetUrl, req, res, authToken, forwardBody, timeoutMs);
}

async function handleRequest(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (req.method === "GET" && requestUrl.pathname === "/healthz") {
      writeJson(res, 200, {
        ok: true,
        configPath: resolvedConfigPath,
        config: redactConfig(config)
      });
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/config") {
      writeJson(res, 200, {
        configPath: resolvedConfigPath,
        config: redactConfig(config)
      });
      return;
    }

    if (req.method !== "POST") {
      writeJson(res, 405, { error: "Only POST is supported for upstream proxying." });
      return;
    }

    const buffer = await readRequestBody(req);
    const reqBody = buffer.length ? JSON.parse(buffer.toString("utf8")) : {};
    const targetUrl = resolveUpstreamUrl(config, requestUrl.pathname, requestUrl.search);
    await handleMessages(req, res, reqBody, targetUrl);
  } catch (error) {
    writeJson(res, error.statusCode || 500, {
      error: error.message,
      details: error.responseBody || undefined
    });
  }
}

http.createServer(handleRequest).listen(config.localPort, config.localHost, () => {
  log(`running on http://${config.localHost}:${config.localPort}${config.localBasePath}`);
  log(`using config ${resolvedConfigPath}`);
});
