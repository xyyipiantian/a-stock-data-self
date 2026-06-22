import { createClient } from "https://esm.sh/@supabase/supabase-js@2.53.0";

const state = {
  stocks: [],
  activeStock: null,
  currentAnalysis: null,
  watchlist: [],
  alerts: [],
  portfolio: [],
  portfolioInsights: [],
  portfolioTrades: [],
  portfolioBriefing: null,
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
const LAST_STOCK_KEY = "alpha-lens-last-stock-v1";
const PORTFOLIO_KEY = "alpha-lens-portfolio-v1";
const PORTFOLIO_TRADES_KEY = "alpha-lens-portfolio-trades-v1";

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

function watchStatusCopy(item) {
  const breakoutPct = item.breakoutPct ?? 0.8;
  const pullbackPct = item.pullbackPct ?? 1.5;
  const preferredScore = item.preferredScore ?? 68;

  if (item.lastSeverity === "high") {
    return "已触发突破提醒，说明价格与评分同时满足偏强条件，优先看放量确认。";
  }
  if (item.lastSeverity === "medium") {
    return "已触发中优先提醒，通常代表接近支撑试仓区，或者策略评分开始降温。";
  }
  if (item.lastSeverity === "low") {
    return "已进入观察状态，说明当日有走强迹象，但还没强到正式突破。";
  }
  if (item.lastSeverity === "error") {
    return "本轮扫描没拿到有效行情，建议稍后重试，或点“查看实时策略”核对当前数据源。";
  }
  return `当前待机，表示还没突破 ${breakoutPct}% 阈值，也没回踩到 ${pullbackPct}% 观察区，系统继续等待更明确的信号；目标分数线 ${preferredScore}。`;
}

function cloudEnabled() {
  return Boolean(state.auth.client && state.auth.user);
}

function opportunityAlertsEnabled() {
  return Boolean(state.auth.config?.opportunityAlertsEnabled);
}

function getChinaTradingWindowState(now = new Date()) {
  const chinaNow = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
  const day = chinaNow.getDay();
  if (day === 0 || day === 6) {
    return { open: false, label: "周末休市" };
  }

  const minutes = chinaNow.getHours() * 60 + chinaNow.getMinutes();
  const inMorning = minutes >= 9 * 60 + 15 && minutes <= 11 * 60 + 30;
  const inAfternoon = minutes >= 13 * 60 && minutes <= 15 * 60;
  if (inMorning || inAfternoon) {
    return { open: true, label: "交易时段" };
  }

  if (minutes > 11 * 60 + 30 && minutes < 13 * 60) {
    return { open: false, label: "午间休市" };
  }

  return { open: false, label: "非交易时段" };
}

function persistLocalWatchlist() {
  localStorage.setItem(WATCHLIST_KEY, JSON.stringify(state.watchlist));
}

function persistLocalAlerts() {
  localStorage.setItem(ALERT_LOG_KEY, JSON.stringify(state.alerts.slice(0, 30)));
}

function persistLocalPortfolio() {
  localStorage.setItem(PORTFOLIO_KEY, JSON.stringify(state.portfolio));
}

function persistLocalPortfolioTrades() {
  localStorage.setItem(PORTFOLIO_TRADES_KEY, JSON.stringify(state.portfolioTrades.slice(0, 50)));
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
  try {
    state.portfolio = JSON.parse(localStorage.getItem(PORTFOLIO_KEY) || "[]");
  } catch {
    state.portfolio = [];
  }
  try {
    state.portfolioTrades = JSON.parse(localStorage.getItem(PORTFOLIO_TRADES_KEY) || "[]");
  } catch {
    state.portfolioTrades = [];
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

function mapDbPortfolioPosition(row) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    shares: Number(row.shares),
    costBasis: Number(row.cost_basis),
    notes: row.notes || ""
  };
}

function mapDbPortfolioTrade(row) {
  return {
    id: row.id,
    positionId: row.position_id,
    code: row.code,
    name: row.name,
    action: row.action,
    shares: Number(row.shares),
    price: Number(row.price),
    note: row.note || "",
    createdAt: row.created_at
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
    await refreshPortfolioInsights();
    renderPortfolioTrades();
    renderChannels();
    return;
  }

  const [watchRes, alertRes, channelRes, portfolioRes, tradeRes] = await Promise.all([
    state.auth.client.from("watchlists").select("*").order("created_at", { ascending: false }),
    state.auth.client.from("alert_logs").select("*").order("created_at", { ascending: false }).limit(20),
    state.auth.client.from("notification_channels").select("*"),
    state.auth.client.from("portfolio_positions").select("*").order("updated_at", { ascending: false }),
    state.auth.client.from("portfolio_trades").select("*").order("created_at", { ascending: false }).limit(20)
  ]);

  var cloudWatchlist = (watchRes.data || []).map(mapDbWatchlist);
    var cloudCodes = new Set(cloudWatchlist.map(function(x) { return x.code; }));
    try { var localItems = JSON.parse(localStorage.getItem(WATCHLIST_KEY) || "[]"); } catch(e) { localItems = []; }
    localItems.forEach(function(item) {
      if (!cloudCodes.has(item.code)) {
        state.auth.client.from("watchlists").insert({
          user_id: state.auth.user.id,
          code: item.code,
          name: item.name,
          memo: item.memo || "",
          breakout_pct: item.breakoutPct || 0.8,
          pullback_pct: item.pullbackPct || 1.5,
          preferred_score: item.preferredScore || 64,
          max_risk_alert_score: item.maxRiskAlertScore || 60
        }).then();
      }
    });
    state.watchlist = cloudWatchlist.concat(localItems.filter(function(x) { return !cloudCodes.has(x.code); }));
  state.alerts = (alertRes.data || []).map(mapDbAlert);
  state.portfolio = (portfolioRes.data || []).map(mapDbPortfolioPosition);
  state.portfolioTrades = (tradeRes.data || []).map(mapDbPortfolioTrade);
  state.channels = {
    feishu: channelRes.data?.find((item) => item.provider === "feishu")?.webhook_url || "",
    wecom: channelRes.data?.find((item) => item.provider === "wecom")?.webhook_url || ""
  };

  renderWatchlist();
  renderOpportunityLog();
  renderAlertStrip();
  await refreshPortfolioInsights();
  renderPortfolioTrades();
  renderChannels();
}

function renderAuth() {
  const config = state.auth.config;
  const user = state.auth.user;
  const signInGoogleButton = $("#signInGoogleButton");
  const signInGithubButton = $("#signInGithubButton");
  const signOutButton = $("#signOutButton");

  if (!config?.authEnabled) {
    $("#topAuthLabel").textContent = "本地模式";
    signInGoogleButton.hidden = true;
    signInGithubButton.hidden = true;
    signOutButton.hidden = true;
    return;
  }

  if (!user) {
    $("#topAuthLabel").textContent = "可注册登录";
    signInGoogleButton.hidden = false;
    signInGithubButton.hidden = false;
    signOutButton.hidden = true;
    return;
  }

  const avatar = user.user_metadata?.avatar_url || user.user_metadata?.picture || "";
  const displayName = user.user_metadata?.full_name || user.user_metadata?.name || user.email || "???";
  const userLabel = avatar
    ? `<img src="${escapeHtml(avatar)}" style="width:24px;height:24px;border-radius:50%;vertical-align:middle;margin-right:8px" /><span style="vertical-align:middle">${escapeHtml(displayName)}</span>`
    : escapeHtml(displayName);
  $("#topAuthLabel").innerHTML = userLabel;
  signInGoogleButton.hidden = true;
  signInGithubButton.hidden = true;
  signOutButton.hidden = false;
}

function renderChannels() {
  if (!opportunityAlertsEnabled()) {
    $("#feishuWebhookInput").value = state.channels.feishu || "";
    $("#wecomWebhookInput").value = state.channels.wecom || "";
    $("#channelStatus").textContent = "机会提醒当前已关闭，飞书 / 企业微信渠道暂不发送机会监控消息。";
    return;
  }
  $("#feishuWebhookInput").value = state.channels.feishu || "";
  $("#wecomWebhookInput").value = state.channels.wecom || "";
  $("#channelStatus").textContent = cloudEnabled()
    ? "当前已登录。保存后，这两个机器人渠道会只属于你的账号；只要网页开着，新的盯盘提醒会同步推送到你的机器人。"
    : "登录后可保存自己的飞书 / 企业微信提醒。";
}

function buildWebhookMessage(title, lines) {
  return [title, ...lines].join("\n");
}

async function sendFeishuWebhook(webhookUrl, text) {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      msg_type: "text",
      content: {
        text
      }
    })
  });
  if (!response.ok) {
    throw new Error(`Feishu webhook failed: HTTP ${response.status}`);
  }
}

