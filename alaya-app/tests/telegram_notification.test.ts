import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ALAYA_DB_PATH = join(mkdtempSync(join(tmpdir(), "alaya-telegram-test-")), "test.db");
process.env.ALAYA_MODE = "test";
process.env.ALAYA_CAP_DATABASE_MIGRATION = "true";
process.env.ALAYA_LLM_PROVIDER = "mock";
process.env.ALAYA_ALLOWED_NETWORK_HOSTS = "api.telegram.org";

const { escapeMarkdownV2, escapeMarkdownV2LinkUrl, sendTelegramText } = await import("../server/notifications/telegram-simple.ts");
const { gateCard } = await import("../server/notifications/card.ts");
const { TelegramAdapter } = await import("../server/notifications/telegram.ts");

test("escapes MarkdownV2 dynamic text", () => {
  assert.equal(
    escapeMarkdownV2("gate_id [a](b) *risk* #1!"),
    "gate\\_id \\[a\\]\\(b\\) \\*risk\\* \\#1\\!",
  );
});

test("escapes MarkdownV2 link URLs without escaping ordinary URL dots", () => {
  assert.equal(
    escapeMarkdownV2LinkUrl("http://localhost:5000/gates?gate=(abc)"),
    "http://localhost:5000/gates?gate=(abc\\)",
  );
});

test("external notification capability denial prevents fetch", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    throw new Error("fetch should not be called");
  }) as typeof fetch;

  try {
    process.env.ALAYA_CAP_EXTERNAL_NOTIFICATION = "false";
    await sendTelegramText("123:abc_DEF", "42", "test");
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sendTelegramText escapes raw MarkdownV2 text before sending", async () => {
  const originalFetch = globalThis.fetch;
  const originalCapability = process.env.ALAYA_CAP_EXTERNAL_NOTIFICATION;
  let sentBody: any;
  globalThis.fetch = (async (_url, init) => {
    sentBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ ok: true, result: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    process.env.ALAYA_CAP_EXTERNAL_NOTIFICATION = "true";
    await sendTelegramText("123:abc_DEF", "42", "gate_id [a](b) *risk* #1!");
    assert.equal(sentBody.text, "gate\\_id \\[a\\]\\(b\\) \\*risk\\* \\#1\\!");
    assert.equal(sentBody.parse_mode, "MarkdownV2");
  } finally {
    process.env.ALAYA_CAP_EXTERNAL_NOTIFICATION = originalCapability;
    globalThis.fetch = originalFetch;
  }
});

test("TelegramAdapter renders gate card footer without raw MarkdownV2 separators", async () => {
  const originalFetch = globalThis.fetch;
  const originalCapability = process.env.ALAYA_CAP_EXTERNAL_NOTIFICATION;
  let sentBody: any;
  globalThis.fetch = (async (_url, init) => {
    sentBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: 42 } } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    process.env.ALAYA_CAP_EXTERNAL_NOTIFICATION = "true";
    const adapter = new TelegramAdapter("123:abc_DEF", "42");
    await adapter.sendCard("42", gateCard({
      title: "方向闸待处理 — proj_test",
      body: "risk-gate [a](b)!",
      gateId: "gate_1",
      gateType: "direction",
      isBlocking: true,
      actionUrl: "http://localhost:5001/#/human-gates?gate=gate_1",
    }));
    assert.doesNotMatch(sentBody.text, /^---$/m);
    assert.match(sentBody.text, /\[在 Web UI 查看详情\]\(http:\/\/localhost:5001\/#\/human-gates\?gate=gate_1\)/);
  } finally {
    process.env.ALAYA_CAP_EXTERNAL_NOTIFICATION = originalCapability;
    globalThis.fetch = originalFetch;
  }
});

test("TelegramAdapter retries transient sendMessage failures", async () => {
  const originalFetch = globalThis.fetch;
  const originalCapability = process.env.ALAYA_CAP_EXTERNAL_NOTIFICATION;
  const originalAttempts = process.env.ALAYA_TELEGRAM_REQUEST_ATTEMPTS;
  const originalRetryBase = process.env.ALAYA_TELEGRAM_RETRY_BASE_MS;
  let calls = 0;
  globalThis.fetch = (async (_url, _init) => {
    calls += 1;
    if (calls === 1) throw new Error("fetch failed");
    return new Response(JSON.stringify({ ok: true, result: { message_id: 7, chat: { id: 42 } } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    process.env.ALAYA_CAP_EXTERNAL_NOTIFICATION = "true";
    process.env.ALAYA_TELEGRAM_REQUEST_ATTEMPTS = "2";
    process.env.ALAYA_TELEGRAM_RETRY_BASE_MS = "0";
    const adapter = new TelegramAdapter("123:abc_DEF", "42");
    const sent = await adapter.sendCard("42", gateCard({
      title: "意义闸",
      body: "retry card",
      gateId: "gate_retry",
      gateType: "meaning",
      isBlocking: false,
    }));
    assert.equal(calls, 2);
    assert.deepEqual(sent, { chatId: "42", messageId: 7 });
  } finally {
    process.env.ALAYA_CAP_EXTERNAL_NOTIFICATION = originalCapability;
    process.env.ALAYA_TELEGRAM_REQUEST_ATTEMPTS = originalAttempts;
    process.env.ALAYA_TELEGRAM_RETRY_BASE_MS = originalRetryBase;
    globalThis.fetch = originalFetch;
  }
});

test("TelegramAdapter does not retry non-transient Telegram API failures", async () => {
  const originalFetch = globalThis.fetch;
  const originalCapability = process.env.ALAYA_CAP_EXTERNAL_NOTIFICATION;
  const originalAttempts = process.env.ALAYA_TELEGRAM_REQUEST_ATTEMPTS;
  const originalRetryBase = process.env.ALAYA_TELEGRAM_RETRY_BASE_MS;
  let calls = 0;
  globalThis.fetch = (async (_url, _init) => {
    calls += 1;
    return new Response(JSON.stringify({ ok: false, description: "Bad Request: message is not modified" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    process.env.ALAYA_CAP_EXTERNAL_NOTIFICATION = "true";
    process.env.ALAYA_TELEGRAM_REQUEST_ATTEMPTS = "3";
    process.env.ALAYA_TELEGRAM_RETRY_BASE_MS = "0";
    const adapter = new TelegramAdapter("123:abc_DEF", "42");
    await assert.rejects(
      () => adapter.sendCard("42", gateCard({
        title: "意义闸",
        body: "non-retry card",
        gateId: "gate_non_retry",
        gateType: "meaning",
        isBlocking: false,
      })),
      /Telegram sendMessage failed: 400 Bad Request: message is not modified/,
    );
    assert.equal(calls, 1);
  } finally {
    process.env.ALAYA_CAP_EXTERNAL_NOTIFICATION = originalCapability;
    process.env.ALAYA_TELEGRAM_REQUEST_ATTEMPTS = originalAttempts;
    process.env.ALAYA_TELEGRAM_RETRY_BASE_MS = originalRetryBase;
    globalThis.fetch = originalFetch;
  }
});
