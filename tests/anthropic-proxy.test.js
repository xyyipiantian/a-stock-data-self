const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildForwardBody,
  buildVisionRequestBody,
  extractTextFromResponseBody,
  hasImageBlocks,
  replaceImagesWithSummary,
  resolveUpstreamUrl,
  shouldBypassVisionPreprocessing
} = require("../src/anthropic-proxy");

test("detects image blocks in anthropic messages", () => {
  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: "帮我看图" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } }
      ]
    }
  ];

  assert.equal(hasImageBlocks(messages), true);
});

test("replaces images with a single summary block", () => {
  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: "第一张" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "def" } }
      ]
    }
  ];

  const result = replaceImagesWithSummary(messages, "这里是图片摘要");
  assert.equal(result[0].content.length, 2);
  assert.equal(result[0].content[1].type, "text");
  assert.match(result[0].content[1].text, /图片预处理结果/);
});

test("builds a vision request that keeps only text and images", () => {
  const original = {
    model: "mimo-v2.5-pro",
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "看一下" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } }
        ]
      }
    ]
  };

  const result = buildVisionRequestBody(original, "mimo-v2-omni", "vision prompt");
  assert.equal(result.model, "mimo-v2-omni");
  assert.equal(result.stream, false);
  assert.equal(result.messages.length, 2);
});

test("bypasses preprocessing for vision-capable requested models", () => {
  const requestBody = {
    model: "mimo-v2-omni",
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } }
        ]
      }
    ]
  };

  const config = {
    preprocessing: { enabled: true },
    upstream: { visionCapableModels: ["mimo-v2-omni"], textModel: "mimo-v2.5-pro" }
  };

  assert.equal(shouldBypassVisionPreprocessing(requestBody, config), true);
});

test("buildForwardBody preserves requested model and injects summary", () => {
  const requestBody = {
    model: "mimo-v2.5-pro",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "解释这张图" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } }
        ]
      }
    ]
  };

  const result = buildForwardBody(requestBody, { upstream: { textModel: "unused" } }, "截图显示了一个报错");
  assert.equal(result.model, "mimo-v2.5-pro");
  assert.equal(result.messages[0].content[1].type, "text");
});

test("extracts merged text from anthropic response blocks", () => {
  const responseBody = {
    content: [
      { type: "text", text: "第一段" },
      { type: "text", text: "第二段" }
    ]
  };

  assert.equal(extractTextFromResponseBody(responseBody), "第一段\n\n第二段");
});

test("resolves upstream url by trimming local base path", () => {
  const config = {
    localBasePath: "/anthropic",
    upstream: { baseUrl: "https://example.com/anthropic" }
  };

  const url = resolveUpstreamUrl(config, "/anthropic/v1/messages", "?beta=true");
  assert.equal(url, "https://example.com/anthropic/v1/messages?beta=true");
});