async function sendWecomWebhook(webhookUrl, text) {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      msgtype: "text",
      text: {
        content: text
      }
    })
  });
  if (!response.ok) {
    throw new Error(`WeCom webhook failed: HTTP ${response.status}`);
  }
}

async function sendChannelTestMessages(feishu, wecom) {
  const sent = [];
  const failed = [];
  const text = buildWebhookMessage("Alpha Lens 提醒渠道已开通", [
    "这是一条测试消息。",
    "后续只要网页保持打开，新的机会盯盘提醒会同步推送到这里。"
  ]);

  if (feishu) {
    try {
      await sendFeishuWebhook(feishu, text);
      sent.push("飞书");
    } catch (error) {
      failed.push(`飞书：${error.message}`);
    }
  }

  if (wecom) {
    try {
      await sendWecomWebhook(wecom, text);
      sent.push("企业微信");
    } catch (error) {
      failed.push(`企业微信：${error.message}`);
    }
  }

  return { sent, failed };
}

async function notifyChannelsForAlert(alert) {
  if (!opportunityAlertsEnabled()) return;
  const tasks = [];
  const text = buildWebhookMessage(`${alert.name} ${alert.code} · ${alert.signal}`, [
    `价格 ${formatPrice(alert.price)} (${formatPct(alert.changePct)})`,
    `评分 ${alert.totalScore} · 观点 ${alert.stance}`,
    `原因：${alert.reason}`,
    `建议：${alert.action}`
  ]);

  if (state.channels.feishu) {
    tasks.push(sendFeishuWebhook(state.channels.feishu, text));
  }
  if (state.channels.wecom) {
    tasks.push(sendWecomWebhook(state.channels.wecom, text));
  }

  if (!tasks.length) return;
  await Promise.allSettled(tasks);
}

