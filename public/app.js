import { createClient } from "https://esm.sh/@supabase/supabase-js@2.53.0";

const state = {
  stocks: [],
  activeStock: null,
  currentAnalysis: null,
  watchlist: [],
  alerts: [],
  channels: {
    feishu: "",
    wecom: ""
  },
  monitorTimer: null,
  auth: {
    config: null,
    client: null,
    user: null
  }
};

const WATCHLIST_KEY = "alpha-lens-watchlist-v1";
const ALERT_LOG_KEY = "alpha-lens-alert-log-v1";

const $ = (selector) => document.querySelector(selector);

function formatPrice(value) {
  return Number(value || 0).toFixed(value >= 100 ? 1 : 2);
}

function formatPct(value) {
  const number = Number(value || 0);
  return `${number > 0 ? "+" : ""}${number.toFixed(1)}%`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function setStatus(text) {
  $("#statusLine").textContent = text;
}

function scoreTone(score) {
  if (score >= 75) return "积极";
  if (score >= 60) return "均衡";
  return "谨慎";
}

function severityLabel(severity) {
  if (severity === "high") return "高优先";
  if (severity === "medium") return "中优先";
  if (severity === "low") return "观察";
  if (severity === "error") return "异常";
  return "待机";
}

function cloudEnabled() {
  return Boolean(state.auth.client && state.auth.user);
}

function persistLocalWatchlist() {
  localStorage.setItem(WATCHLIST_KEY, JSON.stringify(state.watchlist));
}

function persistLocalAlerts() {
  localStorage.setItem(ALERT_LOG_KEY, JSON.stringify(state.alerts.slice(0, 30)));
}

function loadLocalState() {
  try {
    state.watchlist = JSON.parse(localStorage.getItem(WATCHLIST_KEY) || "[]");
  } catch {
    state.watchlist = [];
  }
  try {
    state.alerts = JSON.parse(localStorage.getItem(ALERT_LOG_KEY) || "[]");
  } catch {
    state.alerts = [];
  }
}

function mapDbWatchlist(row) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    memo: row.memo || "",
    breakoutPct: Number(row.breakout_pct),
    pullbackPct: Number(row.pullback_pct),
    preferredScore: Number(row.preferred_score),
    maxRiskAlertScore: Number(row.max_risk_alert_score),
    lastSeverity: row.last_severity || "idle"
  };
}

function mapDbAlert(row) {
  return {
    code: row.code,
    name: row.name,
    signal: row.signal,
    severity: row.severity,
    reason: row.reason,
    action: row.action,
    stance: row.stance,
    totalScore: row.total_score,
    updatedAt: row.created_at
  };
}

async function loadRuntimeConfig() {
  state.auth.config = await fetchJson("/api/runtime-config");
}

async function initSupabase() {
  if (!state.auth.config?.authEnabled) return;
  state.auth.client = createClient(state.auth.config.supabaseUrl, state.auth.config.supabaseAnonKey);
  const {
    data: { session }
  } = await state.auth.client.auth.getSession();
  state.auth.user = session?.user || null;

  state.auth.client.auth.onAuthStateChange(async (_event, sessionValue) => {
    state.auth.user = sessionValue?.user || null;
    await syncCloudState();
    renderAuth();
  });
}

async function syncCloudState() {
  if (!cloudEnabled()) {
    loadLocalState();
    renderWatchlist();
    renderOpportunityLog();
    renderChannels();
    return;
  }

  const [watchRes, alertRes, channelRes] = await Promise.all([
    state.auth.client.from("watchlists").select("*").order("created_at", { ascending: false }),
    state.auth.client.from("alert_logs").select("*").order("created_at", { ascending: false }).limit(20),
    state.auth.client.from("notification_channels").select("*")
  ]);

  state.watchlist = (watchRes.data || []).map(mapDbWatchlist);
  state.alerts = (alertRes.data || []).map(mapDbAlert);
  state.channels = {
    feishu: channelRes.data?.find((item) => item.provider === "feishu")?.webhook_url || "",
    wecom: channelRes.data?.find((item) => item.provider === "wecom")?.webhook_url || ""
  };

  renderWatchlist();
  renderOpportunityLog();
  renderAlertStrip();
  renderChannels();
}

