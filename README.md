# Codex Usage Meter

一个本地 Codex 使用统计面板，用 `~/.codex/sessions` 里的 rollout JSONL 读取 token usage，并换算为 API 等效美元成本和 Codex credits。

## 运行

```powershell
npm start
```

然后打开：

```text
http://127.0.0.1:3987
```

CLI 输出完整 JSON：

```powershell
npm run scan
```

## 统计口径

- 主数据源是 `~/.codex/sessions/**/*.jsonl`。
- 只读取 `event_msg` / `token_count` 里的 `last_token_usage`。
- 同一次请求可能出现多条相同 `total_token_usage`，程序会按 session 去重。
- `cached_input_tokens` 是 `input_tokens` 的子集，成本计算使用：

```text
(input - cached) * input_rate + cached * cached_rate + output * output_rate
```

`reasoning_output_tokens` 已包含在 `output_tokens` 里，不会重复计费。

## 价格来源

价格快照日期：2026-05-07。

- API 美元价格来自 [OpenAI API Pricing](https://openai.com/api/pricing/) 和 [GPT-5.3-Codex model docs](https://developers.openai.com/api/docs/models/gpt-5.3-codex)。
- Codex credits 来自 [Codex rate card](https://help.openai.com/en/articles/20001106-codex-rate-card)。

如果价格变了，改 `data/pricing.json` 后刷新页面即可。

## 云端数据

目前程序不登录账号，也不上传数据。若云端或其他工具能导出 Codex rollout JSONL，可以在页面的“导入”页直接选择文件夹或文件进行本地解析。

## Anthropic Image Proxy

仓库里额外带了一套本地代理，适合给 Claude Code / CC GUI 这种只认 Anthropic Messages 端点的客户端做“图片先转文本，再交给纯文本模型”。

### 运行代理

1. 复制配置模板：

```powershell
Copy-Item anthropic-proxy.config.example.json anthropic-proxy.config.json
```

2. 修改 [anthropic-proxy.config.json](/abs/path/placeholder) 里的上游地址、上游 token、文本模型和视觉模型。
2. 修改项目根目录下的 `anthropic-proxy.config.json`，填上上游地址、上游 token、文本模型和视觉模型。

3. 启动：

```powershell
npm run start:proxy
```

默认监听：

```text
http://127.0.0.1:8787/anthropic
```

### Claude Code / Rider CC GUI 接入

把 `~/.claude/settings.json` 里的：

- `ANTHROPIC_BASE_URL` 改成 `http://127.0.0.1:8787/anthropic`
- `ANTHROPIC_AUTH_TOKEN` 改成任意本地占位值，或者继续填你的真实上游 token

代理会自动处理：

- 纯文本请求：直接转发到 `textModel`
- 包含图片且目标模型不在 `visionCapableModels` 中：先调用 `visionModel` 读图，再把摘要注入原消息，最后交给 `textModel` 或当前请求模型

### 注意

- 代理需要保持运行，CC GUI 才能连上它。
- 如果你想开机常驻，可以再配 Windows 计划任务或 `pm2`。