async function signIn(provider) {
  if (!state.auth.config?.supabaseUrl) return;
  var base = state.auth.config.supabaseUrl.replace(/\/+$/, "");
  var redirect = encodeURIComponent(window.location.href.split("#")[0]);
  window.location.href = base + "/auth/v1/authorize?provider=" + provider + "&redirect_to=" + redirect;
}
async function signOut() {
  if (!state.auth.client) return;
  await state.auth.client.auth.signOut();
  loadLocalState();
  renderAuth();
  renderWatchlist();
  renderOpportunityLog();
  await refreshPortfolioInsights();
  renderPortfolioTrades();
  renderChannels();
}

async function saveChannels(event) {
  event.preventDefault();
  if (!opportunityAlertsEnabled()) {
    $("#channelStatus").textContent = "机会提醒当前已关闭，不需要再配置飞书 / 企业微信。";
    return;
  }
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
  const result = await sendChannelTestMessages(feishu, wecom);
  if (result.failed.length && !result.sent.length) {
    $("#channelStatus").textContent = `提醒渠道已保存，但测试消息发送失败：${result.failed.join("；")}`;
    return;
  }
  if (result.failed.length) {
    $("#channelStatus").textContent = `提醒渠道已保存。测试消息已发送到 ${result.sent.join("、")}；${result.failed.join("；")}`;
    return;
  }
  $("#channelStatus").textContent = result.sent.length
    ? `提醒渠道已保存，测试消息已发送到 ${result.sent.join("、")}。后续新的盯盘提醒会在网页显示时同步推送。`
    : "提醒渠道已保存。";
}

function renderQuickPicks() { return; /* disabled - no stock pool */
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
      const label = button.textContent.split(" · ").slice(0, 2).join(" ");
      $("#stockQuery").value = label.trim();
      analyze(button.dataset.code);
    });
  });
}

function renderPortfolioSuggestions(stocks) {
  const container = $("#portfolioSuggestionList");
  container.innerHTML = stocks.length
    ? stocks
        .map(
          (stock) =>
            `<button class="suggestion-chip" type="button" data-code="${stock.code}" data-name="${escapeHtml(stock.name)}">${stock.code} · ${escapeHtml(stock.name)} · ${escapeHtml(stock.sector)}</button>`
        )
        .join("")
    : "";

  container.querySelectorAll(".suggestion-chip").forEach((button) => {
    button.addEventListener("click", () => {
      $("#portfolioCodeInput").value = `${button.dataset.code} / ${button.dataset.name}`;
      renderPortfolioSuggestions([]);
      $("#portfolioStatus").textContent = `已选中 ${button.dataset.name} ${button.dataset.code}，继续填写股数和成本即可。`;
    });
  });
}

function renderSummary(data) {
  const sourceLabel = data.meta.source === "live-quote" ? "实时行情" : "样本兜底";
  $("#stockTitle").textContent = `${data.stock.name} ${data.stock.code}`;
  $("#stockPrice").textContent = formatPrice(data.stock.price);
  $("#stockChange").textContent = formatPct(data.stock.dayChangePct);
  $("#stockChange").className = data.stock.dayChangePct >= 0 ? "price-up" : "price-down";
  $("#stockSector").textContent = `${data.stock.sector} · ${data.snapshot.stance}`;
  $("#dataSourceNote").textContent = data.meta.warning
    ? `${sourceLabel} · 来源 ${data.meta.provider} · ${data.meta.warning}`
    : `${sourceLabel} · 来源 ${data.meta.provider}`;
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
  if (!opportunityAlertsEnabled()) {
    $("#alertStrip").hidden = true;
    return;
  }
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

async function openStockAnalysis(code) {
  if (!code) return;
  $("#stockQuery").value = code;
  await analyze(code);
  $("#analysisSection")?.scrollIntoView({
    behavior: "smooth",
    block: "start"
  });
}

function renderWatchlist() {
  if (!opportunityAlertsEnabled()) {
    $("#watchlist").innerHTML = `<div class="empty-state">机会提醒已关闭，当前页面改为以模拟仓和每日发言为主。</div>`;
    $("#monitorStatus").textContent = "机会提醒已关闭";
    return;
  }
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
              <p class="watch-status-copy">${escapeHtml(watchStatusCopy(item))}</p>
              <div class="watch-item-actions">
                <button data-action="analyze" data-code="${item.code}">查看实时策略</button>
                <button data-action="remove" data-code="${item.code}">移除</button>
              </div>
            </article>
          `
        )
        .join("")
    : `<div class="empty-state">${cloudEnabled() ? "你的云端自选监控还是空的。先查一只股票，再点“加入当前股票”。" : "还没有自选监控项。先查询一只股票，再点“加入当前股票”。"}</div>`;

  document.querySelectorAll(".watch-item-actions button").forEach((button) => {
    if (button.dataset.action === "analyze") {
      button.addEventListener("click", async () => {
        await openStockAnalysis(button.dataset.code);
      });
    } else {
      button.addEventListener("click", () => removeWatch(button.dataset.code));
    }
  });
}

function renderOpportunityLog() {
  if (!opportunityAlertsEnabled()) {
    $("#opportunityLog").innerHTML = `<div class="empty-state">机会提醒已关闭，不再记录这类弱信号日志。</div>`;
    return;
  }
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
              <p><button class="secondary-button compact log-analyze-button" data-code="${item.code}">查看这只股票策略</button></p>
              <p class="position-footnote">${new Date(item.updatedAt).toLocaleString("zh-CN")}</p>
            </article>
          `
        )
        .join("")
    : `<div class="empty-state">${cloudEnabled() ? "云端提醒日志会沉淀在这里，便于复盘每个人自己的机会与风险。" : "监控提醒会在这里沉淀，便于复盘最近出现过哪些机会和风险。"}</div>`;

  document.querySelectorAll(".log-analyze-button").forEach((button) => {
    button.addEventListener("click", async () => {
      await openStockAnalysis(button.dataset.code);
    });
  });
}