function renderAuth() {
  const config = state.auth.config;
  const user = state.auth.user;
  const signInGoogleButton = $("#signInGoogleButton");
  const signInGithubButton = $("#signInGithubButton");
  const signOutButton = $("#signOutButton");

  if (!config?.authEnabled) {
    $("#authHeadline").textContent = "本地模式";
    $("#authCopy").textContent = "还没配置 Supabase。现在仍可本地使用，但不会有注册登录和云同步。";
    signInGoogleButton.hidden = true;
    signInGithubButton.hidden = true;
    signOutButton.hidden = true;
    return;
  }

  if (!user) {
    $("#authHeadline").textContent = "可注册登录";
    $("#authCopy").textContent = "登录后，每个人会拥有自己的自选监控、提醒渠道和提醒记录，互不干扰。";
    signInGoogleButton.hidden = false;
    signInGithubButton.hidden = false;
    signOutButton.hidden = true;
    return;
  }

  $("#authHeadline").textContent = `${user.email || user.id}`;
  $("#authCopy").textContent = "当前已连接云端账号。你的自选股、飞书/企业微信提醒和提醒日志将只属于你自己。";
  signInGoogleButton.hidden = true;
  signInGithubButton.hidden = true;
  signOutButton.hidden = false;
}

function renderChannels() {
  $("#feishuWebhookInput").value = state.channels.feishu || "";
  $("#wecomWebhookInput").value = state.channels.wecom || "";
  $("#channelStatus").textContent = cloudEnabled()
    ? "当前已登录。保存后，这两个机器人渠道会只属于你的账号。"
    : "登录后可保存自己的飞书 / 企业微信提醒。";
}

async function signIn(provider) {
  if (!state.auth.client) return;
  await state.auth.client.auth.signInWithOAuth({
    provider,
    options: {
      redirectTo: window.location.href
    }
  });
}

async function signOut() {
  if (!state.auth.client) return;
  await state.auth.client.auth.signOut();
  loadLocalState();
  renderAuth();
  renderWatchlist();
  renderOpportunityLog();
  renderChannels();
}

async function saveChannels(event) {
  event.preventDefault();
  if (!cloudEnabled()) {
    $("#channelStatus").textContent = "请先登录，再保存你的提醒渠道。";
    return;
  }

  const feishu = $("#feishuWebhookInput").value.trim();
  const wecom = $("#wecomWebhookInput").value.trim();
  const payloads = [];

  if (feishu) {
    payloads.push({ user_id: state.auth.user.id, provider: "feishu", webhook_url: feishu, enabled: true });
  }
  if (wecom) {
    payloads.push({ user_id: state.auth.user.id, provider: "wecom", webhook_url: wecom, enabled: true });
  }

  for (const provider of ["feishu", "wecom"]) {
    if (!(provider === "feishu" ? feishu : wecom)) {
      await state.auth.client.from("notification_channels").delete().eq("provider", provider);
    }
  }

  if (payloads.length) {
    const { error } = await state.auth.client.from("notification_channels").upsert(payloads, {
      onConflict: "user_id,provider"
    });
    if (error) {
      $("#channelStatus").textContent = error.message;
      return;
    }
  }

  state.channels = { feishu, wecom };
  $("#channelStatus").textContent = "提醒渠道已保存。后续后台轮询会把机会推到你自己的机器人。";
}

function renderQuickPicks() {
  $("#quickPicks").innerHTML = state.stocks
    .slice(0, 6)
    .map(
      (stock) =>
        `<button class="quick-pick" data-code="${stock.code}">${stock.code} · ${escapeHtml(stock.name)}</button>`
    )
    .join("");

  document.querySelectorAll(".quick-pick").forEach((button) => {
    button.addEventListener("click", () => {
      $("#stockQuery").value = button.dataset.code;
      analyze(button.dataset.code);
    });
  });
}

