import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ALAYA_DB_PATH = join(mkdtempSync(join(tmpdir(), "alaya-provider-canary-")), "test.db");
process.env.ALAYA_MODE = "test";
process.env.ALAYA_LLM_PROVIDER = "mock";

const { storage } = await import("../server/storage.ts");
const { classifyLlmFailure, getLlmRetryPolicy, callLlm } = await import("../server/llm.ts");
const { runProviderCanary } = await import("../server/providerCanary.ts");
const { buildMetricsSnapshot } = await import("../server/observability/metrics.ts");
const { HumanGateService } = await import("../server/humanGateService.ts");

storage.createProject({
  id: "proj_canary",
  name: "Canary",
  direction: "provider health",
  targetUser: "operators",
  redlines: "[]",
  weeklyHumanMinutes: 150,
  weeklyLlmBudgetCents: 100,
  firstClaimMetric: "activation_rate",
  firstClaimOperator: ">=",
  firstClaimTarget: 0.3,
  seedIdentity: "",
  worldModel: "",
  currentCycleIdx: 1,
  version: 1,
});
storage.createCycle({
  id: "cycle_canary",
  projectId: "proj_canary",
  idx: 1,
  goal: "canary",
  status: "planning",
  eCycle: null,
  worstClaimError: null,
  reasoning: "",
  version: 1,
});

test("LLM failure taxonomy classifies common provider errors", () => {
  assert.equal(classifyLlmFailure("request timed out after 100ms"), "timeout");
  assert.equal(classifyLlmFailure("OpenAI 429: rate limit"), "rate_limit");
  assert.equal(classifyLlmFailure("401 unauthorized invalid api key"), "auth");
  assert.equal(classifyLlmFailure("schema validation failed: $.summary is required"), "schema_error");
  assert.equal(classifyLlmFailure("response was not parseable JSON"), "invalid_json");
  assert.equal(classifyLlmFailure("safety refusal from provider"), "safety_refusal");
  assert.equal(classifyLlmFailure("fetch failed ECONNRESET"), "network");
  assert.equal(classifyLlmFailure("OpenAI 500 provider exploded"), "provider_error");
});

test("retry policy is bounded even when env asks for too many attempts", () => {
  const previous = process.env.OPENAI_MAX_RETRIES;
  process.env.OPENAI_MAX_RETRIES = "99";
  try {
    assert.equal(getLlmRetryPolicy().maxRetries, 3);
  } finally {
    if (previous == null) delete process.env.OPENAI_MAX_RETRIES;
    else process.env.OPENAI_MAX_RETRIES = previous;
  }
});

test("per-call model routing override does not mutate global routing env", async () => {
  const previous = process.env.ALAYA_MODEL_ROUTING_JSON;
  process.env.ALAYA_MODEL_ROUTING_JSON = JSON.stringify({
    sensor: { provider: "mock", model: "global-sensor" },
  });

  try {
    await callLlm({
      cycleId: "cycle_canary",
      agent: "sensor",
      promptName: "per_call_route",
      inputSummary: "use a per-call model route",
      mockOutput: { summary: "ok" },
      routeEnv: {
        ...process.env,
        ALAYA_MODEL_ROUTING_JSON: JSON.stringify({
          sensor: { provider: "mock", model: "per-call-sensor" },
        }),
      },
    });

    const call = storage.listLlmCalls().at(-1);
    assert.equal(call?.model, "per-call-sensor");
    assert.equal(process.env.ALAYA_MODEL_ROUTING_JSON, JSON.stringify({
      sensor: { provider: "mock", model: "global-sensor" },
    }));
  } finally {
    if (previous == null) delete process.env.ALAYA_MODEL_ROUTING_JSON;
    else process.env.ALAYA_MODEL_ROUTING_JSON = previous;
  }
});