function formatSignedMoney(value) {
  const number = Number(value || 0);
  return `${number >= 0 ? "+" : "-"}${Math.abs(number).toFixed(2)}`;
}

function renderPortfolioSummary() {
  const validItems = state.portfolioInsights.filter((item) => !item.error);
  const totals = validItems.reduce(
    (acc, item) => {
      acc.marketValue += Number(item.marketValue || 0);
      acc.costValue += Number(item.costValue || 0);
      acc.pnlAmount += Number(item.pnlAmount || 0);
      acc.defensiveCount += item.advice?.level === "defensive" ? 1 : 0;
      return acc;
    },
    { marketValue: 0, costValue: 0, pnlAmount: 0, defensiveCount: 0 }
  );
  const pnlPct = totals.costValue > 0 ? (totals.pnlAmount / totals.costValue) * 100 : 0;
  const strongest = [...validItems].sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0))[0];
  const weakest = [...validItems].sort((a, b) => (a.totalScore || 0) - (b.totalScore || 0))[0];

  $("#portfolioSummary").innerHTML = `
    <article class="portfolio-summary-card">
      <span class="section-label">持仓数量</span>
      <strong>${validItems.length}</strong>
      <p class="position-footnote">${validItems.length ? `当前跟踪 ${validItems.map((item) => item.name).slice(0, 2).join("、")}${validItems.length > 2 ? " 等" : ""}` : "先录入第一笔持仓"}</p>
    </article>
    <article class="portfolio-summary-card">
      <span class="section-label">持仓市值</span>
      <strong>${formatPrice(totals.marketValue)}</strong>
    </article>
    <article class="portfolio-summary-card">
      <span class="section-label">持仓成本</span>
      <strong>${formatPrice(totals.costValue)}</strong>
    </article>
    <article class="portfolio-summary-card">
      <span class="section-label">浮动盈亏</span>
      <strong class="${totals.pnlAmount >= 0 ? "price-up" : "price-down"}">${formatSignedMoney(totals.pnlAmount)}</strong>
      <p class="position-footnote">${formatPct(pnlPct)}</p>
    </article>
    <article class="portfolio-summary-card">
      <span class="section-label">防守提示</span>
      <strong>${totals.defensiveCount}</strong>
      <p class="position-footnote">${strongest ? `相对偏强：${strongest.name}` : "当前需重点处理的持仓数量"}</p>
    </article>
    <article class="portfolio-summary-card">
      <span class="section-label">关注对象</span>
      <strong>${weakest ? weakest.name : "-"}</strong>
      <p class="position-footnote">${weakest ? `当前总分 ${weakest.totalScore?.toFixed(1)}` : "等待持仓录入后生成"}</p>
    </article>
  `;
}