function renderSuggestions(stocks) {
  $("#suggestionList").innerHTML = stocks.length
    ? stocks
        .map(
          (stock) =>
            `<button class="suggestion-chip" data-code="${stock.code}">${stock.code} · ${escapeHtml(stock.name)} · ${escapeHtml(stock.sector)}</button>`
        )
        .join("")
    : "";

  document.querySelectorAll(".suggestion-chip").forEach((button) => {
    button.addEventListener("click", () => {
      $("#stockQuery").value = button.dataset.code;
      analyze(button.dataset.code);
    });
  });
}

function renderSummary(data) {
  $("#stockTitle").textContent = `${data.stock.name} ${data.stock.code}`;
  $("#stockPrice").textContent = formatPrice(data.stock.price);
  $("#stockChange").textContent = formatPct(data.stock.dayChangePct);
  $("#stockChange").className = data.stock.dayChangePct >= 0 ? "price-up" : "price-down";
  $("#stockSector").textContent = `${data.stock.sector} · ${data.snapshot.stance}`;
  $("#stockTags").innerHTML = data.stock.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("");
  $("#stanceBadge").textContent = data.snapshot.stance;
  $("#confidenceText").textContent = `置信度 ${data.snapshot.confidence}`;
  $("#totalScore").textContent = data.snapshot.totalScore.toFixed(1);
  $("#analysisMode").textContent = `${scoreTone(data.snapshot.totalScore)} · 规则引擎`;
  $("#supportPrice").textContent = formatPrice(data.snapshot.supportPrice);
  $("#resistancePrice").textContent = formatPrice(data.snapshot.resistancePrice);
  $("#targetRange").textContent = data.snapshot.targetRange;
  $("#signalList").innerHTML = data.snapshot.signals
    .map((signal) => `<span class="signal-chip">${escapeHtml(signal)}</span>`)
    .join("");
}

function renderThesis(data) {
  const thesisEntries = [
    ["趋势判断", data.thesis.trend],
    ["估值判断", data.thesis.valuation],
    ["催化线索", data.thesis.catalyst],
    ["风险提醒", data.thesis.risk]
  ];

  $("#thesisGrid").innerHTML = thesisEntries
    .map(
      ([title, content]) => `
        <article class="thesis-card">
          <h4>${title}</h4>
          <p>${escapeHtml(content)}</p>
        </article>
      `
    )
    .join("");

  $("#planList").innerHTML = data.plan.map((item) => `<div class="plan-item">${escapeHtml(item)}</div>`).join("");
}

function renderMetrics(data) {
  $("#metricsList").innerHTML = data.snapshot.metrics
    .map(
      (metric) => `
        <div class="metrics-row">
          <span>${escapeHtml(metric.label)}</span>
          <strong>${escapeHtml(metric.value)}</strong>
        </div>
      `
    )
    .join("");
}

function renderPositions(data) {
  $("#positionsGrid").innerHTML = data.positions
    .map(
      (item) => `
        <article class="position-card">
          <div class="position-title">
            <h4>${item.exposure}% 仓位</h4>
            <span>${escapeHtml(item.title)}</span>
          </div>
          <p>${escapeHtml(item.action)}</p>
          <p>${escapeHtml(item.trigger)}</p>
          <p>${escapeHtml(item.guardrail)}</p>
          <p class="position-footnote">${escapeHtml(item.sizing)}</p>
        </article>
      `
    )
    .join("");
}

