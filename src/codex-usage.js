const fs = require("fs");
const os = require("os");
const path = require("path");

const pricing = require("../data/pricing.json");

const TOKEN_KEYS = [
  "input_tokens",
  "cached_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens"
];

function defaultCodexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function blankUsage() {
  return {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0
  };
}

function normalizeUsage(raw = {}) {
  const usage = blankUsage();
  for (const key of TOKEN_KEYS) {
    usage[key] = toSafeNumber(raw[key]);
  }
  if (!usage.total_tokens) {
    usage.total_tokens = usage.input_tokens + usage.output_tokens;
  }
  return usage;
}

function addUsage(target, raw) {
  const usage = normalizeUsage(raw);
  for (const key of TOKEN_KEYS) {
    target[key] += usage[key];
  }
  return target;
}

function subtractUsage(total, previous) {
  const next = blankUsage();
  for (const key of TOKEN_KEYS) {
    next[key] = Math.max(0, toSafeNumber(total[key]) - toSafeNumber(previous[key]));
  }
  if (!next.total_tokens) {
    next.total_tokens = next.input_tokens + next.output_tokens;
  }
  return next;
}

function toSafeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function usageSignature(usage) {
  const normalized = normalizeUsage(usage);
  return TOKEN_KEYS.map((key) => normalized[key]).join("|");
}

function normalizeModel(model) {
  const raw = String(model || "unknown").trim();
  const lower = raw.toLowerCase().replace(/^chatgpt\//, "");

  if (pricing.apiUsd[lower]) return lower;
  if (lower.includes("gpt-5.5")) return "gpt-5.5";
  if (lower.includes("gpt-5.4-mini") || lower.includes("gpt-5.4 mini")) return "gpt-5.4-mini";
  if (lower.includes("gpt-5.4")) return "gpt-5.4";
  if (lower.includes("gpt-5.3-codex")) return "gpt-5.3-codex";
  if (lower.includes("gpt-5.2-codex")) return "gpt-5.2-codex";
  if (lower.includes("gpt-5.2")) return "gpt-5.2";

  return lower || "unknown";
}

function getRate(model, tableName = "apiUsd") {
  const table = pricing[tableName] || {};
  return table[normalizeModel(model)] || null;
}

function calculateCost(usage, model, tableName = "apiUsd", contextWindow = 0) {
  const baseRate = getRate(model, tableName);
  const rate =
    tableName === "apiUsd" &&
    baseRate?.longContext &&
    toSafeNumber(contextWindow) >= toSafeNumber(baseRate.longContext.minWindowTokens)
      ? { ...baseRate, ...baseRate.longContext }
      : baseRate;
  if (!rate) {
    return {
      amount: 0,
      known: false,
      uncachedInputTokens: Math.max(0, usage.input_tokens - usage.cached_input_tokens)
    };
  }

  const normalized = normalizeUsage(usage);
  const cached = Math.min(normalized.cached_input_tokens, normalized.input_tokens);
  const uncached = Math.max(0, normalized.input_tokens - cached);
  const amount =
    (uncached * rate.input + cached * rate.cachedInput + normalized.output_tokens * rate.output) / 1_000_000;

  return {
    amount,
    known: true,
    uncachedInputTokens: uncached
  };
}

function listSessionFiles(sessionsRoot) {
  const files = [];

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) {
        files.push(fullPath);
      }
    }
  }

  walk(sessionsRoot);
  return files.sort();
}

function readSessionIndex(codexHome) {
  const indexPath = path.join(codexHome, "session_index.jsonl");
  const byId = new Map();

  if (!fs.existsSync(indexPath)) return byId;

  const lines = fs.readFileSync(indexPath, "utf8").split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    try {
      const item = JSON.parse(line);
      if (item.id) {
        byId.set(item.id, {
          title: item.thread_name || item.title || "",
          updatedAt: item.updated_at || ""
        });
      }
    } catch {
      // Ignore partial or future index rows.
    }
  }

  return byId;
}