function renderPortfolioList() {
  $("#portfolioList").innerHTML = state.portfolioInsights.length
    ? state.portfolioInsights
        .map((item) => {
          if (item.error) {
            return `
              <article class="portfolio-item">
                <div class="portfolio-item-head">
                  <div>
                    <strong>${escapeHtml(item.name || item.code)}</strong>
                    <p>${escapeHtml(item.code)}</p>
                  </div>
                  <span class="severity-pill severity-error">异常</span>
                </div>
                <p>${escapeHtml(item.error)}</p>
              </article>
            `;
          }

            return `
              <article class="portfolio-item">
                <div class="portfolio-grid">
                  <div>
                    <div class="portfolio-item-head">
                    <div>
                      <strong>${escapeHtml(item.name)} ${item.code}</strong>
                      <p>${escapeHtml(item.notes || "模拟仓跟踪中")}</p>
                    </div>
                    <span class="severity-pill severity-${item.advice?.level === "defensive" ? "medium" : item.advice?.level === "positive" ? "high" : "low"}">${escapeHtml(item.advice?.label || "观察")}</span>
                  </div>
                    <div class="portfolio-price-row">
                      <strong>${formatPrice(item.currentPrice)}</strong>
                      <span class="${item.pnlAmount >= 0 ? "price-up" : "price-down"}">${formatSignedMoney(item.pnlAmount)} / ${formatPct(item.pnlPct)}</span>
                    </div>
                    <div class="portfolio-metric-grid">
                      <div class="portfolio-metric">
                        <span>持股数量</span>
                        <strong>${item.shares}</strong>
                      </div>
                      <div class="portfolio-metric">
                        <span>持仓成本</span>
                        <strong>${formatPrice(item.costBasis)}</strong>
                      </div>
                      <div class="portfolio-metric">
                        <span>策略总分</span>
                        <strong>${item.totalScore?.toFixed(1)}</strong>
                      </div>
                      <div class="portfolio-metric">
                        <span>当前市值</span>
                        <strong>${formatPrice(item.marketValue)}</strong>
                      </div>
                      <div class="portfolio-metric">
                        <span>支撑位</span>
                        <strong>${formatPrice(item.supportPrice)}</strong>
                      </div>
                      <div class="portfolio-metric">
                        <span>压力位</span>
                        <strong>${formatPrice(item.resistancePrice)}</strong>
                      </div>
                      <div class="portfolio-metric">
                        <span>观点</span>
                        <strong>${escapeHtml(item.stance || "-")}</strong>
                      </div>
                      <div class="portfolio-metric">
                        <span>动作标签</span>
                        <strong>${escapeHtml(item.advice?.label || "观察")}</strong>
                      </div>
                    </div>
                    <div class="portfolio-actions">
                      <button class="primary-adjust" data-action="buy-100" data-code="${item.code}">加仓 100 股</button>
                      <button class="primary-adjust" data-action="sell-100" data-code="${item.code}">减仓 100 股</button>
                      <button data-action="fill-form" data-code="${item.code}">载入到表单</button>
                      <button data-action="analyze" data-code="${item.code}">查看实时策略</button>
                      <button data-action="remove-portfolio" data-code="${item.code}">删除持仓</button>
                    </div>
                </div>
                <div class="portfolio-advice ${escapeHtml(item.advice?.level || "neutral")}">
                  <strong>${escapeHtml(item.advice?.summary || "")}</strong>
                  <p>${escapeHtml(item.advice?.detail || "")}</p>
                  <p class="position-footnote">${escapeHtml((item.actionPlan || []).slice(0, 2).join(" "))}</p>
                </div>
              </div>
            </article>
          `;
          })
          .join("")
    : state.portfolio.length
      ? `<div class="empty-state">持仓已经录入，系统正在同步和计算建议。如果长时间不显示，请点一次“生成今日发言”或刷新页面。</div>`
      : `<div class="empty-state">${cloudEnabled() ? "你的在线模拟仓还是空的。填代码、股数和成本后，就能看到每日建议。" : "本地模拟仓还是空的。先录入一笔持仓，系统就会开始给出建议。"}</div>`;

  document.querySelectorAll("#portfolioList button").forEach((button) => {
    if (button.dataset.action === "analyze") {
      button.addEventListener("click", async () => {
        await openStockAnalysis(button.dataset.code);
      });
      return;
    }
    if (button.dataset.action === "buy-100") {
      button.addEventListener("click", () => quickAdjustPortfolio(button.dataset.code, 100));
      return;
    }
    if (button.dataset.action === "sell-100") {
      button.addEventListener("click", () => quickAdjustPortfolio(button.dataset.code, -100));
      return;
    }
    if (button.dataset.action === "fill-form") {
      button.addEventListener("click", () => loadPortfolioForm(button.dataset.code));
      return;
    }
    button.addEventListener("click", () => removePortfolioPosition(button.dataset.code));
  });
}

function renderPortfolioTrades() {
  const latest = state.portfolioTrades[0];
  $("#portfolioTrades").innerHTML = `
    <article class="portfolio-op-card">
      <strong>你现在可以这样操作模拟仓</strong>
      <p>每只持仓卡片上都支持直接 <code>加仓 100 股</code>、<code>减仓 100 股</code> 和 <code>删除持仓</code>。如果你想精细调整，就先点“载入到表单”，再手动修改股数和成本后保存。</p>
      <p>规则约定：
      加仓会按当前价格重新计算持仓均价；减仓默认只减少股数，不主动改历史持仓成本；减到 0 会自动视为清仓。</p>
      <p>${latest ? `最近一次动作：${escapeHtml(latest.name)} ${latest.code} · ${escapeHtml(latest.action)} · ${new Date(latest.createdAt).toLocaleString("zh-CN")}` : "你保存第一笔持仓后，系统就会开始记录最近一次仓位动作。"}</p>
    </article>
  `;
}