function renderCandidates(data) {
  $("#candidateList").innerHTML = data.candidates
    .map(
      (item) => `
        <article class="candidate-item">
          <div class="candidate-row">
            <h4>${escapeHtml(item.name)} ${item.code}</h4>
            <span class="candidate-score">${item.score.toFixed(1)}</span>
          </div>
          <p>${escapeHtml(item.reason)}</p>
          <div class="tag-list">${item.tags.map((tag) => `<span class="metric-pill">${escapeHtml(tag)}</span>`).join("")}</div>
        </article>
      `
    )
    .join("");
}

function renderTimeline(data) {
  $("#timeline").innerHTML = data.timeline
    .map(
      (item) => `
        <article class="timeline-item">
          <span class="timeline-date">${escapeHtml(item.date)}</span>
          <div class="timeline-body">
            <strong>${escapeHtml(item.label)}</strong>
            <p>${escapeHtml(item.detail)}</p>
          </div>
        </article>
      `
    )
    .join("");
}

function renderAlertStrip() {
  const topAlert = state.alerts[0];
  const strip = $("#alertStrip");
  if (!topAlert) {
    strip.hidden = true;
    return;
  }
  strip.hidden = false;
  $("#alertHeadline").textContent = `${topAlert.name} · ${topAlert.signal}`;
  $("#alertCopy").textContent = `${topAlert.reason} 建议：${topAlert.action}`;
}

function renderWatchlist() {
  $("#watchlist").innerHTML = state.watchlist.length
    ? state.watchlist
        .map(
          (item) => `
            <article class="watch-item">
              <div class="watch-item-head">
                <div>
                  <strong>${escapeHtml(item.name || item.code)} ${item.code}</strong>
                  <p>${escapeHtml(item.memo || "盯住支撑/突破/风险切换")}</p>
                </div>
                <span class="severity-pill severity-${item.lastSeverity || "idle"}">${severityLabel(item.lastSeverity)}</span>
              </div>
              <div class="tag-list">
                <span class="metric-pill">突破阈值 ${item.breakoutPct ?? 0.8}% </span>
                <span class="metric-pill">回踩容差 ${item.pullbackPct ?? 1.5}% </span>
                <span class="metric-pill">目标分数 ${item.preferredScore ?? 68}</span>
              </div>
              <div class="watch-item-actions">
                <button data-action="analyze" data-code="${item.code}">查看策略</button>
                <button data-action="remove" data-code="${item.code}">移除</button>
              </div>
            </article>
          `
        )
        .join("")
    : `<div class="empty-state">${cloudEnabled() ? "你的云端自选监控还是空的。先查一只股票，再点“加入当前股票”。" : "还没有自选监控项。先查询一只股票，再点“加入当前股票”。"}</div>`;

  document.querySelectorAll(".watch-item-actions button").forEach((button) => {
    if (button.dataset.action === "analyze") {
      button.addEventListener("click", () => {
        $("#stockQuery").value = button.dataset.code;
        analyze(button.dataset.code);
      });
    } else {
      button.addEventListener("click", () => removeWatch(button.dataset.code));
    }
  });
}

function renderOpportunityLog() {
  $("#opportunityLog").innerHTML = state.alerts.length
    ? state.alerts
        .map(
          (item) => `
            <article class="log-item">
              <div class="log-item-head">
                <strong>${escapeHtml(item.name)} · ${escapeHtml(item.signal)}</strong>
                <span class="severity-pill severity-${item.severity || "idle"}">${severityLabel(item.severity)}</span>
              </div>
              <p>${escapeHtml(item.reason)}</p>
              <p>${escapeHtml(item.action)}</p>
              <p class="position-footnote">${new Date(item.updatedAt).toLocaleString("zh-CN")}</p>
            </article>
          `
        )
        .join("")
    : `<div class="empty-state">${cloudEnabled() ? "云端提醒日志会沉淀在这里，便于复盘每个人自己的机会与风险。" : "监控提醒会在这里沉淀，便于复盘最近出现过哪些机会和风险。"}</div>`;
}

