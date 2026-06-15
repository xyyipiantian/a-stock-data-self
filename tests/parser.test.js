const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { parseSessionFile, scanCodexUsage } = require("../src/codex-usage");

function writeFixture(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-usage-"));
  const filePath = path.join(dir, "rollout-2026-05-07T00-00-00-test-session.jsonl");
  fs.writeFileSync(filePath, lines.map((line) => JSON.stringify(line)).join("\n"), "utf8");
  return { dir, filePath };
}

test("parses token_count rows and deduplicates repeated totals", () => {
  const { filePath } = writeFixture([
    {
      timestamp: "2026-05-07T00:00:00.000Z",
      type: "session_meta",
      payload: { id: "test-session", timestamp: "2026-05-07T00:00:00.000Z", cwd: "C:\\work" }
    },
    {
      timestamp: "2026-05-07T00:00:01.000Z",
      type: "turn_context",
      payload: { model: "gpt-5.4", cwd: "C:\\work" }
    },
    {
      timestamp: "2026-05-07T00:00:02.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 1000,
            cached_input_tokens: 700,
            output_tokens: 100,
            reasoning_output_tokens: 30,
            total_tokens: 1100
          },
          last_token_usage: {
            input_tokens: 1000,
            cached_input_tokens: 700,
            output_tokens: 100,
            reasoning_output_tokens: 30,
            total_tokens: 1100
          }
        }
      }
    },
    {
      timestamp: "2026-05-07T00:00:03.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 1000,
            cached_input_tokens: 700,
            output_tokens: 100,
            reasoning_output_tokens: 30,
            total_tokens: 1100
          },
          last_token_usage: {
            input_tokens: 1000,
            cached_input_tokens: 700,
            output_tokens: 100,
            reasoning_output_tokens: 30,
            total_tokens: 1100
          }
        }
      }
    }
  ]);

  const session = parseSessionFile(filePath);
  assert.equal(session.requestCount, 1);
  assert.equal(session.usage.input_tokens, 1000);
  assert.equal(session.usage.cached_input_tokens, 700);
  assert.equal(session.usage.output_tokens, 100);
  assert.equal(session.model, "gpt-5.4");
  assert.ok(session.costUsd > 0);
});

test("scans sessions with a date filter", () => {
  const { dir } = writeFixture([
    {
      timestamp: "2026-05-07T00:00:00.000Z",
      type: "turn_context",
      payload: { model: "gpt-5.3-codex" }
    },
    {
      timestamp: "2026-05-07T00:00:02.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 0,
            output_tokens: 10,
            total_tokens: 110
          },
          last_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 0,
            output_tokens: 10,
            total_tokens: 110
          }
        }
      }
    }
  ]);
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const sessionsRoot = path.join(codexHome, "sessions");
  fs.mkdirSync(sessionsRoot, { recursive: true });
  fs.copyFileSync(path.join(dir, "rollout-2026-05-07T00-00-00-test-session.jsonl"), path.join(sessionsRoot, "rollout-2026-05-07T00-00-00-test-session.jsonl"));

  const included = scanCodexUsage({
    codexHome,
    from: "2026-05-07T00:00:00.000Z",
    until: "2026-05-08T00:00:00.000Z"
  });
  assert.equal(included.totals.requestCount, 1);

  const excluded = scanCodexUsage({
    codexHome,
    from: "2026-05-08T00:00:00.000Z",
    until: "2026-05-09T00:00:00.000Z"
  });
  assert.equal(excluded.totals.requestCount, 0);
});