function renderBriefing() {
  const briefing = state.portfolioBriefing;
  if (!briefing) {
    $("#briefingPanel").innerHTML = `<div class="empty-state">录入模拟仓后，点“生成今日发言”，系统会结合市场环境和你的持仓给出今天的操作口径。</div>`;
    return;
  }

  const indexTags = (briefing.market?.indexes || [])
    .map((item) => `<span class="metric-pill">${escapeHtml(item.name)} ${formatPct(item.changePct)}</span>`)
    .join("");

  $("#briefingPanel").innerHTML = `
    <article class="briefing-card">
      <p class="section-label">今日投研发言</p>
      <h3>${escapeHtml(briefing.headline || "今日环境")}</h3>
      <p>${escapeHtml(briefing.overall || "")}</p>
      <div class="tag-list">${indexTags}</div>
    </article>
    <div class="briefing-grid">
      ${(briefing.scripts || [])
        .map(
          (item) => `
            <article class="briefing-script">
              <strong>${escapeHtml(item.name)} ${item.code}</strong>
              <p>${escapeHtml(item.speech)}</p>
            </article>
          `
        )
        .join("")}
    </div>
  `;
}

async function refreshPortfolioInsights() {
  if (!state.portfolio.length) {
    state.portfolioInsights = [];
    state.portfolioBriefing = null;
    renderPortfolioSummary();
    renderBriefing();
    renderPortfolioList();
    return;
  }

  try {
    const items = state.portfolio.map((item) => ({
      id: item.id || null,
      code: item.code,
      name: item.name,
      shares: item.shares,
      costBasis: item.costBasis,
      notes: item.notes || ""
    }));
    const data = await fetchJson(`/api/portfolio/preview?items=${encodeURIComponent(JSON.stringify(items))}`);
    state.portfolioInsights = data.positions || [];
    renderPortfolioSummary();
    renderBriefing();
    renderPortfolioList();
  } catch (error) {
    state.portfolioInsights = state.portfolio.map((item) => ({
      ...item,
      currentPrice: 0,
      marketValue: 0,
      costValue: Number(item.shares || 0) * Number(item.costBasis || 0),
      pnlAmount: 0,
      pnlPct: 0,
      totalScore: 0,
      supportPrice: 0,
      resistancePrice: 0,
      stance: "待同步",
      advice: {
        level: "neutral",
        label: "等待同步",
        summary: "持仓已保存，但实时分析暂时没有返回，稍后会自动补齐。",
        detail: error.message
      },
      actionPlan: []
    }));
    renderPortfolioSummary();
    renderPortfolioList();
    $("#portfolioStatus").textContent = error.message;
  }
}