function renderAll(data) {
  state.activeStock = data.stock.code;
  state.currentAnalysis = data;
  renderSummary(data);
  renderThesis(data);
  renderMetrics(data);
  renderPositions(data);
  renderCandidates(data);
  renderTimeline(data);
}

async function fetchJson(url) {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) {
    throw Object.assign(new Error(data.error || "请求失败"), { payload: data });
  }
  return data;
}

function findWatch(code) {
  return state.watchlist.find((item) => item.code === code);
}

async function saveWatchToCloud(item) {
  const payload = {
    user_id: state.auth.user.id,
    code: item.code,
    name: item.name,
    memo: item.memo || "",
    breakout_pct: item.breakoutPct ?? 0.8,
    pullback_pct: item.pullbackPct ?? 1.5,
    preferred_score: item.preferredScore ?? 68,
    max_risk_alert_score: item.maxRiskAlertScore ?? 60,
    active: true,
    last_severity: item.lastSeverity || "idle"
  };
  const { error } = await state.auth.client.from("watchlists").upsert(payload, {
    onConflict: "user_id,code"
  });
  if (error) throw error;
  await syncCloudState();
}

async function addCurrentToWatchlist() {
  let data = state.currentAnalysis;
  if (!data) {
    const query = state.activeStock || $("#stockQuery").value.trim();
    if (!query) {
      setStatus("先查询一只股票，再加入监控");
      return;
    }
    data = await fetchJson(`/api/strategy?query=${encodeURIComponent(query)}`);
    renderAll(data);
  }

  if (findWatch(data.stock.code)) {
    setStatus(`${data.stock.name} 已经在自选监控里`);
    return;
  }

  const item = {
    code: data.stock.code,
    name: data.stock.name,
    memo: `${data.stock.sector} · ${data.snapshot.stance}`,
    breakoutPct: 0.8,
    pullbackPct: 1.5,
    preferredScore: Math.max(64, Math.round(data.snapshot.totalScore)),
    maxRiskAlertScore: 60,
    lastSeverity: "idle"
  };

  if (cloudEnabled()) {
    await saveWatchToCloud(item);
  } else {
    state.watchlist.unshift(item);
    persistLocalWatchlist();
    renderWatchlist();
  }

  setStatus(`已把 ${data.stock.name} 加入${cloudEnabled() ? "你的云端" : ""}自选监控`);
  await pollMonitor();
}

async function removeWatch(code) {
  if (cloudEnabled()) {
    const { error } = await state.auth.client.from("watchlists").delete().eq("code", code);
    if (error) {
      setStatus(error.message);
      return;
    }
    await syncCloudState();
    return;
  }

  state.watchlist = state.watchlist.filter((item) => item.code !== code);
  persistLocalWatchlist();
  renderWatchlist();
}

function mergeAlertResult(alert) {
  const existing = state.watchlist.find((item) => item.code === alert.code);
  if (existing) {
    existing.lastSeverity = alert.severity;
  }

  if (alert.severity === "idle") return;

  const last = state.alerts[0];
  const duplicate =
    last &&
    last.code === alert.code &&
    last.signal === alert.signal &&
    Date.now() - new Date(last.updatedAt).getTime() < 45 * 60 * 1000;

  if (!duplicate) {
    state.alerts.unshift(alert);
    state.alerts = state.alerts.slice(0, 30);
    if (!cloudEnabled()) {
      persistLocalAlerts();
    }
    if (alert.severity === "high" && "Notification" in window && Notification.permission === "granted") {
      new Notification(`${alert.name} · ${alert.signal}`, {
        body: alert.action
      });
    }
  }
}

