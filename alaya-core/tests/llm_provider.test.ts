import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAIProvider, resolveOpenAIApiKey } from "../src/llm/provider.js";

test("OPENAI_API_KEY_FILE provides a local-only API key without putting it in the command", () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousKeyFile = process.env.OPENAI_API_KEY_FILE;
  const dir = mkdtempSync(join(tmpdir(), "alaya-openai-key-"));
  const keyFile = join(dir, "key.txt");
  writeFileSync(keyFile, "test-openai-key-from-file\n", "utf8");

  try {
    delete process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY_FILE = keyFile;
    assert.equal(resolveOpenAIApiKey(), "test-openai-key-from-file");
    process.env.OPENAI_API_KEY = "";
    assert.equal(resolveOpenAIApiKey(), "test-openai-key-from-file", "empty env key should not hide the local key file");
    assert.equal(resolveOpenAIApiKey(""), "", "explicit empty apiKey still forces missing-key degradation tests");
  } finally {
    if (previousKey == null) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    if (previousKeyFile == null) delete process.env.OPENAI_API_KEY_FILE;
    else process.env.OPENAI_API_KEY_FILE = previousKeyFile;
  }
});

test("OpenAIProvider redacts PII before provider request and call logging", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody = "";
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    requestBody = String(init?.body ?? "");
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ summary: "ok sensitive@example.com" }) } }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  try {
    const provider = new OpenAIProvider({
      apiKey: "test-key-not-real",
      apiMode: "chat",
      endpoint: "https://llm.example.test/v1/chat/completions",
      model: "MiniMax-M3",
    });
    const response = await provider.call({
      role: "sensor",
      task: "classify_external_feedback",
      promptVersion: "sensor.redaction.v1",
      context: {
        title: "Email sensitive@example.com",
        body: "Phone +1 415 555 1212 token=ghp_abcdefghijklmnopqrstuvwxyz123456 key sk-cp-abcdefghijklmnopqrstuvwxyz123456",
        nested: ["password=supersecret123"],
      },
      knowledgeSummary: "Do not reveal sensitive@example.com",
      prohibited: ["Do not expose +1 415 555 1212"],
      schema: {
        type: "object",
        required: ["summary"],
        additionalProperties: true,
        properties: { summary: { type: "string" } },
      },
    });

    assert.equal(response.schemaValid, true);
    assert.equal(requestBody.includes("sensitive@example.com"), false);
    assert.equal(requestBody.includes("415 555 1212"), false);
    assert.equal(requestBody.includes("ghp_abcdefghijklmnopqrstuvwxyz123456"), false);
    assert.equal(requestBody.includes("sk-cp-abcdefghijklmnopqrstuvwxyz123456"), false);
    assert.equal(requestBody.includes("supersecret123"), false);
    assert.match(requestBody, /\[redacted-email\]/);
    assert.match(requestBody, /\[redacted-phone\]/);
    assert.match(requestBody, /\[redacted-secret\]|\[redacted-token\]/);

    const logged = `${response.log.inputSummary}\n${response.log.outputSummary}`;
    assert.equal(logged.includes("sensitive@example.com"), false);
    assert.equal(logged.includes("415 555 1212"), false);
    assert.equal(logged.includes("ghp_abcdefghijklmnopqrstuvwxyz123456"), false);
    assert.equal(logged.includes("sk-cp-abcdefghijklmnopqrstuvwxyz123456"), false);
    assert.match(response.log.inputSummary, /\[redacted-email\]/);
    assert.match(response.log.outputSummary, /\[redacted-email\]/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAIProvider times out hung requests and degrades to a non-blocking human gate", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls++;
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("aborted", "AbortError"));
      });
    });
  }) as typeof fetch;

  try {
    const provider = new OpenAIProvider({
      apiKey: "test-key-not-real",
      apiMode: "chat",
      endpoint: "https://llm.example.test/v1/chat/completions",
      model: "MiniMax-M3",
      maxRetries: 0,
      timeoutMs: 1,
    });
    const response = await provider.call({
      role: "orchestrator",
      task: "timeout_test",
      promptVersion: "timeout_test@v1",
      context: { cycleIndex: 1 },
      schema: {
        type: "object",
        required: ["summary", "goal"],
        additionalProperties: true,
        properties: {
          summary: { type: "string" },
          goal: { type: "string" },
        },
      },
      simplifiedSchema: {
        type: "object",
        required: ["summary"],
        additionalProperties: true,
        properties: { summary: { type: "string" } },
      },
    });

    assert.equal(calls, 2);
    assert.equal(response.schemaValid, false);
    assert.equal(response.degradedToHumanGate, true);
    assert.match(response.errorMessage ?? "", /timed out/);
    const candidate = response.data.human_gate_candidate as { blocking?: boolean } | undefined;
    assert.equal(candidate?.blocking, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAIProvider falls back to simplified schema after full schema validation fails", async () => {
  const originalFetch = globalThis.fetch;
  const requestBodies: string[] = [];
  let calls = 0;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls++;
    requestBodies.push(String(init?.body ?? ""));
    const content = calls === 1
      ? { summary: "missing required goal" }
      : { summary: "simplified schema accepted" };
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(content) } }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  try {
    const provider = new OpenAIProvider({
      apiKey: "test-key-not-real",
      apiMode: "chat",
      endpoint: "https://llm.example.test/v1/chat/completions",
      model: "MiniMax-M3",
      maxRetries: 0,
    });
    const response = await provider.call({
      role: "orchestrator",
      task: "plan_cycle",
      promptVersion: "plan_cycle@v1",
      context: { cycleIndex: 1 },
      schema: {
        type: "object",
        required: ["summary", "goal"],
        additionalProperties: true,
        properties: {
          summary: { type: "string" },
          goal: { type: "string" },
        },
      },
      simplifiedSchema: {
        type: "object",
        required: ["summary"],
        additionalProperties: true,
        properties: { summary: { type: "string" } },
      },
    });

    assert.equal(calls, 2);
    assert.equal(response.schemaValid, false);
    assert.equal(response.degradedToHumanGate, true);
    assert.equal(response.retryCount, 1);
    assert.equal(response.data.summary, "simplified schema accepted");
    assert.equal(response.log.schemaValid, false);
    assert.equal(response.log.retryCount, 1);
    assert.match(response.errorMessage ?? "", /simplified schema/);
    assert.match(requestBodies[1], /response failed JSON schema validation/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAIProvider promotes simplified retry when it satisfies the original schema", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (_url: string | URL | Request, _init?: RequestInit) => {
    calls++;
    const content = calls === 1
      ? { summary: "missing required goal" }
      : { summary: "simplified retry returned full data", goal: "ship with rollback" };
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(content) } }],
      usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  try {
    const provider = new OpenAIProvider({
      apiKey: "test-key-not-real",
      apiMode: "chat",
      endpoint: "https://llm.example.test/v1/chat/completions",
      model: "MiniMax-M3",
      maxRetries: 0,
    });
    const response = await provider.call({
      role: "orchestrator",
      task: "plan_cycle",
      promptVersion: "plan_cycle@v1",
      context: { cycleIndex: 1 },
      schema: {
        type: "object",
        required: ["summary", "goal"],
        additionalProperties: true,
        properties: {
          summary: { type: "string" },
          goal: { type: "string" },
        },
      },
      simplifiedSchema: {
        type: "object",
        required: ["summary"],
        additionalProperties: true,
        properties: { summary: { type: "string" } },
      },
    });

    assert.equal(calls, 2);
    assert.equal(response.schemaValid, true);
    assert.equal(response.degradedToHumanGate, false);
    assert.equal(response.data.goal, "ship with rollback");
    assert.equal(response.log.schemaValid, true);
    assert.equal(response.log.retryCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAIProvider disables MiniMax thinking and parses JSON after thinking blocks", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody = "";
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    requestBody = String(init?.body ?? "");
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: '<think>{"draft":"not the answer"}</think>\n{"summary":"ok","goal":"ship safely"}',
        },
      }],
      usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  try {
    const provider = new OpenAIProvider({
      apiKey: "test-key-not-real",
      apiMode: "chat",
      endpoint: "https://api.minimax.io/v1/chat/completions",
      model: "MiniMax-M3",
      maxRetries: 0,
    });
    const response = await provider.call({
      role: "orchestrator",
      task: "minimax_thinking_test",
      promptVersion: "minimax_thinking_test@v1",
      context: { cycleIndex: 1 },
      mockData: { summary: "draft", goal: "safe draft" },
      schema: {
        type: "object",
        required: ["summary", "goal"],
        additionalProperties: true,
        properties: {
          summary: { type: "string" },
          goal: { type: "string" },
        },
      },
    });

    assert.equal(response.schemaValid, true);
    assert.equal(response.data.goal, "ship safely");
    const body = JSON.parse(requestBody) as Record<string, unknown>;
    assert.deepEqual(body.thinking, { type: "disabled" });
    assert.equal(body.max_tokens, 512);
    assert.match(requestBody, /draft_output/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
