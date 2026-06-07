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
  assert.ok(storage.listGates("proj_canary").some((gate) => gate.type === "meaning" && gate.status === "pending" && /LLM 输出降级/.test(gate.title)));
});

test("per-agent latency metrics are derivable from raw llm_calls", () => {
  const snapshot = buildMetricsSnapshot();
  const rawSensor = storage.listLlmCalls().filter((call) => call.agent === "sensor");
  assert.equal(snapshot.perAgentLatency.sensor.count, rawSensor.length);
  assert.ok(snapshot.perAgentLatency.builder.errorRate > 0);
});
