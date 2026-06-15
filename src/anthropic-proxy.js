const fs = require("fs");
const path = require("path");

const DEFAULT_LOCAL_BASE_PATH = "/anthropic";
const DEFAULT_VISION_PROMPT = [
  "你是一个图片转文本预处理器。",
  "请读取用户上传的图片，并输出适合继续交给纯文本模型的结构化摘要。",
  "请优先提取：",
  "1. 图片类型和整体场景",
  "2. 画面中的关键文字（OCR）",
  "3. 关键 UI、报错、表格、代码、图表或对象",
  "4. 与用户问题最相关的线索",
  "输出要求：",
  "- 使用中文",
  "- 简洁但信息完整",
  "- 不要臆测无法确定的内容"
].join("\n");

function defaultConfig() {
  return {
    localPort: 8787,
    localHost: "127.0.0.1",
    localBasePath: DEFAULT_LOCAL_BASE_PATH,
    upstream: {
      baseUrl: "https://token-plan-sgp.xiaomimimo.com/anthropic",
      authToken: "",
      textModel: "mimo-v2.5-pro",
      visionModel: "mimo-v2-omni",
      visionCapableModels: ["mimo-v2-omni"],
      timeoutMs: 120000
    },
    preprocessing: {
      enabled: true,
      injectMode: "replace-image-blocks",
      visionPrompt: DEFAULT_VISION_PROMPT
    }
  };
}

function deepMerge(base, override) {
  if (!override || typeof override !== "object" || Array.isArray(override)) {
    return override === undefined ? base : override;
  }

  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = result[key];
    if (
      current &&
      typeof current === "object" &&
      !Array.isArray(current) &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      result[key] = deepMerge(current, value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function loadConfig(configPath) {
  const resolvedPath = path.resolve(configPath);
  const defaults = defaultConfig();

  if (!fs.existsSync(resolvedPath)) {
    return { config: defaults, configPath: resolvedPath };
  }

  const raw = fs.readFileSync(resolvedPath, "utf8");
  const parsed = JSON.parse(raw);
  return {
    config: deepMerge(defaults, parsed),
    configPath: resolvedPath
  };
}

function toArrayContent(content) {
  if (Array.isArray(content)) {
    return content;
  }
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return [];
}

function isImageBlock(block) {
  return block && typeof block === "object" && block.type === "image";
}

function collectImageBlocks(messages) {
  const images = [];
  let index = 0;

  for (const message of messages || []) {
    const content = toArrayContent(message.content);
    for (const block of content) {
      if (isImageBlock(block)) {
        index += 1;
        images.push({
          index,
          block,
          role: message.role
        });
      }
    }
  }

  return images;
}

function hasImageBlocks(messages) {
  return collectImageBlocks(messages).length > 0;
}

function sanitizeMessagesForVision(messages) {
  const sanitized = [];

  for (const message of messages || []) {
    const content = [];
    for (const block of toArrayContent(message.content)) {
      if (isImageBlock(block)) {
        content.push(block);
      } else if (block && block.type === "text" && block.text) {
        content.push({
          type: "text",
          text: block.text
        });
      }
    }

    if (content.length > 0) {
      sanitized.push({
        role: message.role,
        content
      });
    }
  }

  return sanitized;
}

function buildVisionRequestBody(originalBody, visionModel, visionPrompt) {
  return {
    model: visionModel,
    max_tokens: Math.min(Number(originalBody.max_tokens) || 2048, 2048),
    stream: false,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: visionPrompt
          }
        ]
      },
      ...sanitizeMessagesForVision(originalBody.messages)
    ]
  };
}

function extractTextFromResponseBody(responseBody) {
  const blocks = Array.isArray(responseBody?.content) ? responseBody.content : [];
  const texts = blocks
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text.trim())
    .filter(Boolean);

  return texts.join("\n\n").trim();
}

function buildImageSummaryBlock(summaryText) {
  return {
    type: "text",
    text: [
      "[图片预处理结果]",
      summaryText || "未能从图片中提取有效信息。"
    ].join("\n")
  };
}

function replaceImagesWithSummary(messages, summaryText) {
  let summaryInjected = false;

  return (messages || []).map((message) => {
    const content = toArrayContent(message.content);
    if (content.length === 0) {
      return message;
    }

    const nextContent = [];
    for (const block of content) {
      if (isImageBlock(block)) {
        if (!summaryInjected) {
          nextContent.push(buildImageSummaryBlock(summaryText));
          summaryInjected = true;
        }
      } else {
        nextContent.push(block);
      }
    }

    if (typeof message.content === "string") {
      return {
        ...message,
        content: nextContent
      };
    }

    return {
      ...message,
      content: nextContent
    };
  });
}

function shouldBypassVisionPreprocessing(requestBody, config) {
  if (!config.preprocessing?.enabled) {
    return true;
  }

  if (!hasImageBlocks(requestBody.messages)) {
    return true;
  }

  const requestedModel = requestBody.model || config.upstream.textModel;
  const capableModels = new Set(config.upstream.visionCapableModels || []);
  return capableModels.has(requestedModel);
}

function buildForwardBody(requestBody, config, summaryText) {
  const targetModel = requestBody.model || config.upstream.textModel;
  return {
    ...requestBody,
    model: targetModel,
    messages: replaceImagesWithSummary(requestBody.messages, summaryText)
  };
}

function normalizeBasePath(basePath) {
  if (!basePath || basePath === "/") {
    return "";
  }
  const withLeadingSlash = basePath.startsWith("/") ? basePath : `/${basePath}`;
  return withLeadingSlash.endsWith("/") ? withLeadingSlash.slice(0, -1) : withLeadingSlash;
}

function resolveUpstreamUrl(config, incomingPath, incomingSearch) {
  const upstreamBase = new URL(config.upstream.baseUrl);
  const localBasePath = normalizeBasePath(config.localBasePath || DEFAULT_LOCAL_BASE_PATH);
  const effectivePath = localBasePath && incomingPath.startsWith(localBasePath)
    ? incomingPath.slice(localBasePath.length) || "/"
    : incomingPath;

  upstreamBase.pathname = `${upstreamBase.pathname.replace(/\/$/, "")}${effectivePath.startsWith("/") ? effectivePath : `/${effectivePath}`}`;
  upstreamBase.search = incomingSearch || "";
  return upstreamBase.toString();
}

function redactConfig(config) {
  return {
    ...config,
    upstream: {
      ...config.upstream,
      authToken: config.upstream.authToken ? "***" : ""
    }
  };
}

module.exports = {
  DEFAULT_LOCAL_BASE_PATH,
  buildForwardBody,
  buildVisionRequestBody,
  collectImageBlocks,
  defaultConfig,
  extractTextFromResponseBody,
  hasImageBlocks,
  loadConfig,
  redactConfig,
  replaceImagesWithSummary,
  resolveUpstreamUrl,
  shouldBypassVisionPreprocessing
};