async function generatePortfolioBriefing() {
  if (!state.portfolio.length) {
    $("#portfolioStatus").textContent = "先录入至少一笔模拟仓持仓，再生成今日发言。";
    return;
  }

  $("#portfolioStatus").textContent = "正在生成今日发言...";

  const items = state.portfolio.map((item) => ({
    id: item.id || null,
    code: item.code,
    name: item.name,
    shares: item.shares,
    costBasis: item.costBasis,
    notes: item.notes || ""
  }));

  const data = await fetchJson(`/api/portfolio/briefing?items=${encodeURIComponent(JSON.stringify(items))}`);
  state.portfolioBriefing = data;
  renderBriefing();
  $("#portfolioStatus").textContent = "今日发言已生成，你现在在线打开网页就能直接看，不用再单独来问。";
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

function findPortfolioPosition(code) {
  return state.portfolio.find((item) => item.code === code);
}

function loadPortfolioForm(code) {
  const item = findPortfolioPosition(code);
  if (!item) return;
  $("#portfolioCodeInput").value = `${item.code} / ${item.name}`;
  $("#portfolioSharesInput").value = item.shares;
  $("#portfolioCostInput").value = item.costBasis;
  $("#portfolioNotesInput").value = item.notes || "";
  $("#portfolioStatus").textContent = `已载入 ${item.name}，你可以直接修改股数或成本后再次保存。`;
}

async function savePortfolioTrade(position, action, note) {
  const trade = {
    id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    positionId: position.id || null,
    code: position.code,
    name: position.name,
    action,
    shares: Number(position.shares || 0),
    price: Number(position.costBasis || 0),
    note,
    createdAt: new Date().toISOString()
  };

  if (cloudEnabled()) {
    const { error } = await state.auth.client.from("portfolio_trades").insert({
      user_id: state.auth.user.id,
      position_id: trade.positionId,
      code: trade.code,
      name: trade.name,
      action: trade.action,
      shares: trade.shares,
      price: trade.price,
      note: trade.note
    });
    if (error) throw error;
    return;
  }

  state.portfolioTrades.unshift(trade);
  state.portfolioTrades = state.portfolioTrades.slice(0, 50);
  persistLocalPortfolioTrades();
}

async function persistPortfolioPosition(position) {
  state.portfolio = [position].concat(state.portfolio.filter((item) => item.code !== position.code));

  if (cloudEnabled()) {
    const { error } = await state.auth.client.from("portfolio_positions").upsert({
      user_id: state.auth.user.id,
      code: position.code,
      name: position.name,
      shares: position.shares,
      cost_basis: position.costBasis,
      notes: position.notes || ""
    }, {
      onConflict: "user_id,code"
    });
    if (error) throw error;
  } else {
    persistLocalPortfolio();
  }
}

async function quickAdjustPortfolio(code, deltaShares) {
  const existing = findPortfolioPosition(code);
  const insight = state.portfolioInsights.find((item) => item.code === code);
  if (!existing || !insight) {
    $("#portfolioStatus").textContent = "先等待持仓数据加载完成，再进行加减仓。";
    return;
  }

  const nextShares = Math.max(0, Number(existing.shares || 0) + deltaShares);
  if (nextShares === 0) {
    await removePortfolioPosition(code);
    return;
  }

  let nextCostBasis = Number(existing.costBasis || 0);
  if (deltaShares > 0) {
    const currentPrice = Number(insight.currentPrice || existing.costBasis || 0);
    nextCostBasis = ((Number(existing.shares || 0) * Number(existing.costBasis || 0)) + (deltaShares * currentPrice)) / nextShares;
  }

  const updated = {
    ...existing,
    shares: nextShares,
    costBasis: Math.round(nextCostBasis * 100) / 100
  };

  await persistPortfolioPosition(updated);
  await savePortfolioTrade(
    updated,
    "adjust",
    deltaShares > 0 ? `快捷加仓 ${deltaShares} 股` : `快捷减仓 ${Math.abs(deltaShares)} 股`
  );

  if (cloudEnabled()) {
    await syncCloudState();
  } else {
    await refreshPortfolioInsights();
    renderPortfolioTrades();
  }

  $("#portfolioStatus").textContent = `${updated.name} 已${deltaShares > 0 ? "加仓" : "减仓"} ${Math.abs(deltaShares)} 股。`;
  generatePortfolioBriefing().catch(() => {});
}

async function savePortfolioPosition(event) {
  event.preventDefault();

  const rawQuery = $("#portfolioCodeInput").value.trim();
  const query = rawQuery.split("/")[0].trim();
  const shares = Number($("#portfolioSharesInput").value);
  const costBasis = Number($("#portfolioCostInput").value);
  const notes = $("#portfolioNotesInput").value.trim();

  if (!query) {
    $("#portfolioStatus").textContent = "先输入股票代码或名称。";
    return;
  }
  if (!Number.isFinite(shares) || shares <= 0) {
    $("#portfolioStatus").textContent = "持股数量要大于 0。";
    return;
  }
  if (!Number.isFinite(costBasis) || costBasis <= 0) {
    $("#portfolioStatus").textContent = "持仓成本要大于 0。";
    return;
  }

  let analysis;
  try {
    analysis = await fetchJson(`/api/strategy?query=${encodeURIComponent(query)}`);
  } catch (error) {
    $("#portfolioStatus").textContent = error.message;
    return;
  }

  const existing = findPortfolioPosition(analysis.stock.code);
  const position = {
    id: existing?.id || null,
    code: analysis.stock.code,
    name: analysis.stock.name,
    shares,
    costBasis,
    notes
  };

  try {
    await persistPortfolioPosition(position);
  } catch (error) {
    $("#portfolioStatus").textContent = error.message;
    return;
  }

  await savePortfolioTrade(position, existing ? "adjust" : "snapshot", existing ? "更新模拟仓持仓" : "新增模拟仓持仓");

  if (cloudEnabled()) {
    await syncCloudState();
  } else {
    await refreshPortfolioInsights();
    renderPortfolioTrades();
  }

  $("#portfolioStatus").textContent = `${position.name} 已保存到${cloudEnabled() ? "你的在线" : "本地"}模拟仓。`;
  if (state.portfolio.length || cloudEnabled()) {
    generatePortfolioBriefing().catch(() => {});
  }
}

async function removePortfolioPosition(code) {
  const existing = findPortfolioPosition(code);
  if (!existing) return;

  if (cloudEnabled()) {
    const { error } = await state.auth.client.from("portfolio_positions").delete().eq("code", code);
    if (error) {
      $("#portfolioStatus").textContent = error.message;
      return;
    }
  } else {
    state.portfolio = state.portfolio.filter((item) => item.code !== code);
    persistLocalPortfolio();
  }

  await savePortfolioTrade(existing, "close", "从模拟仓移除持仓");

  if (cloudEnabled()) {
    await syncCloudState();
  } else {
    await refreshPortfolioInsights();
    renderPortfolioTrades();
  }

  $("#portfolioStatus").textContent = `${existing.name} 已从模拟仓移除。`;
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
  if (!opportunityAlertsEnabled()) {
    setStatus("机会提醒已关闭，当前建议直接使用模拟仓和今日发言。");
    return;
  }
  let data = state.currentAnalysis;
  if (!data) {
    const query = state.activeStock || $("#stockQuery").value.trim();
    if (!query) {
      setStatus("先查询一只股票，再加入监控");
      return;
    }
    data = await fetchJson(`/api/strategy?query=${encodeURIComponent(query)}`);
    renderAll(data);
    localStorage.setItem(LAST_STOCK_KEY, data.stock.code);
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
  if (!opportunityAlertsEnabled()) return;
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
  if (!opportunityAlertsEnabled()) return;
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
    notifyChannelsForAlert(alert).catch(() => {});
  }
}

async function pollMonitor() {
  if (!opportunityAlertsEnabled()) {
    $("#monitorStatus").textContent = "机会提醒已关闭";
    return;
  }
  if (!state.watchlist.length) {
    renderAlertStrip();
    renderWatchlist();
    return;
  }

  const market = getChinaTradingWindowState();
  if (!market.open) {
    $("#monitorStatus").textContent = `暂停扫描 · ${market.label}`;
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
  if (!opportunityAlertsEnabled()) {
    if (state.monitorTimer) {
      clearInterval(state.monitorTimer);
      state.monitorTimer = null;
    }
    $("#monitorStatus").textContent = "机会提醒已关闭";
    return;
  }
  if (state.monitorTimer) {
    clearInterval(state.monitorTimer);
    state.monitorTimer = null;
  }

  if (enabled) {
    pollMonitor();
    state.monitorTimer = setInterval(pollMonitor, 60_000);
    $("#monitorStatus").textContent = "交易时段每 60 秒扫描一次";
  } else {
    $("#monitorStatus").textContent = "自动监控已暂停";
  }
}

async function analyze(query) {
  const keyword = query || $("#stockQuery").value.trim();
  if (!keyword) {
    setStatus("输入代码或名称，开始生成策略");
    return;
  }
  setStatus(`正在生成 ${keyword} 的策略...`);

  try {
    const data = await fetchJson(`/api/strategy?query=${encodeURIComponent(keyword)}`);
    renderAll(data);
    localStorage.setItem(LAST_STOCK_KEY, data.stock.code);
    setStatus(
      `已完成 ${data.stock.name} 的规则策略分析 · 数据源 ${data.meta.source === "live-quote" ? "实时行情" : "样本兜底"} · 来源 ${data.meta.provider}`
    );
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
  let searchTimer = null;
  let searchAbort = null;
  $("#stockQuery").addEventListener("input", (event) => {
    clearTimeout(searchTimer);
    if (searchAbort) searchAbort.abort();
    searchTimer = setTimeout(async () => {
      const value = event.target.value.trim();
      if (!value) {
        renderSuggestions([]);
        return;
      }
      searchAbort = new AbortController();
      try {
        const response = await fetch(`/api/stocks?query=${encodeURIComponent(value)}`, {
          signal: searchAbort.signal
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || "搜索失败");
        }
        renderSuggestions(data.stocks || []);
      } catch (error) {
        if (error.name !== "AbortError") {
          renderSuggestions([]);
        }
      } finally {
        searchAbort = null;
      }
    }, 120);
  });
}

function bindWatchlist() {
  $("#addWatchButton").addEventListener("click", () => addCurrentToWatchlist().catch((error) => setStatus(error.message)));
  $("#monitorToggle").addEventListener("change", (event) => setMonitorEnabled(event.target.checked));
}

function bindPortfolio() {
  $("#portfolioForm").addEventListener("submit", (event) => {
      savePortfolioPosition(event).catch((error) => {
        $("#portfolioStatus").textContent = error.message;
      });
    });
  let portfolioSearchTimer = null;
  let portfolioSearchAbort = null;
  $("#portfolioCodeInput").addEventListener("input", (event) => {
    clearTimeout(portfolioSearchTimer);
    if (portfolioSearchAbort) portfolioSearchAbort.abort();
    portfolioSearchTimer = setTimeout(async () => {
      const value = event.target.value.trim();
      if (!value) {
        renderPortfolioSuggestions([]);
        return;
      }
      portfolioSearchAbort = new AbortController();
      try {
        const response = await fetch(`/api/stocks?query=${encodeURIComponent(value)}`, {
          signal: portfolioSearchAbort.signal
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || "搜索失败");
        }
        renderPortfolioSuggestions(data.stocks || []);
      } catch (error) {
        if (error.name !== "AbortError") {
          renderPortfolioSuggestions([]);
        }
      } finally {
        portfolioSearchAbort = null;
      }
    }, 120);
  });
  $("#generateBriefingButton").addEventListener("click", () => {
      generatePortfolioBriefing().catch((error) => {
        $("#portfolioStatus").textContent = error.message;
      });
    });
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
    renderBriefing();
    renderPortfolioTrades();
    renderChannels();
    bindSearch();
    bindWatchlist();
    bindPortfolio();
    bindAuth();
    await refreshPortfolioInsights();
    await loadRuntimeConfig();
    await initSupabase();
    await syncCloudState();
    $("#opportunitySection").hidden = !opportunityAlertsEnabled();
    renderAuth();
    await initNotifications();
    // await loadStocks(); // disabled - no stock pool quick picks
    const lastStock = localStorage.getItem(LAST_STOCK_KEY);
    if (lastStock) {
      $("#stockQuery").value = lastStock;
      await analyze(lastStock);
    } else {
      setStatus("输入代码或名称，开始生成策略");
    }
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