test("chat provider usage is persisted as provider token counts", async () => {
  const previousProvider = process.env.ALAYA_LLM_PROVIDER;
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousBaseUrl = process.env.OPENAI_BASE_URL;
  const previousApiMode = process.env.OPENAI_API_MODE;
  const previousChatEndpoint = process.env.OPENAI_CHAT_COMPLETIONS_ENDPOINT;
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";

  globalThis.fetch = (async (url: string | URL | Request) => {
    requestedUrl = String(url);
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ summary: "provider usage ok" }) } }],
      usage: { prompt_tokens: 37, completion_tokens: 11 },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  try {
    process.env.ALAYA_LLM_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "test-api-key-not-a-real-secret";
    process.env.OPENAI_BASE_URL = "https://api.openai.com/v1";
    delete process.env.OPENAI_API_MODE;
    delete process.env.OPENAI_CHAT_COMPLETIONS_ENDPOINT;

    await callLlm({
      cycleId: "cycle_canary",
      agent: "sensor",
      promptName: "chat_provider_usage",
      inputSummary: "record provider token usage",
      mockOutput: { summary: "mock" },
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (previousProvider == null) delete process.env.ALAYA_LLM_PROVIDER;
    else process.env.ALAYA_LLM_PROVIDER = previousProvider;
    if (previousApiKey == null) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    if (previousBaseUrl == null) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previousBaseUrl;
    if (previousApiMode == null) delete process.env.OPENAI_API_MODE;
    else process.env.OPENAI_API_MODE = previousApiMode;
    if (previousChatEndpoint == null) delete process.env.OPENAI_CHAT_COMPLETIONS_ENDPOINT;
    else process.env.OPENAI_CHAT_COMPLETIONS_ENDPOINT = previousChatEndpoint;
  }

  assert.match(requestedUrl, /\/chat\/completions$/);
  const call = storage.listLlmCalls().find((item) => item.promptVersion === "chat_provider_usage@v1");
  assert.ok(call);
  assert.equal(call.inputTokenCount, 37);
  assert.equal(call.outputTokenCount, 11);
  assert.equal(call.tokenCount, 48);
  assert.equal(call.tokenSource, "provider");
  assert.equal(call.estimatedCost, 0.000096);
});

