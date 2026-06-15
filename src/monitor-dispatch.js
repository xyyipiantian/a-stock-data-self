const { monitorStocks } = require("./strategy-engine");
const { createServiceSupabase } = require("./supabase-server");

const DEDUPE_MINUTES = 45;

function buildWebhookMessage(alert) {
  return [
    `${alert.name} ${alert.code} · ${alert.signal}`,
    `价格 ${alert.price} (${alert.changePct > 0 ? "+" : ""}${alert.changePct.toFixed(1)}%)`,
    `评分 ${alert.totalScore} · 观点 ${alert.stance}`,
    `原因：${alert.reason}`,
    `建议：${alert.action}`
  ].join("\n");
}

async function sendFeishuWebhook(webhookUrl, alert) {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      msg_type: "text",
      content: {
        text: buildWebhookMessage(alert)
      }
    })
  });
  if (!response.ok) {
    throw new Error(`Feishu webhook failed: HTTP ${response.status}`);
  }
}

async function sendWecomWebhook(webhookUrl, alert) {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      msgtype: "text",
      text: {
        content: buildWebhookMessage(alert)
      }
    })
  });
  if (!response.ok) {
    throw new Error(`WeCom webhook failed: HTTP ${response.status}`);
  }
}

async function dispatchChannel(channel, alert) {
  if (channel.provider === "feishu") {
    await sendFeishuWebhook(channel.webhook_url, alert);
    return;
  }
  if (channel.provider === "wecom") {
    await sendWecomWebhook(channel.webhook_url, alert);
    return;
  }
  throw new Error(`Unsupported channel provider: ${channel.provider}`);
}

function isDedupeBlocked(previousSignalAt) {
  if (!previousSignalAt) return false;
  const last = new Date(previousSignalAt).getTime();
  if (!Number.isFinite(last)) return false;
  return Date.now() - last < DEDUPE_MINUTES * 60 * 1000;
}

async function runAlertDispatch() {
  const supabase = createServiceSupabase();
  if (!supabase) {
    return {
      ok: false,
      message: "Supabase service role is not configured.",
      dispatched: 0,
      skipped: 0
    };
  }

  const [{ data: watchlists, error: watchError }, { data: channels, error: channelError }] = await Promise.all([
    supabase.from("watchlists").select("*").eq("active", true),
    supabase.from("notification_channels").select("*").eq("enabled", true)
  ]);

  if (watchError) throw watchError;
  if (channelError) throw channelError;

  const channelMap = new Map();
  for (const channel of channels || []) {
    const list = channelMap.get(channel.user_id) || [];
    list.push(channel);
    channelMap.set(channel.user_id, list);
  }

  let dispatched = 0;
  let skipped = 0;

  for (const watch of watchlists || []) {
    const userChannels = channelMap.get(watch.user_id) || [];
    if (!userChannels.length) {
      skipped += 1;
      continue;
    }

    const [alert] = await monitorStocks([
      {
        code: watch.code,
        name: watch.display_name || watch.name,
        memo: watch.memo || "",
        breakoutPct: watch.breakout_pct,
        pullbackPct: watch.pullback_pct,
        preferredScore: watch.preferred_score,
        maxRiskAlertScore: watch.max_risk_alert_score
      }
    ]);

    if (!alert || alert.severity === "idle" || alert.severity === "error") {
      skipped += 1;
      continue;
    }

    if (watch.last_signal === alert.signal && isDedupeBlocked(watch.last_signal_at)) {
      skipped += 1;
      continue;
    }

    const sentProviders = [];
    for (const channel of userChannels) {
      try {
        await dispatchChannel(channel, alert);
        sentProviders.push(channel.provider);
      } catch (error) {
        sentProviders.push(`${channel.provider}:failed`);
      }
    }

    await supabase.from("watchlists").update({
      last_signal: alert.signal,
      last_signal_at: alert.updatedAt,
      last_severity: alert.severity
    }).eq("id", watch.id);

    await supabase.from("alert_logs").insert({
      user_id: watch.user_id,
      watchlist_id: watch.id,
      code: alert.code,
      name: alert.name,
      signal: alert.signal,
      severity: alert.severity,
      reason: alert.reason,
      action: alert.action,
      stance: alert.stance,
      total_score: alert.totalScore,
      sent_providers: sentProviders,
      raw_payload: alert
    });

    dispatched += 1;
  }

  return {
    ok: true,
    dispatched,
    skipped,
    scanned: (watchlists || []).length
  };
}

module.exports = {
  buildWebhookMessage,
  runAlertDispatch
};