async function pollMonitor() {
  if (!state.watchlist.length) {
    renderAlertStrip();
    renderWatchlist();
    return;
  }

  try {
    const payload = state.watchlist.map((item) => ({
      code: item.code,
      name: item.name,
      memo: item.memo,
      breakoutPct: item.breakoutPct,
      pullbackPct: item.pullbackPct,
      preferredScore: item.preferredScore,
      maxRiskAlertScore: item.maxRiskAlertScore
    }));

    const data = await fetchJson(`/api/monitor?items=${encodeURIComponent(JSON.stringify(payload))}`);
    data.alerts.forEach(mergeAlertResult);
    if (!cloudEnabled()) {
      persistLocalWatchlist();
    }
    renderWatchlist();
    renderOpportunityLog();
    renderAlertStrip();
    $("#monitorStatus").textContent = `最近扫描 ${new Date(data.updatedAt).toLocaleTimeString("zh-CN")} · 共 ${data.alerts.length} 项`;
  } catch (error) {
    $("#monitorStatus").textContent = error.message;
  }
}

function setMonitorEnabled(enabled) {
  if (state.monitorTimer) {
    clearInterval(state.monitorTimer);
    state.monitorTimer = null;
  }

  if (enabled) {
    pollMonitor();
    state.monitorTimer = setInterval(pollMonitor, 60_000);
    $("#monitorStatus").textContent = "每 60 秒扫描一次";
  } else {
    $("#monitorStatus").textContent = "自动监控已暂停";
  }
}

async function analyze(query) {
  const keyword = query || $("#stockQuery").value.trim() || "600519";
  setStatus(`正在生成 ${keyword} 的策略...`);

  try {
    const data = await fetchJson(`/api/strategy?query=${encodeURIComponent(keyword)}`);
    renderAll(data);
    setStatus(`已完成 ${data.stock.name} 的规则策略分析 · 数据源 ${data.meta.source === "live-quote" ? "实时行情" : "本地样本池"}`);
    renderSuggestions([]);
  } catch (error) {
    renderSuggestions(error.payload?.suggestions || []);
    setStatus(error.message);
  }
}

async function loadStocks() {
  const data = await fetchJson("/api/stocks");
  state.stocks = data.stocks;
  renderQuickPicks();
}

function bindSearch() {
  $("#analyzeButton").addEventListener("click", () => analyze());
  $("#stockQuery").addEventListener("keydown", (event) => {
    if (event.key === "Enter") analyze();
  });
  $("#stockQuery").addEventListener("input", async (event) => {
    const value = event.target.value.trim();
    if (!value) {
      renderSuggestions([]);
      return;
    }
    try {
      const data = await fetchJson(`/api/stocks?query=${encodeURIComponent(value)}`);
      renderSuggestions(data.stocks);
    } catch {
      renderSuggestions([]);
    }
  });
}

function bindWatchlist() {
  $("#addWatchButton").addEventListener("click", () => addCurrentToWatchlist().catch((error) => setStatus(error.message)));
  $("#monitorToggle").addEventListener("change", (event) => setMonitorEnabled(event.target.checked));
}

function bindAuth() {
  $("#signInGoogleButton").addEventListener("click", () => signIn("google"));
  $("#signInGithubButton").addEventListener("click", () => signIn("github"));
  $("#signOutButton").addEventListener("click", () => signOut());
  $("#channelForm").addEventListener("submit", (event) => saveChannels(event).catch((error) => {
    $("#channelStatus").textContent = error.message;
  }));
}

async function initNotifications() {
  if (!("Notification" in window)) return;
  if (Notification.permission === "default") {
    try {
      await Notification.requestPermission();
    } catch {
      // Ignore permission issues.
    }
  }
}

async function init() {
  try {
    loadLocalState();
    renderWatchlist();
    renderOpportunityLog();
    renderAlertStrip();
    renderChannels();
    bindSearch();
    bindWatchlist();
    bindAuth();
    await loadRuntimeConfig();
    await initSupabase();
    await syncCloudState();
    renderAuth();
    await initNotifications();
    await loadStocks();
    $("#stockQuery").value = "600519";
    await analyze("600519");
    setMonitorEnabled(true);
  } catch (error) {
    setStatus(error.message);
  }
}

window.__alphaLens = {
  state,
  addCurrentToWatchlist
};

init();