function parseSessionFile(filePath, options = {}) {
  const sessionIdFromName =
    path.basename(filePath).match(/rollout-[^-]+-[^-]+-(.+)\.jsonl$/)?.[1] ||
    path.basename(filePath, ".jsonl");
  const session = {
    id: sessionIdFromName,
    filePath,
    fileName: path.basename(filePath),
    title: "",
    cwd: "",
    source: "",
    originator: "",
    model: "unknown",
    reasoningEffort: "",
    createdAt: "",
    updatedAt: "",
    requestCount: 0,
    usage: blankUsage(),
    costUsd: 0,
    codexCredits: 0,
    pricingKnown: true,
    events: []
  };

  let currentModel = "unknown";
  let previousTotal = null;
  const seenTotals = new Set();
  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    if (!line.trim()) continue;

    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }

    const payload = row.payload || {};
    const timestamp = row.timestamp || payload.timestamp || "";

    if (row.type === "session_meta") {
      session.id = payload.id || session.id;
      session.createdAt = payload.timestamp || timestamp || session.createdAt;
      session.updatedAt = payload.timestamp || timestamp || session.updatedAt;
      session.cwd = payload.cwd || session.cwd;
      session.source = payload.source || session.source;
      session.originator = payload.originator || session.originator;
      currentModel = normalizeModel(payload.model || currentModel);
      session.model = currentModel;
      continue;
    }

    if (row.type === "turn_context") {
      currentModel = normalizeModel(payload.model || payload.collaboration_mode?.settings?.model || currentModel);
      session.model = currentModel !== "unknown" ? currentModel : session.model;
      session.cwd = payload.cwd || session.cwd;
      session.reasoningEffort =
        payload.effort || payload.collaboration_mode?.settings?.reasoning_effort || session.reasoningEffort;
      session.updatedAt = timestamp || session.updatedAt;
      continue;
    }

    if (row.type === "event_msg" && payload.type === "token_count" && payload.info) {
      const info = payload.info || {};
      const total = normalizeUsage(info.total_token_usage || {});
      const signature = usageSignature(total);
      if (seenTotals.has(signature)) {
        continue;
      }
      seenTotals.add(signature);

      const usage = info.last_token_usage
        ? normalizeUsage(info.last_token_usage)
        : previousTotal
          ? subtractUsage(total, previousTotal)
          : total;

      previousTotal = total;
      if (!usage.total_tokens) continue;

      const model = normalizeModel(currentModel || session.model);
      const contextWindow = toSafeNumber(info.model_context_window);
      const apiCost = calculateCost(usage, model, "apiUsd", contextWindow);
      const credits = calculateCost(usage, model, "codexCredits");
      const event = {
        timestamp,
        model,
        contextWindow,
        usage,
        costUsd: apiCost.amount,
        codexCredits: credits.amount,
        pricingKnown: apiCost.known && credits.known
      };

      session.events.push(event);
      session.requestCount += 1;
      session.updatedAt = timestamp || session.updatedAt;
      session.model = model !== "unknown" ? model : session.model;
      session.pricingKnown = session.pricingKnown && event.pricingKnown;
      addUsage(session.usage, usage);
      session.costUsd += event.costUsd;
      session.codexCredits += event.codexCredits;
    }
  }

  const indexEntry = options.sessionIndex?.get(session.id);
  if (indexEntry) {
    session.title = indexEntry.title || session.title;
    session.updatedAt = indexEntry.updatedAt || session.updatedAt;
  }
  if (!session.title) {
    session.title = session.fileName.replace(/\.jsonl$/i, "");
  }

  return session;
}

function inRange(timestamp, from, until) {
  if (!timestamp) return true;
  const time = new Date(timestamp).getTime();
  if (!Number.isFinite(time)) return true;
  if (from && time < from.getTime()) return false;
  if (until && time > until.getTime()) return false;
  return true;
}

function toDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function scanCodexUsage(options = {}) {
  const codexHome = options.codexHome || defaultCodexHome();
  const sessionsRoot = options.sessionsRoot || path.join(codexHome, "sessions");
  const from = toDate(options.from);
  const until = toDate(options.until);
  const sessionIndex = readSessionIndex(codexHome);
  const files = listSessionFiles(sessionsRoot);
  const sessions = [];
  const warnings = [];

  if (!fs.existsSync(sessionsRoot)) {
    warnings.push(`Sessions directory not found: ${sessionsRoot}`);
  }

  for (const filePath of files) {
    let parsed;
    try {
      parsed = parseSessionFile(filePath, { sessionIndex });
    } catch (error) {
      warnings.push(`Skipped ${filePath}: ${error.message}`);
      continue;
    }

    const filteredEvents = parsed.events.filter((event) => inRange(event.timestamp, from, until));
    if (!filteredEvents.length) continue;

    const session = {
      ...parsed,
      requestCount: 0,
      usage: blankUsage(),
      costUsd: 0,
      codexCredits: 0,
      pricingKnown: true,
      events: filteredEvents
    };

    for (const event of filteredEvents) {
      session.requestCount += 1;
      addUsage(session.usage, event.usage);
      session.costUsd += event.costUsd;
      session.codexCredits += event.codexCredits;
      session.pricingKnown = session.pricingKnown && event.pricingKnown;
      session.updatedAt = event.timestamp || session.updatedAt;
    }

    sessions.push(session);
  }

  return aggregateSessions({
    codexHome,
    sessionsRoot,
    sessions,
    warnings,
    from: from?.toISOString() || "",
    until: until?.toISOString() || ""
  });
}

function aggregateSessions({ codexHome, sessionsRoot, sessions, warnings, from, until }) {
  const totals = {
    requestCount: 0,
    sessionCount: sessions.length,
    usage: blankUsage(),
    costUsd: 0,
    codexCredits: 0,
    unknownPriceRequestCount: 0
  };
  const modelMap = new Map();
  const dayMap = new Map();

  for (const session of sessions) {
    totals.requestCount += session.requestCount;
    addUsage(totals.usage, session.usage);
    totals.costUsd += session.costUsd;
    totals.codexCredits += session.codexCredits;
    if (!session.pricingKnown) totals.unknownPriceRequestCount += session.requestCount;

    for (const event of session.events) {
      const model = normalizeModel(event.model);
      const modelRow =
        modelMap.get(model) ||
        {
          model,
          label: getRate(model, "apiUsd")?.label || model,
          requestCount: 0,
          sessionIds: new Set(),
          usage: blankUsage(),
          costUsd: 0,
          codexCredits: 0,
          pricingKnown: true
        };
      modelRow.requestCount += 1;
      modelRow.sessionIds.add(session.id);
      addUsage(modelRow.usage, event.usage);
      modelRow.costUsd += event.costUsd;
      modelRow.codexCredits += event.codexCredits;
      modelRow.pricingKnown = modelRow.pricingKnown && event.pricingKnown;
      modelMap.set(model, modelRow);

      const dateKey = new Date(event.timestamp || session.updatedAt || Date.now()).toISOString().slice(0, 10);
      const dayRow =
        dayMap.get(dateKey) ||
        {
          date: dateKey,
          requestCount: 0,
          usage: blankUsage(),
          costUsd: 0,
          codexCredits: 0
        };
      dayRow.requestCount += 1;
      addUsage(dayRow.usage, event.usage);
      dayRow.costUsd += event.costUsd;
      dayRow.codexCredits += event.codexCredits;
      dayMap.set(dateKey, dayRow);
    }
  }

  const byModel = [...modelMap.values()]
    .map((row) => ({
      ...row,
      sessionCount: row.sessionIds.size,
      sessionIds: undefined
    }))
    .sort((a, b) => b.costUsd - a.costUsd);

  const byDay = [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date));

  return {
    metadata: {
      generatedAt: new Date().toISOString(),
      codexHome,
      sessionsRoot,
      from,
      until,
      priceUpdatedAt: pricing.updatedAt,
      pricingSources: pricing.sources,
      warnings
    },
    totals,
    byModel,
    byDay,
    sessions: sessions
      .map(({ events, ...session }) => ({
        ...session,
        eventCount: events.length
      }))
      .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0)),
    pricing
  };
}

module.exports = {
  addUsage,
  aggregateSessions,
  blankUsage,
  calculateCost,
  defaultCodexHome,
  getRate,
  listSessionFiles,
  normalizeModel,
  normalizeUsage,
  parseSessionFile,
  pricing,
  scanCodexUsage,
  subtractUsage,
  usageSignature
};