test("responses provider usage is persisted from input and output tokens", async () => {
  const previousProvider = process.env.ALAYA_LLM_PROVIDER;
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousBaseUrl = process.env.OPENAI_BASE_URL;
  const previousApiMode = process.env.OPENAI_API_MODE;
  const previousResponsesEndpoint = process.env.OPENAI_RESPONSES_ENDPOINT;
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";

  globalThis.fetch = (async (url: string | URL | Request) => {
    requestedUrl = String(url);
    return new Response(JSON.stringify({
      output_text: JSON.stringify({ summary: "responses usage ok" }),
      usage: { input_tokens: 19, output_tokens: 7, total_tokens: 26 },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  try {
    process.env.ALAYA_LLM_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "test-api-key-not-a-real-secret";
    process.env.OPENAI_API_MODE = "responses";
    process.env.OPENAI_RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses";
    delete process.env.OPENAI_BASE_URL;

    await callLlm({
      cycleId: "cycle_canary",
      agent: "sensor",
      promptName: "responses_provider_usage",
      inputSummary: "record responses token usage",
      mockOutput: { summary: "mock" },
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (previousProvider == null) delete process.env.ALAYA_LLM_PROVIDER;
    else process.env.ALAYA_LLM_PROVIDER = previousProvider;
    if (previousApiKey == null) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    if (previousBaseUrl == null) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previousBaseUrl;
    if (previousApiMode == null) delete process.env.OPENAI_API_MODE;
    else process.env.OPENAI_API_MODE = previousApiMode;
    if (previousResponsesEndpoint == null) delete process.env.OPENAI_RESPONSES_ENDPOINT;
    else process.env.OPENAI_RESPONSES_ENDPOINT = previousResponsesEndpoint;
  }

  assert.equal(requestedUrl, "https://api.openai.com/v1/responses");
  const call = storage.listLlmCalls().find((item) => item.promptVersion === "responses_provider_usage@v1");
  assert.ok(call);
  assert.equal(call.inputTokenCount, 19);
  assert.equal(call.outputTokenCount, 7);
  assert.equal(call.tokenCount, 26);
  assert.equal(call.tokenSource, "provider");
});

test("chat provider parses the last balanced JSON object from wrapped content", async () => {
  const previousProvider = process.env.ALAYA_LLM_PROVIDER;
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousBaseUrl = process.env.OPENAI_BASE_URL;
  const previousMaxRetries = process.env.OPENAI_MAX_RETRIES;
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: 'draft {"summary":"too small"}\nfinal {"summary":"ok","goal":"ship safely"} trailing }',
        },
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  try {
    process.env.ALAYA_LLM_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "test-api-key-not-a-real-secret";
    process.env.OPENAI_BASE_URL = "https://llm.example.test/v1";
    process.env.OPENAI_MAX_RETRIES = "0";
    const output = await callLlm({
      cycleId: "cycle_canary",
      agent: "orchestrator",
      promptName: "wrapped_json_parse",
      inputSummary: "parse wrapped provider output",
      mockOutput: { summary: "mock", goal: "mock goal" },
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

    assert.equal(calls, 1);
    assert.equal(output.goal, "ship safely");
    assert.equal(storage.listLlmCalls().at(-1)?.schemaValid, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousProvider == null) delete process.env.ALAYA_LLM_PROVIDER;
    else process.env.ALAYA_LLM_PROVIDER = previousProvider;
    if (previousApiKey == null) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    if (previousBaseUrl == null) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previousBaseUrl;
    if (previousMaxRetries == null) delete process.env.OPENAI_MAX_RETRIES;
    else process.env.OPENAI_MAX_RETRIES = previousMaxRetries;
  }
});

test("exact repair schema retry asks for full JSON instead of summary-only degradation", async () => {
  const previousProvider = process.env.ALAYA_LLM_PROVIDER;
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousBaseUrl = process.env.OPENAI_BASE_URL;
  const previousMaxRetries = process.env.OPENAI_MAX_RETRIES;
  const originalFetch = globalThis.fetch;
  const requestBodies: string[] = [];

  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    requestBodies.push(String(init?.body ?? ""));
    const content = requestBodies.length < 3
      ? { summary: "missing full fields" }
      : {
        summary: "full repair ok",
        proposedGoal: "repair exact schema",
        belief: "all required fields must survive repair",
        prediction: { statement: "metric >= 0.8", metric: "metric", operator: ">=", target: 0.8 },
        action: "continue with exact schema output",
        alternativeGoals: [],
        referencedKnowledgeIds: ["kb_repair"],
        reasoningHowKnowledgeChangedDecision: "引用 kb_repair: exact-schema repair keeps the diagnostic gate from summary-only degradation.",
      };
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(content) } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  const exactSchema = {
    type: "object" as const,
    required: [
      "summary",
      "proposedGoal",
      "belief",
      "prediction",
      "action",
      "alternativeGoals",
      "referencedKnowledgeIds",
      "reasoningHowKnowledgeChangedDecision",
    ],
    additionalProperties: true,
    properties: {
      summary: { type: "string" },
      proposedGoal: { type: "string" },
      belief: { type: "string" },
      prediction: { type: "object" },
      action: { type: "string" },
      alternativeGoals: { type: "array" },
      referencedKnowledgeIds: { type: "array" },
      reasoningHowKnowledgeChangedDecision: { type: "string" },
    },
  };

  try {
    process.env.ALAYA_LLM_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "test-api-key-not-a-real-secret";
    process.env.OPENAI_BASE_URL = "https://llm.example.test/v1";
    process.env.OPENAI_MAX_RETRIES = "0";
    const output = await callLlm({
      cycleId: "cycle_canary",
      agent: "orchestrator",
      promptName: "exact_schema_repair",
      inputSummary: "repair autonomous goal output",
      mockOutput: {
        summary: "mock",
        proposedGoal: "mock goal",
        belief: "mock belief",
        prediction: { statement: "metric >= 0.5", metric: "metric", operator: ">=", target: 0.5 },
        action: "mock action",
        alternativeGoals: [],
        referencedKnowledgeIds: ["kb_repair"],
        reasoningHowKnowledgeChangedDecision: "引用 kb_repair: mock reasoning keeps exact schema valid.",
      },
      schema: exactSchema,
      simplifiedSchema: exactSchema,
    });

    assert.equal(requestBodies.length, 3);
    assert.equal(output.proposedGoal, "repair exact schema");
    assert.match(requestBodies[2], /return JSON matching the supplied output_schema exactly/);
    assert.doesNotMatch(requestBodies[2], /return simplified JSON summary only/);
    assert.equal(storage.listLlmCalls().at(-1)?.schemaValid, 1);
    assert.equal(storage.listGates("proj_canary").some((gate) => gate.title === "LLM 输出降级: orchestrator/exact_schema_repair"), false);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousProvider == null) delete process.env.ALAYA_LLM_PROVIDER;
    else process.env.ALAYA_LLM_PROVIDER = previousProvider;
    if (previousApiKey == null) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    if (previousBaseUrl == null) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previousBaseUrl;
    if (previousMaxRetries == null) delete process.env.OPENAI_MAX_RETRIES;
    else process.env.OPENAI_MAX_RETRIES = previousMaxRetries;
  }
});

test("missing provider usage falls back to estimated token counts", async () => {
  const previousProvider = process.env.ALAYA_LLM_PROVIDER;
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousBaseUrl = process.env.OPENAI_BASE_URL;
  const previousApiMode = process.env.OPENAI_API_MODE;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ summary: "no usage still works" }) } }],
  }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;

  try {
    process.env.ALAYA_LLM_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "test-api-key-not-a-real-secret";
    process.env.OPENAI_BASE_URL = "https://api.openai.com/v1";
    delete process.env.OPENAI_API_MODE;

    await callLlm({
      cycleId: "cycle_canary",
      agent: "sensor",
      promptName: "estimated_usage_fallback",
      inputSummary: "record estimated token usage when provider omits usage",
      mockOutput: { summary: "mock" },
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (previousProvider == null) delete process.env.ALAYA_LLM_PROVIDER;
    else process.env.ALAYA_LLM_PROVIDER = previousProvider;
    if (previousApiKey == null) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    if (previousBaseUrl == null) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previousBaseUrl;
    if (previousApiMode == null) delete process.env.OPENAI_API_MODE;
    else process.env.OPENAI_API_MODE = previousApiMode;
  }

  const call = storage.listLlmCalls().find((item) => item.promptVersion === "estimated_usage_fallback@v1");
  assert.ok(call);
  assert.equal(call.tokenSource, "estimated");
  assert.ok(call.inputTokenCount > 0);
  assert.ok(call.outputTokenCount > 0);
  assert.equal(call.tokenCount, call.inputTokenCount + call.outputTokenCount);
});

test("mock provider canary success and schema failure are persisted", async () => {
  const previousRouting = process.env.ALAYA_MODEL_ROUTING_JSON;
  process.env.ALAYA_MODEL_ROUTING_JSON = JSON.stringify({
    builder: { provider: "mock", model: "global-builder" },
  });

  try {
    const ok = await runProviderCanary({ projectId: "proj_canary", cycleId: "cycle_canary", provider: "mock", model: "mock-canary", role: "sensor" });
    assert.equal(ok.ok, true);
    assert.equal(ok.provider, "mock");
    assert.equal(ok.model, "mock-canary");
    assert.equal(ok.llmFailureType, null);
    assert.equal(process.env.ALAYA_MODEL_ROUTING_JSON, JSON.stringify({
      builder: { provider: "mock", model: "global-builder" },
    }));

    const failed = await runProviderCanary({
      projectId: "proj_canary",
      cycleId: "cycle_canary",
      provider: "mock",
      model: "mock-canary",
      role: "builder",
      forceFailure: "schema_error",
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.llmFailureType, "schema_error");
    assert.ok(storage.listLlmCalls().some((call) => call.agent === "builder" && call.llmFailureType === "schema_error"));

    const providerFailed = await runProviderCanary({
      projectId: "proj_canary",
      cycleId: "cycle_canary",
      provider: "mock",
      model: "mock-canary",
      role: "librarian",
      forceFailure: "provider_error",
    });
    assert.equal(providerFailed.ok, false);
    assert.equal(providerFailed.llmFailureType, "provider_error");
    assert.equal(providerFailed.traceableLlmCallId, null);
  } finally {
    if (previousRouting == null) delete process.env.ALAYA_MODEL_ROUTING_JSON;
    else process.env.ALAYA_MODEL_ROUTING_JSON = previousRouting;
  }
});

test("fallback on invalid schema creates a human meaning gate and does not bypass validation", async () => {
  await callLlm({
    cycleId: "cycle_canary",
    agent: "distiller",
    promptName: "invalid_mock_schema",
    inputSummary: "invalid schema should gate",
    mockOutput: { wrong: "shape" },
    schema: {
      type: "object",
      required: ["summary"],
      additionalProperties: true,
      properties: { summary: { type: "string" } },
    },
  });

  const call = storage.listLlmCalls().at(-1);
  assert.equal(call?.schemaValid, 0);
  assert.equal(call?.llmFailureType, "schema_error");
  const gate = storage
    .listGates("proj_canary")
    .find((item) => item.type === "meaning" && item.status === "pending" && /LLM 输出降级/.test(item.title));
  assert.ok(gate);
  assert.equal(JSON.parse(gate.payload).source, "system_diagnostic");
});

test("approved LLM degradation gates remain diagnostics and do not materialize product knowledge", async () => {
  await callLlm({
    cycleId: "cycle_canary",
    agent: "orchestrator",
    promptName: "diagnostic_gate_schema",
    inputSummary: "diagnostic gate should not become knowledge",
    mockOutput: { wrong: "shape" },
    schema: {
      type: "object",
      required: ["summary"],
      additionalProperties: true,
      properties: { summary: { type: "string" } },
    },
  });

  const gate = storage
    .listGates("proj_canary")
    .find((item) => item.status === "pending" && /diagnostic_gate_schema/.test(item.payload));
  assert.ok(gate);
  const knowledgeCountBefore = storage.listKnowledge("proj_canary").length;

  new HumanGateService(storage).approve(gate.id, { actor: "human", via: "test" });

  assert.equal(storage.getGate(gate.id)?.status, "approved");
  assert.equal(storage.listKnowledge("proj_canary").length, knowledgeCountBefore);
  assert.equal(storage.listKnowledgeReviews("proj_canary").some((review) => review.primaryKnowledgeId.includes(gate.id)), false);
});

test("repeated LLM degradation updates one diagnostic gate instead of spamming human queue", async () => {
  const promptName = "diagnostic_gate_throttle";
  const before = storage
    .listGates("proj_canary")
    .filter((item) => item.status === "pending" && item.title === `LLM 输出降级: orchestrator/${promptName}`).length;
  const invalidInput = {
    cycleId: "cycle_canary",
    agent: "orchestrator",
    promptName,
    inputSummary: "diagnostic gate should be throttled",
    mockOutput: { wrong: "shape" },
    schema: {
      type: "object" as const,
      required: ["summary"],
      additionalProperties: true,
      properties: { summary: { type: "string" } },
    },
  };

  await callLlm(invalidInput);
  await callLlm(invalidInput);

  const gates = storage
    .listGates("proj_canary")
    .filter((item) => item.status === "pending" && item.title === `LLM 输出降级: orchestrator/${promptName}`);
  assert.equal(gates.length - before, 1);
  const payload = JSON.parse(gates.at(-1)?.payload ?? "{}");
  assert.equal(payload.source, "system_diagnostic");
  assert.equal(payload.suppressedCount, 1);
  assert.match(payload.lastReason, /mock output failed schema validation/);
});

test("per-agent latency metrics are derivable from raw llm_calls", () => {
  const snapshot = buildMetricsSnapshot();
  const rawSensor = storage.listLlmCalls().filter((call) => call.agent === "sensor");
  assert.equal(snapshot.perAgentLatency.sensor.count, rawSensor.length);
  assert.ok(snapshot.perAgentLatency.builder.errorRate > 0);
});
