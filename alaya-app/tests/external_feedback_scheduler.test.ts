import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ALAYA_DB_PATH = join(mkdtempSync(join(tmpdir(), "alaya-app-test-")), "test.db");
process.env.ALAYA_LLM_PROVIDER = "mock";
process.env.ALAYA_REVIEW_TIMEZONE = "Asia/Shanghai";
process.env.ALAYA_REVIEW_WINDOWS = "00:00-00:01";
process.env.ALAYA_GATE_ESCALATION_MISSED_WINDOWS = "2";

const { storage, now } = await import("../server/storage.ts");
const {
  ingestFormFeedback,
  redactPii,
  upsertGithubSource,
  syncGithubIssuesForSource,
} = await import("../server/externalFeedback.ts");
const { executeGateBudget, gateBudgetForProject, schedulerTickProject } = await import("../server/scheduler.ts");
const { HumanGateService } = await import("../server/humanGateService.ts");
const {
  SCENARIO,
  evaluatePrediction,
  runBuilder,
  runDistiller,
  runOperationalStagesAfterApprovedDirection,
  runOrchestrator,
  runSensor,
} = await import("../server/flywheel.ts");
const { callLlm } = await import("../server/llm.ts");
const { createProjectFromOnboarding } = await import("../server/onboarding.ts");
const { updateProjectConfig } = await import("../server/projectConfig.ts");

const gateService = new HumanGateService(storage);

function approveGate(gateId: string, decision = "approve", patch: Record<string, any> = {}) {
  gateService.systemResolve(gateId, decision, {
    actor: "test",
    status: "approved",
    via: "test",
    reason: "test fixture approval",
    patch,
  });
}

function createProject(projectId: string) {
  const cycleIdSuffix = projectId.replace(/[^a-zA-Z0-9_]+/g, "_").slice(-80);
  storage.createProject({
    id: projectId,
    name: `Test ${projectId}`,
    direction: "Turn external feedback into gated learning",
    targetUser: "indie builders",
    redlines: JSON.stringify(["never persist tokens", "redact PII before LLM"]),
    weeklyHumanMinutes: 120,
    weeklyLlmBudgetCents: 100,
    firstClaimMetric: "activation_rate",
    firstClaimOperator: ">=",
    firstClaimTarget: 0.3,
    seedIdentity: "test identity",
    worldModel: "test world model",
    currentCycleIdx: 1,
    version: 1,
  });
  storage.createCycle({
    id: `cycle_1_${cycleIdSuffix}`,
    projectId,
    idx: 1,
    goal: "Validate GitHub issue ingestion",
    status: "planning",
    eCycle: null,
    worstClaimError: null,
    reasoning: "",
    version: 1,
  });
}

function measurableActivationClaim(overrides: Record<string, unknown> = {}) {
  return {
    id: "claim_activation",
    type: "metric_threshold",
    metric: "activation_rate",
    operator: ">=",
    target: 0.3,
    observed: 0.4,
    weight: 3,
    expectedObservation: "activation_rate >= 0.3",
    timeWindow: "cycle_feedback_window",
    successThreshold: "activation_rate >= 0.3",
    failureThreshold: "activation_rate < 0.3",
    uncertainty: 0.25,
    ...overrides,
  };
}

function createActiveKnowledge(projectId: string, id: string, patch: Record<string, any>) {
  storage.createKnowledge({
    id,
    projectId,
    type: patch.type ?? "principle",
    title: patch.title ?? "Knowledge fixture",
    content: patch.content ?? "fixture knowledge",
    sourceType: patch.sourceType ?? "test",
    sourceRef: patch.sourceRef ?? id,
    evidenceAlpha: patch.evidenceAlpha ?? 5,
    evidenceBeta: patch.evidenceBeta ?? 1,
    confidenceScore: patch.confidenceScore ?? 0.82,
    confidenceLevel: patch.confidenceLevel ?? "high",
    status: patch.status ?? "active",
    humanApprovedCount: patch.humanApprovedCount ?? 1,
    externalVerifiedCount: patch.externalVerifiedCount ?? 1,
    validFrom: patch.validFrom ?? "2026-01-01",
    validUntil: patch.validUntil ?? null,
    lastValidatedCycle: patch.lastValidatedCycle ?? 1,
    createdByCycle: patch.createdByCycle ?? 1,
    createdBy: patch.createdBy ?? "test",
    approvedBy: patch.approvedBy ?? "human",
    usageCount: patch.usageCount ?? 0,
    lastInjectedAt: patch.lastInjectedAt ?? null,
    lastVerifiedAt: patch.lastVerifiedAt ?? Date.parse("2026-01-01T00:00:00Z"),
    lastDecayedAt: patch.lastDecayedAt ?? null,
    storageStrength: patch.storageStrength ?? 1,
    noveltyScore: patch.noveltyScore ?? null,
    sourceRound: patch.sourceRound ?? 1,
    tags: JSON.stringify(patch.tags ?? []),
    notes: patch.notes ?? "",
    supersededBy: patch.supersededBy ?? null,
    semanticKey: patch.semanticKey ?? "",
    version: 1,
  });
}

function installFakeGithubFetch(issueTitle = "I am confused about setup") {
  const calls: string[] = [];
  const authHeaders: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(String(url));
    const headers = init?.headers as Record<string, string> | undefined;
    authHeaders.push(headers?.Authorization ?? headers?.authorization ?? "");
    return new Response(JSON.stringify([
      {
        number: 42,
        title: issueTitle,
        body: "Contact me at user@example.com or +1 415 555 1212. token=ghp_abcdefghijklmnopqrstuvwxyz123456",
        html_url: "https://github.com/acme/alaya/issues/42",
        updated_at: now(),
        labels: [{ name: "question" }],
        user: { login: "tester" },
      },
      {
        number: 43,
        title: "PR should be skipped",
        body: "not an issue",
        html_url: "https://github.com/acme/alaya/pull/43",
        updated_at: now(),
        pull_request: {},
        labels: [],
        user: { login: "tester" },
      },
    ]), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return {
    calls,
    authHeaders,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function installFailingGithubFetch(status = 503, body = "GitHub unavailable") {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(body, { status });
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function persistedProjectCorpus(projectId: string) {
  const cycles = storage.listCycles(projectId);
  return JSON.stringify({
    sources: storage.listExternalFeedbackSources(projectId),
    feedback: cycles.flatMap((cycle) => storage.listFeedback(cycle.id)),
    gates: storage.listGates(projectId),
    events: storage.listEvents(),
    llmCalls: storage.listLlmCalls(),
    knowledge: storage.listKnowledge(projectId),
  });
}

test("redactPii removes emails, phones and token-like secrets", () => {
  const redacted = redactPii("email a@b.com phone +1 415 555 1212 token=ghp_abcdefghijklmnopqrstuvwxyz123456 key sk-cp-abcdefghijklmnopqrstuvwxyz123456");
  assert.equal(redacted.includes("a@b.com"), false);
  assert.equal(redacted.includes("415 555 1212"), false);
  assert.equal(redacted.includes("ghp_abcdefghijklmnopqrstuvwxyz123456"), false);
  assert.equal(redacted.includes("sk-cp-abcdefghijklmnopqrstuvwxyz123456"), false);
  assert.match(redacted, /\[redacted-email\]/);
  assert.match(redacted, /\[redacted-phone\]/);
  assert.match(redacted, /\[redacted-secret\]/);
  assert.match(redacted, /\[redacted-token\]/);
});

test("knowledge detail references are bounded to avoid UI freezes", () => {
  const projectId = "proj_kb_refs_128";
  createProject(projectId);
  const cycle = storage.listCycles(projectId)[0];
  storage.createKnowledge({
    id: "kb_ref_limit",
    projectId,
    type: "fact",
    title: "Reference limit fixture",
    content: "A knowledge item referenced by many agent runs.",
    sourceType: "test",
    sourceRef: "fixture",
    evidenceAlpha: 1,
    evidenceBeta: 1,
    confidenceScore: 0.5,
    confidenceLevel: "low",
    status: "active",
    humanApprovedCount: 0,
    externalVerifiedCount: 0,
    validFrom: "2026-06-04",
    validUntil: null,
    lastValidatedCycle: 1,
    createdByCycle: 1,
    createdBy: "test",
    approvedBy: null,
    usageCount: 0,
    tags: "[]",
    notes: "",
    version: 1,
  });

  for (let i = 0; i < 500; i += 1) {
    storage.recordAgentRun({
      cycleId: cycle.id,
      cycleIdx: cycle.idx,
      agent: i % 2 === 0 ? "orchestrator" : "distiller",
      action: `reference fixture ${i}`,
      outputSummary: "fixture",
      knowledgeRefsUsed: JSON.stringify(["kb_ref_limit"]),
      ts: now(),
    });
  }

  const runs = storage.listAgentRunsReferencingKnowledge("kb_ref_limit", projectId, 51);
  assert.equal(runs.length, 51);
  assert.ok(runs.every((run) => JSON.parse(run.knowledgeRefsUsed).includes("kb_ref_limit")));
  assert.equal(runs[0].action, "reference fixture 499");
});

test("LLM boundary redacts PII before provider request and call logging", async () => {
  const projectId = "proj_llm_pii_119";
  createProject(projectId);
  const cycle = storage.listCycles(projectId)[0];
  const previousProvider = process.env.ALAYA_LLM_PROVIDER;
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousBaseUrl = process.env.OPENAI_BASE_URL;
  const originalFetch = globalThis.fetch;
  let requestBody = "";

  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    requestBody = String(init?.body ?? "");
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ summary: "ok" }) } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  try {
    process.env.ALAYA_LLM_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "test-api-key-not-a-real-secret";
    process.env.OPENAI_BASE_URL = "https://llm.example.test/v1";

    await callLlm({
      cycleId: cycle.id,
      agent: "sensor",
      promptName: "redaction_boundary_test",
      inputSummary: "raw email sensitive@example.com and phone +1 415 555 1212",
      context: {
        nested: {
          token: "ghp_abcdefghijklmnopqrstuvwxyz123456",
          minimax: "sk-cp-abcdefghijklmnopqrstuvwxyz123456",
        },
        notes: ["password=supersecret123", "keep this signal"],
      },
      knowledgeSummary: "contact sensitive@example.com before sending to LLM",
      prohibited: ["Never expose +1 415 555 1212"],
      schema: {
        type: "object",
        required: ["summary"],
        additionalProperties: true,
        properties: { summary: { type: "string" } },
      },
      mockOutput: { summary: "mock would include sensitive@example.com" },
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (previousProvider == null) delete process.env.ALAYA_LLM_PROVIDER;
    else process.env.ALAYA_LLM_PROVIDER = previousProvider;
    if (previousApiKey == null) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    if (previousBaseUrl == null) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previousBaseUrl;
  }

  assert.equal(requestBody.includes("sensitive@example.com"), false);
  assert.equal(requestBody.includes("415 555 1212"), false);
  assert.equal(requestBody.includes("ghp_abcdefghijklmnopqrstuvwxyz123456"), false);
  assert.equal(requestBody.includes("sk-cp-abcdefghijklmnopqrstuvwxyz123456"), false);
  assert.equal(requestBody.includes("supersecret123"), false);
  assert.match(requestBody, /\[redacted-email\]/);
  assert.match(requestBody, /\[redacted-phone\]/);
  assert.match(requestBody, /\[redacted-secret\]|\[redacted-token\]/);

  const call = storage.listLlmCalls().find((item) => item.cycleId === cycle.id && item.promptVersion === "redaction_boundary_test@v1");
  assert.ok(call);
  const logged = `${call.inputSummary}\n${call.outputSummary}`;
  assert.equal(logged.includes("sensitive@example.com"), false);
  assert.equal(logged.includes("415 555 1212"), false);
  assert.equal(logged.includes("ghp_abcdefghijklmnopqrstuvwxyz123456"), false);
  assert.equal(logged.includes("sk-cp-abcdefghijklmnopqrstuvwxyz123456"), false);
  assert.match(call.inputSummary, /\[redacted-email\]/);
  assert.equal(call.schemaValid, 1);
});

test("app LLM disables MiniMax thinking and parses JSON after thinking blocks", async () => {
  const projectId = "proj_llm_minimax_130";
  createProject(projectId);
  const cycle = storage.listCycles(projectId)[0];
  const previousProvider = process.env.ALAYA_LLM_PROVIDER;
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousBaseUrl = process.env.OPENAI_BASE_URL;
  const previousModel = process.env.OPENAI_MODEL;
  const originalFetch = globalThis.fetch;
  let requestBody = "";

  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    requestBody = String(init?.body ?? "");
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: '<think>{"draft":"not the answer"}</think>\n{"summary":"ok","category":"unclear_signal"}',
        },
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  try {
    process.env.ALAYA_LLM_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "test-api-key-not-a-real-secret";
    process.env.OPENAI_BASE_URL = "https://api.minimax.io/openai";
    process.env.OPENAI_MODEL = "MiniMax-M3";

    const output = await callLlm({
      cycleId: cycle.id,
      agent: "sensor",
      promptName: "minimax_thinking_parse_test",
      inputSummary: "parse MiniMax thinking wrapper",
      mockOutput: { summary: "draft", category: "unclear_signal" },
      schema: {
        type: "object",
        required: ["summary", "category"],
        additionalProperties: true,
        properties: {
          summary: { type: "string" },
          category: { type: "string" },
        },
      },
    });

    assert.equal(output.category, "unclear_signal");
    const body = JSON.parse(requestBody) as Record<string, unknown>;
    assert.deepEqual(body.thinking, { type: "disabled" });
    assert.equal(body.max_tokens, 512);
    assert.match(requestBody, /draft_output/);
    const call = storage.listLlmCalls().find((item) => item.cycleId === cycle.id && item.promptVersion === "minimax_thinking_parse_test@v1");
    assert.equal(call?.schemaValid, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousProvider == null) delete process.env.ALAYA_LLM_PROVIDER;
    else process.env.ALAYA_LLM_PROVIDER = previousProvider;
    if (previousApiKey == null) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    if (previousBaseUrl == null) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previousBaseUrl;
    if (previousModel == null) delete process.env.OPENAI_MODEL;
    else process.env.OPENAI_MODEL = previousModel;
  }
});

test("app LLM reads the local key file when OPENAI_API_KEY is an empty env var", async () => {
  const projectId = "proj_llm_file_121";
  createProject(projectId);
  const cycle = storage.listCycles(projectId)[0];
  const previousProvider = process.env.ALAYA_LLM_PROVIDER;
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousApiKeyFile = process.env.OPENAI_API_KEY_FILE;
  const previousBaseUrl = process.env.OPENAI_BASE_URL;
  const keyDir = mkdtempSync(join(tmpdir(), "alaya-app-openai-key-"));
  const keyFile = join(keyDir, "key.txt");
  writeFileSync(keyFile, "test-openai-key-from-file\n", "utf8");
  const originalFetch = globalThis.fetch;
  let authHeader = "";

  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined;
    authHeader = headers?.Authorization ?? headers?.authorization ?? "";
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ summary: "file key accepted" }) } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  try {
    process.env.ALAYA_LLM_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "";
    process.env.OPENAI_API_KEY_FILE = keyFile;
    process.env.OPENAI_BASE_URL = "https://llm.example.test/v1";

    const output = await callLlm({
      cycleId: cycle.id,
      agent: "sensor",
      promptName: "file_key_fallback_test",
      inputSummary: "use local key file",
      mockOutput: { summary: "mock" },
      schema: {
        type: "object",
        required: ["summary"],
        additionalProperties: true,
        properties: { summary: { type: "string" } },
      },
    });

    assert.equal(output.summary, "file key accepted");
    assert.equal(authHeader, "Bearer test-openai-key-from-file");
    const gate = storage.listGates(projectId).find((item) => item.id.startsWith("gate_llm_sensor_"));
    assert.equal(gate, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousProvider == null) delete process.env.ALAYA_LLM_PROVIDER;
    else process.env.ALAYA_LLM_PROVIDER = previousProvider;
    if (previousApiKey == null) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    if (previousApiKeyFile == null) delete process.env.OPENAI_API_KEY_FILE;
    else process.env.OPENAI_API_KEY_FILE = previousApiKeyFile;
    if (previousBaseUrl == null) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previousBaseUrl;
  }
});

test("app LLM times out hung provider requests and opens a non-blocking gate", async () => {
  const projectId = "proj_llm_timeout_122";
  createProject(projectId);
  const cycle = storage.listCycles(projectId)[0];
  const previousProvider = process.env.ALAYA_LLM_PROVIDER;
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousBaseUrl = process.env.OPENAI_BASE_URL;
  const previousTimeout = process.env.OPENAI_REQUEST_TIMEOUT_MS;
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
    process.env.ALAYA_LLM_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "test-api-key-not-a-real-secret";
    process.env.OPENAI_BASE_URL = "https://llm.example.test/v1";
    process.env.OPENAI_REQUEST_TIMEOUT_MS = "1";

    const output = await callLlm({
      cycleId: cycle.id,
      agent: "sensor",
      promptName: "timeout_provider_test",
      inputSummary: "timeout provider",
      mockOutput: { summary: "mock" },
      schema: {
        type: "object",
        required: ["summary", "category"],
        additionalProperties: true,
        properties: {
          summary: { type: "string" },
          category: { type: "string" },
        },
      },
      simplifiedSchema: {
        type: "object",
        required: ["summary"],
        additionalProperties: true,
        properties: { summary: { type: "string" } },
      },
    });

    assert.equal(calls, 3);
    assert.match(String(output.summary ?? ""), /timed out/);
    const gate = storage.listGates(projectId).find((item) => item.id.startsWith("gate_llm_sensor_"));
    assert.ok(gate);
    assert.equal(gate.blocking, 0);
    assert.equal(gate.status, "pending");
    assert.match(JSON.parse(gate.payload).reason, /timed out/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousProvider == null) delete process.env.ALAYA_LLM_PROVIDER;
    else process.env.ALAYA_LLM_PROVIDER = previousProvider;
    if (previousApiKey == null) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    if (previousBaseUrl == null) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previousBaseUrl;
    if (previousTimeout == null) delete process.env.OPENAI_REQUEST_TIMEOUT_MS;
    else process.env.OPENAI_REQUEST_TIMEOUT_MS = previousTimeout;
  }
});

test("app LLM falls back to simplified schema before opening a non-blocking gate", async () => {
  const projectId = "proj_llm_simple_120";
  createProject(projectId);
  const cycle = storage.listCycles(projectId)[0];
  const previousProvider = process.env.ALAYA_LLM_PROVIDER;
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousBaseUrl = process.env.OPENAI_BASE_URL;
  const originalFetch = globalThis.fetch;
  const requestBodies: string[] = [];

  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    requestBodies.push(String(init?.body ?? ""));
    const content = requestBodies.length < 3
      ? { summary: "full schema missing required fields" }
      : { summary: "simplified schema accepted" };
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(content) } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  let result: Record<string, unknown>;
  try {
    process.env.ALAYA_LLM_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "test-api-key-not-a-real-secret";
    process.env.OPENAI_BASE_URL = "https://llm.example.test/v1";

    result = await callLlm({
      cycleId: cycle.id,
      agent: "sensor",
      promptName: "simplified_schema_test",
      inputSummary: "classify noisy external feedback",
      context: { text: "please classify this" },
      schema: {
        type: "object",
        required: ["summary", "category", "sentiment", "topicKey"],
        additionalProperties: true,
        properties: {
          summary: { type: "string" },
          category: { type: "string" },
          sentiment: { type: "string" },
          topicKey: { type: "string" },
        },
      },
      mockOutput: { summary: "mock", category: "unclear_signal", sentiment: "neutral", topicKey: "mock" },
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (previousProvider == null) delete process.env.ALAYA_LLM_PROVIDER;
    else process.env.ALAYA_LLM_PROVIDER = previousProvider;
    if (previousApiKey == null) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    if (previousBaseUrl == null) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previousBaseUrl;
  }

  assert.equal(requestBodies.length, 3);
  assert.equal(result!.summary, "simplified schema accepted");
  assert.match(requestBodies[2], /return simplified JSON summary only/);

  const call = storage.listLlmCalls().find((item) => item.cycleId === cycle.id && item.promptVersion === "simplified_schema_test@v1");
  assert.ok(call);
  assert.equal(call.schemaValid, 0);
  assert.equal(call.retryCount, 2);
  assert.match(call.outputSummary, /simplified schema accepted/);

  const gate = storage.listGates(projectId).find((item) => item.cycleId === cycle.id && item.id.startsWith("gate_llm_sensor_"));
  assert.ok(gate);
  assert.equal(gate.blocking, 0);
  assert.equal(gate.status, "pending");
  assert.match(JSON.parse(gate.payload).reason, /simplified schema/);
});

test("app LLM promotes simplified retry when it satisfies the original schema", async () => {
  const projectId = "proj_llm_promote_131";
  createProject(projectId);
  const cycle = storage.listCycles(projectId)[0];
  const previousProvider = process.env.ALAYA_LLM_PROVIDER;
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousBaseUrl = process.env.OPENAI_BASE_URL;
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = (async (_url: string | URL | Request, _init?: RequestInit) => {
    calls++;
    const content = calls < 3
      ? { summary: "full schema missing required fields" }
      : { summary: "simplified retry returned full data", category: "unclear_signal", sentiment: "neutral", topicKey: "setup" };
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(content) } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  let result: Record<string, unknown>;
  try {
    process.env.ALAYA_LLM_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "test-api-key-not-a-real-secret";
    process.env.OPENAI_BASE_URL = "https://llm.example.test/v1";

    result = await callLlm({
      cycleId: cycle.id,
      agent: "sensor",
      promptName: "promote_simplified_schema_test",
      inputSummary: "classify noisy external feedback",
      schema: {
        type: "object",
        required: ["summary", "category", "sentiment", "topicKey"],
        additionalProperties: true,
        properties: {
          summary: { type: "string" },
          category: { type: "string" },
          sentiment: { type: "string" },
          topicKey: { type: "string" },
        },
      },
      mockOutput: { summary: "mock", category: "unclear_signal", sentiment: "neutral", topicKey: "mock" },
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (previousProvider == null) delete process.env.ALAYA_LLM_PROVIDER;
    else process.env.ALAYA_LLM_PROVIDER = previousProvider;
    if (previousApiKey == null) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    if (previousBaseUrl == null) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previousBaseUrl;
  }

  assert.equal(calls, 3);
  assert.equal(result!.category, "unclear_signal");
  const call = storage.listLlmCalls().find((item) => item.cycleId === cycle.id && item.promptVersion === "promote_simplified_schema_test@v1");
  assert.ok(call);
  assert.equal(call.schemaValid, 1);
  assert.equal(call.retryCount, 2);
  const gate = storage.listGates(projectId).find((item) => item.cycleId === cycle.id && item.id.startsWith("gate_llm_sensor_"));
  assert.equal(gate, undefined);
});

test("GitHub Issues sync redacts feedback before storage and creates a meaning gate", async () => {
  const projectId = "proj_ext_001";
  createProject(projectId);
  const cycle = storage.listCycles(projectId)[0];
  const source = upsertGithubSource(projectId, "acme", "alaya");
  const fake = installFakeGithubFetch();
  try {
    const result = await syncGithubIssuesForSource(source, cycle.id);
    assert.equal(result.fetched, 2);
    assert.equal(result.imported, 1);
    assert.equal(result.skipped, 1);
    assert.equal(result.gatesCreated, 1);
    assert.equal(result.errors.length, 0);

    const feedback = storage.listFeedback(cycle.id);
    assert.equal(feedback.length, 1);
    assert.equal(feedback[0].sourceType, "github_issues");
    assert.equal(feedback[0].sourceRef, "github:acme/alaya#42");
    assert.equal(feedback[0].sourceUrl, "https://github.com/acme/alaya/issues/42");
    assert.equal(feedback[0].topicKey, "question");
    assert.equal(Number.isFinite(Date.parse(feedback[0].externalUpdatedAt)), true);
    assert.match(feedback[0].text, /\[redacted-email\]/);
    assert.match(feedback[0].text, /\[redacted-phone\]/);
    assert.equal(feedback[0].text.includes("user@example.com"), false);
    assert.equal(feedback[0].text.includes("ghp_abcdefghijklmnopqrstuvwxyz123456"), false);

    const gate = storage.listGates(projectId).find((g) => g.id.startsWith("gate_ext_"));
    assert.ok(gate);
    assert.equal(gate.type, "meaning");
    assert.equal(gate.blocking, 0);
    assert.equal(gate.status, "pending");
    const payload = JSON.parse(gate.payload);
    assert.equal(payload.source, "github_issues");
    assert.equal(payload.userQuote.includes("user@example.com"), false);
  } finally {
    fake.restore();
  }
});

test("GitHub Issues sync can read token from a local token file", async () => {
  const previousToken = process.env.ALAYA_GITHUB_TOKEN;
  const previousGithubToken = process.env.GITHUB_TOKEN;
  const previousTokenFile = process.env.ALAYA_GITHUB_TOKEN_FILE;
  const tokenDir = mkdtempSync(join(tmpdir(), "alaya-github-token-"));
  const tokenFile = join(tokenDir, "token.txt");
  const tokenSecret = "ghp_test_github_value_that_must_not_be_printed_1234567890";
  writeFileSync(tokenFile, `${tokenSecret}\n`, "utf8");

  const projectId = "proj_github_file_111";
  createProject(projectId);
  const cycle = storage.listCycles(projectId)[0];
  const source = upsertGithubSource(projectId, "acme", "alaya");
  const fake = installFakeGithubFetch("Token file auth check");

  try {
    process.env.ALAYA_GITHUB_TOKEN = "";
    process.env.GITHUB_TOKEN = "";
    process.env.ALAYA_GITHUB_TOKEN_FILE = tokenFile;
    const result = await syncGithubIssuesForSource(source, cycle.id);
    assert.equal(result.imported, 1);
    assert.equal(fake.authHeaders[0], `Bearer ${tokenSecret}`);
    assert.equal(persistedProjectCorpus(projectId).includes(tokenSecret), false);
    assert.equal(storage.listKnowledge(projectId).length, 0);
  } finally {
    fake.restore();
    if (previousToken == null) delete process.env.ALAYA_GITHUB_TOKEN;
    else process.env.ALAYA_GITHUB_TOKEN = previousToken;
    if (previousGithubToken == null) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousGithubToken;
    if (previousTokenFile == null) delete process.env.ALAYA_GITHUB_TOKEN_FILE;
    else process.env.ALAYA_GITHUB_TOKEN_FILE = previousTokenFile;
  }
});

test("scheduler keeps GitHub sync failure blocking while speculative drafting stays at dry-run boundary", async () => {
  const projectId = "proj_ext_fail_902";
  createProject(projectId);
  upsertGithubSource(projectId, "acme", "alaya");

  const first = await schedulerTickProject(projectId);
  assert.equal(first.action, "opened_direction_gate");
  const cycle = storage.listCycles(projectId)[0];
  const directionGate = storage.listGates(projectId).find((gate) => gate.cycleId === cycle.id && gate.type === "direction");
  assert.ok(directionGate);
  approveGate(directionGate.id, "approve_recommended");

  const echoedSecret = "ghp_scheduler_failure_secret_that_must_not_leak_123456";
  const fake = installFailingGithubFetch(503, `temporary outage token=${echoedSecret}`);
  try {
    const second = await schedulerTickProject(projectId);
    assert.equal(second.action, "safety_mode");
    assert.match(second.note, /external feedback source sync failed/);
    assert.ok(fake.calls.some((url) => url.includes("/repos/acme/alaya/issues")));
  } finally {
    fake.restore();
  }

  assert.equal(storage.getCycle(cycle.id)?.status, "running");
  assert.equal(storage.listPredictions(cycle.id).length, 0);
  const source = storage.listExternalFeedbackSources(projectId)[0];
  assert.equal(source.status, "error");

  const riskGate = storage.listGates(projectId).find((gate) => {
    if (gate.type !== "risk") return false;
    const payload = JSON.parse(gate.payload);
    return payload.riskKey === "external_feedback_sync_error";
  });
  assert.ok(riskGate);
  assert.equal(riskGate.blocking, 1);
  assert.equal(riskGate.status, "pending");
  const payload = JSON.parse(riskGate.payload);
  assert.equal(payload.sourceId, source.id);
  assert.equal(payload.error.includes(echoedSecret), false);
  assert.match(payload.error, /\[redacted-secret\]|\[redacted-token\]/);
  assert.match(payload.reason, /不能把本轮无新增反馈解释为真实外部沉默/);
  assert.match(payload.requiredAction, /GitHub token|仓库权限|API/);
  assert.equal(persistedProjectCorpus(projectId).includes(echoedSecret), false);

  const third = await schedulerTickProject(projectId);
  assert.equal(third.action, "created_speculative_draft");
  const speculative = storage.getCycle(third.nextCycleId ?? "");
  assert.equal(speculative?.speculative, 1);
  assert.equal(speculative?.draftStatus, "ready_awaiting_approval");
  assert.equal(storage.listPredictions(cycle.id).length, 0);
  assert.equal(storage.listObservations(cycle.id).length, 0);
  assert.equal(storage.listGates(projectId).filter((gate) => gate.type === "risk" && JSON.parse(gate.payload).riskKey === "external_feedback_sync_error").length, 1);
});

test("form feedback ingestion redacts text, classifies it and opens a meaning gate without writing knowledge", async () => {
  const projectId = "proj_form_222";
  createProject(projectId);

  const result = await ingestFormFeedback(projectId, {
    sourceName: "typeform",
    externalId: "resp_001",
    title: "Setup is confusing",
    text: "I am afraid to publish. Email user@example.com phone +1 415 555 1212 key sk-cp-abcdefghijklmnopqrstuvwxyz123456",
    url: "https://example.com/forms/resp_001",
  });

  assert.equal(result.imported, true);
  assert.equal(result.skipped, false);
  assert.equal(result.feedback.text.includes("user@example.com"), false);
  assert.equal(result.feedback.text.includes("sk-cp-abcdefghijklmnopqrstuvwxyz123456"), false);
  assert.equal(result.feedback.sourceType, "form_feedback");
  assert.equal(result.feedback.sourceRef, "typeform:resp_001");
  assert.equal(result.feedback.sourceUrl, "https://example.com/forms/resp_001");
  assert.equal(result.feedback.topicKey.length > 0, true);
  assert.equal(result.feedback.summary.length > 0, true);
  assert.match(result.feedback.text, /\[redacted-email\]/);
  assert.match(result.feedback.text, /\[redacted-token\]/);

  const gate = result.gate;
  assert.ok(gate);
  assert.equal(gate.type, "meaning");
  assert.equal(gate.blocking, 0);
  assert.equal(gate.status, "pending");
  const payload = JSON.parse(gate.payload);
  assert.equal(payload.source, "form_feedback");
  assert.equal(payload.sourceName, "typeform");
  assert.equal(payload.externalId, "resp_001");
  assert.equal(payload.userQuote.includes("user@example.com"), false);
  assert.equal(payload.userQuote.includes("sk-cp-abcdefghijklmnopqrstuvwxyz123456"), false);
  assert.equal(storage.listKnowledge(projectId).length, 0);

  const duplicate = await ingestFormFeedback(projectId, {
    sourceName: "typeform",
    externalId: "resp_001",
    title: "Setup is confusing",
    text: "same response",
  });
  assert.equal(duplicate.skipped, true);
  assert.equal(storage.listFeedback(result.feedback.cycleId).filter((f) => f.id.includes("fb_form_")).length, 1);
});

test("scheduler opens one blocking risk gate when weekly LLM cost exceeds the project budget", async () => {
  const projectId = "proj_cost_444";
  createProject(projectId);
  const cycle = storage.listCycles(projectId)[0];
  storage.updateProject(projectId, { weeklyLlmBudgetCents: 1 });
  storage.recordLlmCall({
    cycleId: cycle.id,
    agent: "orchestrator",
    promptVersion: "test.cost_budget.v1",
    inputSummary: "cost budget smoke",
    outputSummary: "cost overrun",
    schemaValid: 1,
    retryCount: 0,
    latencyMs: 10,
    tokenCount: 1000,
    estimatedCost: 0.05,
    ts: now(),
  });

  const first = await schedulerTickProject(projectId);
  assert.equal(first.action, "safety_mode");
  assert.match(first.note, /LLM cost budget exceeded/);
  assert.ok(first.llmBudget?.overBudget);
  assert.ok(first.llmBudget?.pendingBudgetGate);

  const gates = storage.listGates(projectId).filter((g) => g.type === "risk" && g.blocking === 1 && g.title === "LLM 成本预算闸");
  assert.equal(gates.length, 1);
  const payload = JSON.parse(gates[0].payload);
  assert.equal(payload.riskKey, "llm_weekly_budget");
  assert.equal(payload.budgetCents, 1);
  assert.equal(payload.usedUsd, 0.05);
  assert.match(payload.requiredAction, /提高预算|暂停高成本/);

  const second = await schedulerTickProject(projectId);
  assert.equal(second.action, "safety_mode");
  assert.equal(storage.listGates(projectId).filter((g) => g.title === "LLM 成本预算闸").length, 1);
});

test("scheduler pauses when cycle 4 direction cannot explain how prior knowledge changed the decision", async () => {
  const projectId = "proj_empty_991";
  createProject(projectId);
  const cycle1 = storage.listCycles(projectId)[0];
  storage.updateCycle(cycle1.id, { status: "closed", reasoning: "training cycle 1" });
  storage.createCycle({
    id: `cycle_2_${projectId.slice(-4)}`,
    projectId,
    idx: 2,
    goal: "training cycle 2",
    status: "closed",
    eCycle: 0,
    worstClaimError: 0,
    reasoning: "training cycle 2",
    version: 1,
  });
  storage.createCycle({
    id: `cycle_3_${projectId.slice(-4)}`,
    projectId,
    idx: 3,
    goal: "training cycle 3",
    status: "closed",
    eCycle: 0,
    worstClaimError: 0,
    reasoning: "training cycle 3",
    version: 1,
  });
  const cycle4 = storage.createCycle({
    id: `cycle_4_${projectId.slice(-4)}`,
    projectId,
    idx: 4,
    goal: "Add another generic automation",
    status: "planning",
    eCycle: null,
    worstClaimError: null,
    reasoning: "",
    version: 1,
  });
  storage.updateProject(projectId, { currentCycleIdx: 4 });
  storage.createGate({
    id: `gate_dir_weak_${projectId}`,
    cycleId: cycle4.id,
    type: "direction",
    blocking: 1,
    title: "第 4 轮方向闸",
    payload: JSON.stringify({
      recommended: "Add another generic automation",
      knowledgeRefs: [],
      reasoning: "Continue with the next useful feature.",
      createdAt: now(),
    }),
    status: "pending",
    estimatedMinutes: 10,
    decision: null,
    version: 1,
  });

  const first = await schedulerTickProject(projectId);
  assert.equal(first.action, "safety_mode");
  assert.match(first.note, /compounding guard/);

  const riskGates = storage.listGates(projectId).filter((gate) => {
    if (gate.type !== "risk") return false;
    const payload = JSON.parse(gate.payload);
    return payload.riskKey === "flywheel_empty_learning";
  });
  assert.equal(riskGates.length, 1);
  assert.equal(riskGates[0].blocking, 1);
  assert.match(riskGates[0].title, /飞轮空转/);
  const payload = JSON.parse(riskGates[0].payload);
  assert.deepEqual(payload.previousCycleIdxs, [1, 2, 3]);
  assert.equal(payload.knowledgeRefsCount, 0);
  assert.match(payload.requiredAction, /Orchestrator reasoning/);

  const second = await schedulerTickProject(projectId);
  assert.equal(second.action, "safety_mode");
  assert.equal(storage.listGates(projectId).filter((gate) => gate.type === "risk" && JSON.parse(gate.payload).riskKey === "flywheel_empty_learning").length, 1);
});

test("scheduler pauses before next cycle when prediction lacks measurable claims", async () => {
  const projectId = "proj_pred_884";
  createProject(projectId);
  const cycle = storage.listCycles(projectId)[0];
  storage.updateCycle(cycle.id, { status: "closed", reasoning: "closed with qualitative-only prediction" });
  storage.createPrediction({
    id: `pred_qual_${projectId}`,
    cycleId: cycle.id,
    belief: "Users may feel better",
    prediction: "Users will feel that the product is nicer",
    action: "Polish the page",
    claims: JSON.stringify([{ id: "claim_feels_nicer", type: "qualitative", weight: 1 }]),
    observation: null,
    predictionError: null,
    worstClaimError: null,
    errorType: null,
    updateTarget: null,
    status: "resolved",
    knowledgeRefs: JSON.stringify([]),
  });

  const first = await schedulerTickProject(projectId);
  assert.equal(first.action, "safety_mode");
  assert.match(first.note, /prediction measurability guard/);
  assert.equal(storage.listCycles(projectId).some((item) => item.idx === 2), false);

  const riskGate = storage.listGates(projectId).find((gate) => {
    if (gate.type !== "risk") return false;
    const payload = JSON.parse(gate.payload);
    return payload.riskKey === "prediction_measurability_failure";
  });
  assert.ok(riskGate);
  assert.equal(riskGate.blocking, 1);
  const payload = JSON.parse(riskGate.payload);
  assert.equal(payload.predictionCount, 1);
  assert.equal(payload.failures[0].predictionId, `pred_qual_${projectId}`);
  assert.deepEqual(payload.failures[0].claimTypes, ["qualitative"]);
  assert.match(payload.failures[0].reasons.join(","), /qualitative_only/);
  assert.match(payload.requiredAction, /measurable claim/);

  const second = await schedulerTickProject(projectId);
  assert.equal(second.action, "safety_mode");
  assert.equal(storage.listGates(projectId).filter((gate) => gate.type === "risk" && JSON.parse(gate.payload).riskKey === "prediction_measurability_failure").length, 1);
});

test("scheduler pauses before next cycle when measurable claim lacks prediction contract", async () => {
  const projectId = "proj_pred_contract_885";
  createProject(projectId);
  const cycle = storage.listCycles(projectId)[0];
  storage.updateCycle(cycle.id, { status: "closed", reasoning: "closed with underspecified measurable prediction" });
  storage.createPrediction({
    id: `pred_contract_${projectId}`,
    cycleId: cycle.id,
    belief: "Activation should improve",
    prediction: "activation should exceed threshold",
    action: "continue cycle",
    claims: JSON.stringify([{
      id: "claim_activation",
      type: "metric_threshold",
      metric: "activation_rate",
      operator: ">=",
      target: 0.3,
      observed: 0.4,
      weight: 3,
    }]),
    observation: "activation_rate = 0.4",
    predictionError: 0,
    worstClaimError: 0,
    errorType: null,
    updateTarget: null,
    status: "resolved",
    knowledgeRefs: JSON.stringify([]),
  });

  const first = await schedulerTickProject(projectId);
  assert.equal(first.action, "safety_mode");
  assert.match(first.note, /prediction measurability guard/);

  const riskGate = storage.listGates(projectId).find((gate) => {
    if (gate.type !== "risk") return false;
    const payload = JSON.parse(gate.payload);
    return payload.riskKey === "prediction_measurability_failure";
  });
  assert.ok(riskGate);
  const payload = JSON.parse(riskGate.payload);
  assert.match(payload.failures[0].reasons.join(","), /missing_prediction_contract/);
  assert.deepEqual(payload.failures[0].contractMissing[0].missing, [
    "expected_observation",
    "time_window",
    "success_threshold",
    "failure_threshold",
    "uncertainty",
  ]);
  assert.match(payload.requiredAction, /expected_observation/);
});

test("scheduler pauses when active knowledge grows without strong maturation", async () => {
  const projectId = "proj_km_stall_118";
  createProject(projectId);
  const cycle1 = storage.listCycles(projectId)[0];
  storage.updateCycle(cycle1.id, { status: "closed", reasoning: "cycle 1 closed" });
  for (const idx of [2, 3, 4]) {
    storage.createCycle({
      id: `cycle_${idx}_${projectId.slice(-4)}`,
      projectId,
      idx,
      goal: `cycle ${idx} goal`,
      status: "closed",
      eCycle: 0,
      worstClaimError: 0,
      reasoning: `cycle ${idx} closed`,
      version: 1,
    });
  }
  storage.updateProject(projectId, { currentCycleIdx: 4 });
  const cycle4 = storage.listCycles(projectId).find((cycle) => cycle.idx === 4);
  assert.ok(cycle4);
  storage.createPrediction({
    id: `pred_measurable_${projectId}`,
    cycleId: cycle4.id,
    belief: "The system is learning",
    prediction: "activation should exceed threshold",
    action: "continue cycle",
    claims: JSON.stringify([measurableActivationClaim()]),
    observation: "activation_rate = 0.4",
    predictionError: 0,
    worstClaimError: 0,
    errorType: null,
    updateTarget: null,
    status: "resolved",
    knowledgeRefs: JSON.stringify([]),
  });

  storage.createKnowledge({
    id: `kb_old_strong_${projectId}`,
    projectId,
    type: "principle",
    title: "旧 strong 知识",
    content: "早期已经成熟过的一条强知识。",
    sourceType: "human_decision",
    sourceRef: "cycle_1",
    evidenceAlpha: 8,
    evidenceBeta: 1,
    confidenceScore: 0.89,
    confidenceLevel: "verified",
    status: "strong",
    humanApprovedCount: 1,
    externalVerifiedCount: 1,
    validFrom: now().slice(0, 10),
    validUntil: null,
    lastValidatedCycle: 1,
    createdByCycle: 1,
    createdBy: "distiller",
    approvedBy: "owner",
    usageCount: 1,
    tags: JSON.stringify(["old_strong"]),
    notes: "baseline strong item",
    version: 1,
  });

  for (let i = 1; i <= 10; i++) {
    const cycleIdx = 2 + (i % 3);
    storage.createKnowledge({
      id: `kb_active_stalled_${projectId}_${i}`,
      projectId,
      type: "case",
      title: `未成熟 active 知识 ${i}`,
      content: `最近沉淀但没有晋级 strong 的知识 ${i}`,
      sourceType: "feedback",
      sourceRef: `f_${i}`,
      evidenceAlpha: 2,
      evidenceBeta: 1,
      confidenceScore: 0.67,
      confidenceLevel: "medium",
      status: "active",
      humanApprovedCount: 0,
      externalVerifiedCount: 0,
      validFrom: now().slice(0, 10),
      validUntil: null,
      lastValidatedCycle: cycleIdx,
      createdByCycle: cycleIdx,
      createdBy: "distiller",
      approvedBy: null,
      usageCount: 0,
      tags: JSON.stringify(["stalled_active"]),
      notes: "active knowledge without strong maturation",
      version: 1,
    });
  }

  const first = await schedulerTickProject(projectId);
  assert.equal(first.action, "safety_mode");
  assert.match(first.note, /knowledge maturity guard/);
  assert.equal(storage.listCycles(projectId).some((cycle) => cycle.idx === 5), false);

  const riskGate = storage.listGates(projectId).find((gate) => {
    if (gate.type !== "risk") return false;
    const payload = JSON.parse(gate.payload);
    return payload.riskKey === "knowledge_maturity_stagnation";
  });
  assert.ok(riskGate);
  assert.equal(riskGate.blocking, 1);
  assert.equal(riskGate.status, "pending");
  const payload = JSON.parse(riskGate.payload);
  assert.equal(payload.activeCount, 10);
  assert.equal(payload.strongCount, 1);
  assert.equal(payload.recentStrongCount, 0);
  assert.ok(payload.strongShare < 0.15);
  assert.match(payload.requiredAction, /Distiller|Librarian|strong/);

  const second = await schedulerTickProject(projectId);
  assert.equal(second.action, "safety_mode");
  assert.equal(storage.listGates(projectId).filter((gate) => gate.type === "risk" && JSON.parse(gate.payload).riskKey === "knowledge_maturity_stagnation").length, 1);
});

test("scheduler pauses when Librarian leaves stale or conflicting knowledge decision-eligible", async () => {
  const projectId = "proj_lib_audit_339";
  createProject(projectId);
  const cycle = storage.listCycles(projectId)[0];
  storage.updateCycle(cycle.id, { status: "closed", reasoning: "closed with stale knowledge audit risk" });
  storage.createPrediction({
    id: `pred_lib_audit_${projectId}`,
    cycleId: cycle.id,
    belief: "Knowledge should be audited before expansion",
    prediction: "activation should exceed threshold",
    action: "continue cycle",
    claims: JSON.stringify([measurableActivationClaim()]),
    observation: "activation_rate = 0.4",
    predictionError: 0,
    worstClaimError: 0,
    errorType: null,
    updateTarget: null,
    status: "resolved",
    knowledgeRefs: JSON.stringify([]),
  });
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  storage.createKnowledge({
    id: `kb_unmarked_stale_${projectId}`,
    projectId,
    type: "fact",
    title: "已过期但仍 active 的知识",
    content: "这条知识已经超过 validUntil，却仍然可以被用于决策。",
    sourceType: "external_doc",
    sourceRef: "doc_old",
    evidenceAlpha: 3,
    evidenceBeta: 1,
    confidenceScore: 0.75,
    confidenceLevel: "high",
    status: "active",
    humanApprovedCount: 0,
    externalVerifiedCount: 1,
    validFrom: "2026-01-01",
    validUntil: yesterday,
    lastValidatedCycle: 1,
    createdByCycle: 1,
    createdBy: "distiller",
    approvedBy: null,
    usageCount: 0,
    tags: JSON.stringify(["expired_signal"]),
    notes: "should have been marked stale",
    version: 1,
  });
  storage.createKnowledge({
    id: `kb_guard_strong_${projectId}`,
    projectId,
    type: "principle",
    title: "Activation threshold guard",
    content: "activation_rate >= 0.8",
    sourceType: "feedback",
    sourceRef: "f_strong",
    evidenceAlpha: 6,
    evidenceBeta: 1,
    confidenceScore: 0.9,
    confidenceLevel: "high",
    status: "strong",
    humanApprovedCount: 1,
    externalVerifiedCount: 1,
    validFrom: now().slice(0, 10),
    validUntil: null,
    lastValidatedCycle: 1,
    createdByCycle: 1,
    createdBy: "distiller",
    approvedBy: "human",
    usageCount: 0,
    tags: JSON.stringify(["activation"]),
    notes: "current strong activation threshold",
    version: 1,
  });
  storage.createKnowledge({
    id: `kb_unmarked_conflict_${projectId}`,
    projectId,
    type: "principle",
    title: "Activation threshold guard",
    content: "This item contradicts strong knowledge: activation_rate <= 0.2.",
    sourceType: "feedback",
    sourceRef: "f_conflict",
    evidenceAlpha: 3,
    evidenceBeta: 1,
    confidenceScore: 0.75,
    confidenceLevel: "high",
    status: "active",
    humanApprovedCount: 0,
    externalVerifiedCount: 1,
    validFrom: now().slice(0, 10),
    validUntil: null,
    lastValidatedCycle: 1,
    createdByCycle: 1,
    createdBy: "distiller",
    approvedBy: null,
    usageCount: 0,
    tags: JSON.stringify(["conflict_with_strong"]),
    notes: `conflict_with_strong: kb_guard_strong_${projectId}`,
    semanticKey: "activation_threshold_guard",
    version: 1,
  });

  const first = await schedulerTickProject(projectId);
  assert.equal(first.action, "safety_mode");
  assert.match(first.note, /librarian stale\/conflict audit guard/);
  assert.equal(storage.listCycles(projectId).some((item) => item.idx === 2), false);

  const riskGate = storage.listGates(projectId).find((gate) => {
    if (gate.type !== "risk") return false;
    const payload = JSON.parse(gate.payload);
    return payload.riskKey === "librarian_stale_conflict_audit_failure";
  });
  assert.ok(riskGate);
  assert.equal(riskGate.blocking, 1);
  assert.equal(riskGate.status, "pending");
  const payload = JSON.parse(riskGate.payload);
  assert.deepEqual(payload.unmarkedStaleIds, [`kb_unmarked_stale_${projectId}`]);
  assert.deepEqual(payload.unmarkedConflictIds, []);
  assert.match(payload.requiredAction, /stale|conflict|Librarian/);
  const conflictKnowledge = storage.getKnowledge(`kb_unmarked_conflict_${projectId}`);
  assert.equal(conflictKnowledge?.status, "conflict");
  const conflictReview = storage.listKnowledgeReviews(projectId).find((review) => (
    review.reviewType === "conflict" &&
    review.status === "review_required" &&
    review.primaryKnowledgeId === `kb_unmarked_conflict_${projectId}`
  ));
  assert.ok(conflictReview);
  const conflictGate = storage.getGate(`gate_${conflictReview.id}`);
  assert.equal(conflictGate?.type, "risk");
  assert.equal(conflictGate?.blocking, 1);

  const second = await schedulerTickProject(projectId);
  assert.equal(second.action, "safety_mode");
  assert.equal(storage.listGates(projectId).filter((gate) => gate.type === "risk" && JSON.parse(gate.payload).riskKey === "librarian_stale_conflict_audit_failure").length, 1);
});

test("gate budget only counts gates resolved in the current week", () => {
  const projectId = "proj_budget_555";
  createProject(projectId);
  const cycle = storage.listCycles(projectId)[0];
  const twoWeeksAgo = new Date(Date.now() - 14 * 86_400_000).toISOString();

  storage.createGate({
    id: `gate_old_budget_${projectId}`,
    cycleId: cycle.id,
    type: "meaning",
    blocking: 0,
    title: "历史意义闸",
    payload: JSON.stringify({ resolvedAt: twoWeeksAgo }),
    status: "approved",
    estimatedMinutes: 50,
    decision: "approve",
    version: 1,
  });
  storage.createGate({
    id: `gate_current_budget_${projectId}`,
    cycleId: cycle.id,
    type: "meaning",
    blocking: 0,
    title: "本周意义闸",
    payload: JSON.stringify({ createdAt: now() }),
    status: "pending",
    estimatedMinutes: 10,
    decision: null,
    version: 1,
  });

  approveGate(`gate_current_budget_${projectId}`, "approve");
  const budget = gateBudgetForProject(projectId);
  assert.equal(budget.used, 10);
  assert.equal(budget.remaining, 110);
});

test("scheduler throttles when pending human gate backlog exceeds twice the weekly budget", async () => {
  const projectId = "proj_human_load_332";
  createProject(projectId);
  const cycle = storage.listCycles(projectId)[0];
  storage.updateProject(projectId, { weeklyHumanMinutes: 30 });

  for (let i = 1; i <= 10; i++) {
    storage.createGate({
      id: `gate_human_load_${projectId}_${i}`,
      cycleId: cycle.id,
      type: "meaning",
      blocking: 0,
      title: `待处理意义闸 ${i}`,
      payload: JSON.stringify({
        topicKey: `unique_attention_topic_${i}`,
        userQuote: `quote ${i}`,
        createdAt: now(),
      }),
      status: "pending",
      estimatedMinutes: 8,
      decision: null,
      version: 1,
    });
  }

  const first = await schedulerTickProject(projectId);
  assert.equal(first.action, "safety_throttled");
  assert.match(first.note, /human attention backlog over budget/);
  assert.equal(first.budget.pendingEstimatedMinutes, 95);
  assert.equal(first.budget.pendingOverBudget2x, true);

  const riskGate = storage.listGates(projectId).find((gate) => {
    if (gate.type !== "risk") return false;
    const payload = JSON.parse(gate.payload);
    return payload.riskKey === "human_attention_overload";
  });
  assert.ok(riskGate);
  assert.equal(riskGate.blocking, 1);
  assert.equal(riskGate.status, "pending");
  const payload = JSON.parse(riskGate.payload);
  assert.equal(payload.budgetMinutes, 30);
  assert.equal(payload.pendingEstimatedMinutes, 80);
  assert.equal(payload.pendingOverBudget2x, true);
  assert.match(payload.requiredAction, /低速模式|合并/);

  const second = await schedulerTickProject(projectId);
  assert.equal(second.action, "safety_throttled");
  assert.equal(second.throttledAction, "opened_direction_gate");
  assert.equal(storage.listGates(projectId).filter((gate) => gate.type === "risk" && JSON.parse(gate.payload).riskKey === "human_attention_overload").length, 1);
});

test("scheduler does not reopen human overload gate when weekly human time is high but backlog is clear", async () => {
  const projectId = "proj_human_hours_334";
  createProject(projectId);
  const cycle = storage.listCycles(projectId)[0];

  for (let i = 1; i <= 7; i++) {
    storage.createGate({
      id: `gate_human_hours_${projectId}_${i}`,
      cycleId: cycle.id,
      type: "meaning",
      blocking: 0,
      title: `已处理意义闸 ${i}`,
      payload: JSON.stringify({
        topicKey: `resolved_attention_topic_${i}`,
        userQuote: `resolved quote ${i}`,
        createdAt: now(),
        resolvedAt: now(),
      }),
      status: "approved",
      estimatedMinutes: 50,
      decision: "approve_signal",
      version: 1,
    });
  }

  const beforeTickBudget = gateBudgetForProject(projectId);
  assert.equal(beforeTickBudget.used, 350);
  assert.equal(beforeTickBudget.pendingEstimatedMinutes, 0);
  assert.equal(beforeTickBudget.pendingOverBudget2x, false);
  assert.equal(beforeTickBudget.weeklyOverFiveHours, true);

  const first = await schedulerTickProject(projectId);
  assert.equal(first.action, "opened_direction_gate");
  assert.equal(first.budget.used, 350);
  assert.equal(first.budget.weeklyOverFiveHours, true);
  assert.equal(first.budget.pendingOverBudget2x, false);

  const riskGate = storage.listGates(projectId).find((gate) => {
    if (gate.type !== "risk") return false;
    const payload = JSON.parse(gate.payload);
    return payload.riskKey === "human_attention_overload";
  });
  assert.equal(riskGate, undefined);
});

test("scheduler does not throttle solely because pending blocking gates exceed three", async () => {
  const projectId = "proj_blocking_count_335";
  createProject(projectId);
  const cycle = storage.listCycles(projectId)[0];

  for (let i = 1; i <= 4; i++) {
    storage.createGate({
      id: `gate_blocking_count_${projectId}_${i}`,
      cycleId: cycle.id,
      type: "risk",
      blocking: 1,
      title: `阻塞风险闸 ${i}`,
      payload: JSON.stringify({
        riskKey: `blocking_gate_${i}`,
        createdAt: now(),
      }),
      status: "pending",
      estimatedMinutes: 5,
      decision: null,
      version: 1,
    });
  }

  const beforeTickBudget = gateBudgetForProject(projectId);
  assert.equal(beforeTickBudget.pendingBlocking, 4);
  assert.equal(beforeTickBudget.safetyMode, false);
  assert.equal(beforeTickBudget.pendingOverBudget2x, false);

  const first = await schedulerTickProject(projectId);
  assert.notEqual(first.action, "safety_throttled");
  assert.equal(first.budget.safetyMode, false);
});

test("scheduler does not throttle solely because a blocking human gate is older than five days", async () => {
  const projectId = "proj_blocking_age_336";
  createProject(projectId);
  const cycle = storage.listCycles(projectId)[0];
  const sixDaysAgo = new Date(Date.now() - 6 * 86_400_000).toISOString();

  storage.createGate({
    id: `gate_blocking_age_${projectId}`,
    cycleId: cycle.id,
    type: "direction",
    blocking: 1,
    title: "长期未处理方向闸",
    payload: JSON.stringify({
      createdAt: sixDaysAgo,
      reason: "人工方向闸超过 5 天未处理",
    }),
    status: "pending",
    estimatedMinutes: 5,
    decision: null,
    version: 1,
  });

  const beforeTickBudget = gateBudgetForProject(projectId);
  assert.equal(beforeTickBudget.pendingBlocking, 1);
  assert.ok(beforeTickBudget.oldestBlockingAgeDays > 5);
  assert.equal(beforeTickBudget.safetyMode, false);
  assert.equal(beforeTickBudget.pendingOverBudget2x, false);

  const first = await schedulerTickProject(projectId);
  assert.notEqual(first.action, "safety_throttled");
  assert.ok(first.budget.oldestBlockingAgeDays > 5);
  assert.equal(first.budget.safetyMode, false);
});

test("scheduler throttles when a blocking gate reaches the missed-window threshold", async () => {
  const projectId = "proj_blocking_missed_windows_336";
  createProject(projectId);
  const cycle = storage.listCycles(projectId)[0];

  storage.createGate({
    id: `gate_blocking_missed_${projectId}`,
    cycleId: cycle.id,
    type: "direction",
    blocking: 1,
    title: "错过窗口方向闸",
    payload: JSON.stringify({
      createdAt: now(),
      reason: "人工方向闸已连续错过审批窗口",
    }),
    status: "pending",
    estimatedMinutes: 5,
    decision: null,
    missedWindows: 2,
    version: 1,
  });

  const beforeTickBudget = gateBudgetForProject(projectId);
  assert.equal(beforeTickBudget.pendingBlocking, 1);
  assert.equal(beforeTickBudget.safetyMode, true);
  assert.equal(beforeTickBudget.pendingOverBudget2x, false);

  const first = await schedulerTickProject(projectId);
  assert.equal(first.action, "safety_throttled");
  assert.match(first.note, /missed review window threshold/);
  assert.equal(first.budget.pendingBlocking, 1);
  assert.equal(first.budget.safetyMode, true);
  assert.equal(storage.listCycles(projectId).filter((item) => item.idx > 1).length, 0);
});

test("gate budget merges same-topic meaning gates without consuming human minutes", () => {
  const projectId = "proj_merge_565";
  createProject(projectId);
  const cycle = storage.listCycles(projectId)[0];

  for (let i = 1; i <= 3; i++) {
    storage.createGate({
      id: `gate_merge_${projectId}_${i}`,
      cycleId: cycle.id,
      type: "meaning",
      blocking: 0,
      title: `同主题意义闸 ${i}`,
      payload: JSON.stringify({
        topicKey: "repeated_setup_confusion",
        userQuote: `quote ${i}`,
        createdAt: now(),
      }),
      status: "pending",
      estimatedMinutes: 8,
      decision: null,
      version: 1,
    });
  }

  const budget = executeGateBudget(projectId);
  const gates = storage.listGates(projectId).filter((g) => g.id.startsWith(`gate_merge_${projectId}_`));
  const pending = gates.filter((g) => g.status === "pending");
  const merged = gates.filter((g) => g.decision?.startsWith("merged_into:"));

  assert.equal(pending.length, 1);
  assert.equal(merged.length, 2);
  assert.equal(merged.every((g) => g.estimatedMinutes === 0), true);
  assert.equal(budget.used, 0);
  assert.equal(budget.pendingNonBlocking, 1);

  const keeperPayload = JSON.parse(pending[0].payload);
  assert.equal(keeperPayload.mergedCount, 3);
  assert.deepEqual(keeperPayload.mergedQuotes, ["quote 1", "quote 2", "quote 3"]);
});

test("repeated high-approval meaning gates auto-approve without spending human budget and keep sampling review", () => {
  const projectId = "proj_auto_575";
  createProject(projectId);
  const cycle = storage.listCycles(projectId)[0];
  const topicKey = "known_low_value_meaning";

  for (let i = 1; i <= 10; i++) {
    storage.createGate({
      id: `gate_auto_human_${projectId}_${i}`,
      cycleId: cycle.id,
      type: "meaning",
      blocking: 0,
      title: `历史意义闸 ${i}`,
      payload: JSON.stringify({ topicKey, userQuote: `approved ${i}`, createdAt: now() }),
      status: "pending",
      estimatedMinutes: 8,
      decision: null,
      version: 1,
    });
    approveGate(`gate_auto_human_${projectId}_${i}`, "approve");
  }

  storage.createGate({
    id: `gate_auto_pending_${projectId}`,
    cycleId: cycle.id,
    type: "meaning",
    blocking: 0,
    title: "待自动批准意义闸",
    payload: JSON.stringify({ topicKey, userQuote: "same old issue", createdAt: now() }),
    status: "pending",
    estimatedMinutes: 8,
    decision: null,
    version: 1,
  });

  const firstBudget = executeGateBudget(projectId);
  const autoGate = storage.getGate(`gate_auto_pending_${projectId}`);
  assert.equal(autoGate?.status, "approved");
  assert.equal(autoGate?.decision, `auto_approved_repeated_meaning:${topicKey}`);
  assert.equal(autoGate?.estimatedMinutes, 0);
  assert.equal(firstBudget.used, 80);

  for (let i = 1; i <= 8; i++) {
    storage.createGate({
      id: `gate_auto_prior_${projectId}_${i}`,
      cycleId: cycle.id,
      type: "meaning",
      blocking: 0,
      title: `先前自动意义闸 ${i}`,
      payload: JSON.stringify({ topicKey, userQuote: `auto ${i}`, createdAt: now() }),
      status: "pending",
      estimatedMinutes: 8,
      decision: null,
      version: 1,
    });
    approveGate(`gate_auto_prior_${projectId}_${i}`, `auto_approved_repeated_meaning:${topicKey}`, {
      estimatedMinutes: 0,
    });
  }

  storage.createGate({
    id: `gate_auto_sample_${projectId}`,
    cycleId: cycle.id,
    type: "meaning",
    blocking: 0,
    title: "第十个自动候选保留抽样",
    payload: JSON.stringify({ topicKey, userQuote: "sample me", createdAt: now() }),
    status: "pending",
    estimatedMinutes: 8,
    decision: null,
    version: 1,
  });

  const secondBudget = executeGateBudget(projectId);
  const sampleGate = storage.getGate(`gate_auto_sample_${projectId}`);
  assert.equal(sampleGate?.status, "pending");
  assert.equal(sampleGate?.decision, null);
  assert.equal(secondBudget.used, 80);
  const samplePayload = JSON.parse(sampleGate?.payload ?? "{}");
  assert.equal(samplePayload.sampleReview, true);
});

test("repeated meaning gates with explicit contradiction markers are not auto-approved", () => {
  const projectId = "proj_auto_conflict_576";
  createProject(projectId);
  const cycle = storage.listCycles(projectId)[0];
  const topicKey = "bom";

  for (let i = 1; i <= 10; i++) {
    storage.createGate({
      id: `gate_auto_conflict_human_${projectId}_${i}`,
      cycleId: cycle.id,
      type: "meaning",
      blocking: 0,
      title: `历史 BOM 意义闸 ${i}`,
      payload: JSON.stringify({ topicKey, userQuote: `approved bom ${i}`, createdAt: now() }),
      status: "pending",
      estimatedMinutes: 8,
      decision: null,
      version: 1,
    });
    approveGate(`gate_auto_conflict_human_${projectId}_${i}`, "approve");
  }

  storage.createGate({
    id: `gate_auto_conflict_pending_${projectId}`,
    cycleId: cycle.id,
    type: "meaning",
    blocking: 0,
    title: "混合方案反证：BOM 与认证复杂度过高",
    payload: JSON.stringify({
      topicKey,
      userQuote: "明确冲突：该结论与混合方案推荐互相矛盾，不能同时作为 active 知识复用。",
      createdAt: now(),
    }),
    status: "pending",
    estimatedMinutes: 8,
    decision: null,
    version: 1,
  });

  const budget = executeGateBudget(projectId);
  const gate = storage.getGate(`gate_auto_conflict_pending_${projectId}`);
  assert.equal(gate?.status, "pending");
  assert.equal(gate?.decision, null);
  assert.equal(gate?.estimatedMinutes, 8);
  assert.equal(budget.pendingNonBlocking, 1);
  const payload = JSON.parse(gate?.payload ?? "{}");
  assert.equal(payload.sampleReview, true);
  assert.match(payload.sampleReviewReason, /explicit contradiction marker/);
});

test("repeated meaning gates with semantic contradictions are not auto-approved", () => {
  const projectId = "proj_auto_semantic_conflict_578";
  createProject(projectId);
  const cycle = storage.listCycles(projectId)[0];
  const topicKey = "health_sensor_choice";

  createActiveKnowledge(projectId, `kb_${projectId}_ppg`, {
    title: "静息心率监测 PPG 优先",
    content: "静息心率监测应该以 PPG 为主，PPG 更符合 7 天续航和 ¥899 成本约束。",
    tags: [topicKey],
    semanticKey: topicKey,
  });

  for (let i = 1; i <= 10; i++) {
    storage.createGate({
      id: `gate_auto_semantic_human_${projectId}_${i}`,
      cycleId: cycle.id,
      type: "meaning",
      blocking: 0,
      title: `历史传感器意义闸 ${i}`,
      payload: JSON.stringify({ topicKey, userQuote: `approved sensor note ${i}`, createdAt: now() }),
      status: "pending",
      estimatedMinutes: 8,
      decision: null,
      version: 1,
    });
    approveGate(`gate_auto_semantic_human_${projectId}_${i}`, "approve");
  }

  storage.createGate({
    id: `gate_auto_semantic_pending_${projectId}`,
    cycleId: cycle.id,
    type: "meaning",
    blocking: 0,
    title: "ECG 优先证据：医疗认证与信号可解释性",
    payload: JSON.stringify({
      topicKey,
      userQuote: "静息心率监测应以 ECG 为主，心电信号更可解释，医疗认证材料也更充分。",
      createdAt: now(),
    }),
    status: "pending",
    estimatedMinutes: 8,
    decision: null,
    version: 1,
  });

  const budget = executeGateBudget(projectId);
  const gate = storage.getGate(`gate_auto_semantic_pending_${projectId}`);
  assert.equal(gate?.status, "pending");
  assert.equal(gate?.decision, null);
  assert.equal(gate?.estimatedMinutes, 8);
  assert.equal(budget.pendingNonBlocking, 1);
  const payload = JSON.parse(gate?.payload ?? "{}");
  assert.equal(payload.sampleReview, true);
  assert.match(payload.sampleReviewReason, /semantic contradiction/);
});

test("repeated meaning gates with same-direction semantic evidence still auto-approve", () => {
  const projectId = "proj_auto_semantic_repeat_579";
  createProject(projectId);
  const cycle = storage.listCycles(projectId)[0];
  const topicKey = "health_sensor_choice_repeat";

  createActiveKnowledge(projectId, `kb_${projectId}_ppg`, {
    title: "静息心率监测 PPG 优先",
    content: "静息心率监测应该以 PPG 为主，PPG 更符合 7 天续航和 ¥899 成本约束。",
    tags: [topicKey],
    semanticKey: topicKey,
  });

  for (let i = 1; i <= 10; i++) {
    storage.createGate({
      id: `gate_auto_semantic_repeat_human_${projectId}_${i}`,
      cycleId: cycle.id,
      type: "meaning",
      blocking: 0,
      title: `历史传感器意义闸 ${i}`,
      payload: JSON.stringify({ topicKey, userQuote: `approved sensor note ${i}`, createdAt: now() }),
      status: "pending",
      estimatedMinutes: 8,
      decision: null,
      version: 1,
    });
    approveGate(`gate_auto_semantic_repeat_human_${projectId}_${i}`, "approve");
  }

  storage.createGate({
    id: `gate_auto_semantic_repeat_pending_${projectId}`,
    cycleId: cycle.id,
    type: "meaning",
    blocking: 0,
    title: "PPG 优先证据：成本与续航匹配",
    payload: JSON.stringify({
      topicKey,
      userQuote: "静息心率监测建议继续以 PPG 为主，低功耗连续采样更适合当前用户。",
      createdAt: now(),
    }),
    status: "pending",
    estimatedMinutes: 8,
    decision: null,
    version: 1,
  });

  const budget = executeGateBudget(projectId);
  const gate = storage.getGate(`gate_auto_semantic_repeat_pending_${projectId}`);
  assert.equal(gate?.status, "approved");
  assert.equal(gate?.decision, `auto_approved_repeated_meaning:${topicKey}`);
  assert.equal(gate?.estimatedMinutes, 0);
  assert.equal(budget.pendingNonBlocking, 0);
  const payload = JSON.parse(gate?.payload ?? "{}");
  assert.equal(payload.sampleReview, false);
});

test("repeated meaning gates ignore contradiction-runner source metadata when checking conflict markers", () => {
  const projectId = "proj_auto_source_577";
  createProject(projectId);
  const cycle = storage.listCycles(projectId)[0];
  const topicKey = "ppg";

  for (let i = 1; i <= 10; i++) {
    storage.createGate({
      id: `gate_auto_source_human_${projectId}_${i}`,
      cycleId: cycle.id,
      type: "meaning",
      blocking: 0,
      title: `历史 PPG 意义闸 ${i}`,
      payload: JSON.stringify({ topicKey, userQuote: `approved ppg ${i}`, createdAt: now() }),
      status: "pending",
      estimatedMinutes: 8,
      decision: null,
      version: 1,
    });
    approveGate(`gate_auto_source_human_${projectId}_${i}`, "approve");
  }

  storage.createGate({
    id: `gate_auto_source_pending_${projectId}`,
    cycleId: cycle.id,
    type: "meaning",
    blocking: 0,
    title: "PPG 优先证据：成本与续航匹配",
    payload: JSON.stringify({
      topicKey,
      userQuote: [
        "Form Feedback (health-signal-contradiction-runner sample_0133_ppg_support): PPG 优先证据：成本与续航匹配",
        "",
        "PPG 优先：光学 PPG 在静息心率监测下功耗低、BOM 成本低，更容易满足 ¥899 定价与 7 天续航。",
        "ppg_priority_score >= 0.78。",
        "当前最优选型决策：优先 PPG，置信度 0.64。",
      ].join("\n"),
      createdAt: now(),
    }),
    status: "pending",
    estimatedMinutes: 8,
    decision: null,
    version: 1,
  });

  const budget = executeGateBudget(projectId);
  const gate = storage.getGate(`gate_auto_source_pending_${projectId}`);
  assert.equal(gate?.status, "approved");
  assert.equal(gate?.decision, `auto_approved_repeated_meaning:${topicKey}`);
  assert.equal(gate?.estimatedMinutes, 0);
  assert.equal(budget.pendingNonBlocking, 0);
  const payload = JSON.parse(gate?.payload ?? "{}");
  assert.equal(payload.sampleReview, false);
});

test("scheduler pauses after repeated builder task specs misdirect external tools", async () => {
  const projectId = "proj_builder_mis_447";
  createProject(projectId);
  const cycle = storage.listCycles(projectId)[0];

  for (const idx of [1, 2]) {
    storage.createTask({
      id: `task_misdirected_${projectId}_${idx}`,
      cycleId: cycle.id,
      agent: "builder",
      kind: "build",
      status: "failed",
      spec: JSON.stringify({
        createdAt: now(),
        action: "apply generated change package",
        failureType: "direction_mismatch",
        directionMismatch: true,
        diffSummary: idx === 1 ? "external tool changed the wrong file" : "外部工具偏航，误改了无关配置",
        testReport: "failed because task spec pointed to the wrong target",
      }),
    });
  }

  const first = await schedulerTickProject(projectId);
  assert.equal(first.action, "safety_mode");
  assert.match(first.note, /builder misdirection guard/);

  const riskGate = storage.listGates(projectId).find((gate) => {
    if (gate.type !== "risk") return false;
    const payload = JSON.parse(gate.payload);
    return payload.riskKey === "builder_misdirected_specs";
  });
  assert.ok(riskGate);
  assert.equal(riskGate.blocking, 1);
  assert.equal(riskGate.status, "pending");
  const payload = JSON.parse(riskGate.payload);
  assert.equal(payload.misdirectedTaskCount, 2);
  assert.deepEqual(payload.taskIds.sort(), [`task_misdirected_${projectId}_1`, `task_misdirected_${projectId}_2`].sort());
  assert.match(payload.requiredAction, /Builder task spec|repo context|代码变更包/);

  const second = await schedulerTickProject(projectId);
  assert.equal(second.action, "safety_mode");
  assert.equal(storage.listGates(projectId).filter((gate) => gate.type === "risk" && JSON.parse(gate.payload).riskKey === "builder_misdirected_specs").length, 1);
});

test("scheduler degrades timed-out builder tasks and creates a nonblocking audit gate", async () => {
  const previousTimeout = process.env.ALAYA_BUILDER_TIMEOUT_MS;
  process.env.ALAYA_BUILDER_TIMEOUT_MS = "1";
  const projectId = "proj_builder_666";
  createProject(projectId);
  const cycle = storage.listCycles(projectId)[0];
  storage.updateCycle(cycle.id, { status: "running" });
  storage.createGate({
    id: `gate_direction_${projectId}`,
    cycleId: cycle.id,
    type: "direction",
    blocking: 1,
    title: "方向已批准",
    payload: JSON.stringify({ createdAt: now(), resolvedAt: now() }),
    status: "approved",
    estimatedMinutes: 10,
    decision: "approve_recommended",
    version: 1,
  });
  const staleCreatedAt = new Date(Date.now() - 5_000).toISOString();
  storage.createTask({
    id: `task_stale_builder_${projectId}`,
    cycleId: cycle.id,
    agent: "builder",
    kind: "build",
    status: "open",
    spec: JSON.stringify({ createdAt: staleCreatedAt, action: "external build package" }),
  });

  try {
    const tick = await schedulerTickProject(projectId);
    assert.equal(tick.action, "waiting_blocking_gate");
    assert.match(tick.note, /builder timeout degraded 1 task/);

    const task = storage.listTasks(cycle.id).find((t) => t.id === `task_stale_builder_${projectId}`);
    assert.equal(task?.status, "timeout_degraded");
    const spec = JSON.parse(task!.spec);
    assert.ok(spec.timeoutDegradedAt);
    assert.equal(spec.auditSummary.stage, "builder_timeout_degraded");

    const gate = storage.listGates(projectId).find((g) => g.title === "Builder 超时降级审计");
    assert.ok(gate);
    assert.equal(gate.blocking, 0);
    assert.equal(gate.status, "pending");
    const payload = JSON.parse(gate.payload);
    assert.equal(payload.riskKey, "builder_timeout_degraded");
    assert.equal(payload.taskId, `task_stale_builder_${projectId}`);
  } finally {
    if (previousTimeout == null) delete process.env.ALAYA_BUILDER_TIMEOUT_MS;
    else process.env.ALAYA_BUILDER_TIMEOUT_MS = previousTimeout;
  }
});

test("scheduler opens direction gate, imports GitHub issue, approves meaning gate into knowledge, then injects it next cycle", async () => {
  const projectId = "proj_sched_777";
  createProject(projectId);
  upsertGithubSource(projectId, "acme", "alaya");

  const first = await schedulerTickProject(projectId);
  assert.equal(first.action, "opened_direction_gate");

  const directionGate = storage.listGates(projectId).find((g) => g.type === "direction" && g.blocking === 1);
  assert.ok(directionGate);
  approveGate(directionGate.id, "approve_recommended");

  const fake = installFakeGithubFetch("发布预览 preview is critical and setup feedback is unclear");
  try {
    const second = await schedulerTickProject(projectId);
    assert.equal(second.action, "ran_operational_stages");
    assert.ok(fake.calls.some((url) => url.includes("/repos/acme/alaya/issues")));
  } finally {
    fake.restore();
  }

  const cycle = storage.listCycles(projectId).find((c) => c.idx === 1);
  assert.equal(cycle?.status, "closed");
  assert.ok(storage.listFeedback(cycle!.id).some((f) => f.id.includes("fb_github_")));
  const externalGate = storage.listGates(projectId).find((g) => g.id.startsWith("gate_ext_"));
  assert.ok(externalGate);
  assert.equal(externalGate.type, "meaning");

  new HumanGateService(storage).approve(externalGate.id, { actor: "human", via: "test" });
  const approvedKnowledge = storage.listKnowledge(projectId).find((item) => item.sourceRef === "github:acme/alaya#42");
  assert.ok(approvedKnowledge);
  assert.equal(approvedKnowledge.status, "active");
  assert.equal(approvedKnowledge.humanApprovedCount, 1);

  const third = await schedulerTickProject(projectId);
  assert.equal(third.action, "created_next_cycle");
  const cycle2 = storage.listCycles(projectId).find((c) => c.idx === 2 && c.status === "planning");
  assert.ok(cycle2);
  assert.equal(third.budget.safetyMode, false);

  const fourth = await schedulerTickProject(projectId);
  assert.equal(fourth.action, "opened_direction_gate");
  const injected = storage.listEvents().some((event) => {
    if (event.actor !== "knowledge_injection" || event.op !== "inject") return false;
    const after = event.after ? JSON.parse(event.after) : {};
    return after.id === approvedKnowledge.id && after.projectId === projectId;
  });
  assert.equal(injected, true);
});

test("UI-created project first direction gate uses onboarding seed instead of demo scenario", async () => {
  const project = await createProjectFromOnboarding({
    name: "Onboarding Specific Product",
    oneLiner: "把客服录音自动转成可追责改进清单",
    targetUser: "需要持续复盘服务质量的小团队",
    currentHypothesis: "服务团队愿意先批准低风险复盘建议",
    neverDo: "不自动联系客户",
    redlines: ["不得泄露客户隐私", "不得自动发送外部消息"],
    founderPreference: "宁可慢也要可追责",
    competitors: "手工质检表",
    feedbackSources: "客服录音转写和表单",
    weeklyHumanMinutes: 90,
    weeklyLlmBudgetCents: 70,
    firstClaimMetric: "approved_review_gate_count",
    firstClaimOperator: ">=",
    firstClaimTarget: 1,
    firstSignal: "负责人愿意批准第一轮方向闸",
  });

  const opened = await schedulerTickProject(project.id);
  assert.equal(opened.action, "opened_direction_gate");
  const cycle = storage.listCycles(project.id).find((c) => c.idx === 1);
  assert.ok(cycle);
  const gate = storage.listGates(project.id).find((g) => g.cycleId === cycle.id && g.type === "direction");
  assert.ok(gate);
  const payload = JSON.parse(gate.payload);

  assert.match(payload.recommended, /服务团队愿意先批准低风险复盘建议/);
  assert.match(payload.belief, /服务团队愿意先批准低风险复盘建议/);
  assert.match(payload.prediction, /负责人愿意批准第一轮方向闸/);
  assert.match(payload.action, /客服录音自动转成可追责改进清单/);
  assert.doesNotMatch(payload.recommended, /一键发布/);

  approveGate(gate.id, "approve_recommended");
  await runOperationalStagesAfterApprovedDirection(project.id, cycle.id);

  const prediction = storage.listPredictions(cycle.id)[0];
  assert.ok(prediction);
  const claims = JSON.parse(prediction.claims);
  assert.equal(claims[0].metric, "approved_review_gate_count");
  assert.equal(claims[0].operator, ">=");
  assert.equal(claims[0].target, 1);
  assert.equal(claims[0].expectedObservation, "approved_review_gate_count >= 1");
  assert.equal(claims[0].successThreshold, "approved_review_gate_count >= 1");
  assert.equal(claims[0].failureThreshold, "approved_review_gate_count < 1");
});

test("orchestrator reuses an existing deterministic direction gate on repeated ticks", async () => {
  const projectId = "proj_orchestrator_idempotent";
  createProject(projectId);
  const cycle = storage.listCycles(projectId)[0];
  const scenario = SCENARIO[0];
  let llmCalls = 0;
  const fakeLlm = async (input: any) => {
    llmCalls += 1;
    return {
      ...input.mockOutput,
      goal: llmCalls === 1 ? "stable first direction" : "drifting second direction",
      reasoning: llmCalls === 1 ? "stable first reasoning" : "drifting second reasoning",
    };
  };

  const first = await runOrchestrator(projectId, cycle.id, scenario, fakeLlm);
  const second = await runOrchestrator(projectId, cycle.id, scenario, fakeLlm);
  const gates = storage.listGates(projectId).filter((gate) => gate.cycleId === cycle.id && gate.type === "direction");
  const updatedCycle = storage.getCycle(cycle.id);

  assert.equal(second.gate.id, first.gate.id);
  assert.equal(second.goal, first.goal);
  assert.equal(updatedCycle?.goal, first.goal);
  assert.equal(gates.length, 1);
  assert.equal(llmCalls, 1);
});

test("sensor stage is idempotent when a cycle is resumed after partial feedback writes", async () => {
  const projectId = "proj_sensor_resume_idempotent";
  createProject(projectId);
  const cycle = storage.listCycles(projectId)[0];
  const scenario = SCENARIO[0];

  await runSensor(projectId, cycle.id, scenario);
  await runSensor(projectId, cycle.id, scenario);

  assert.equal(storage.listFeedback(cycle.id).length, scenario.feedback.length);
  assert.equal(
    storage.listGates(projectId).filter((gate) => gate.cycleId === cycle.id && gate.type === "meaning").length,
    scenario.feedback.filter((feedback) => feedback.category === "unclear_signal").length,
  );
});

test("LLM onboarding seed preserves machine-readable interview fields", async () => {
  const fakeLlm = async (input: any) => ({
    ...input.mockOutput,
    seedIdentity: "A polished narrative identity that does not repeat labels.",
    worldModel: "A polished narrative world model that omits parser labels.",
    firstGoal: "LLM freeform first goal",
  });
  const project = await createProjectFromOnboarding({
    name: "LLM Freeform Onboarding",
    oneLiner: "把用户反馈变成可审计的产品实验",
    targetUser: "需要持续验证假设的小团队",
    currentHypothesis: "用户更愿意批准可回滚的低风险实验",
    neverDo: "不自动执行高风险动作",
    redlines: ["不得泄露隐私", "不得跳过人工闸门"],
    founderPreference: "先小步验证再扩大自动化范围",
    competitors: "手动用户访谈",
    feedbackSources: "GitHub Issues 和表单反馈",
    weeklyHumanMinutes: 95,
    weeklyLlmBudgetCents: 60,
    firstClaimMetric: "rollback_gate_approval_count",
    firstClaimOperator: ">=",
    firstClaimTarget: 1,
    firstSignal: "负责人批准可回滚实验方向闸",
  }, fakeLlm);

  assert.match(project.seedIdentity, /身份:LLM Freeform Onboarding/);
  assert.match(project.seedIdentity, /LLM补充:/);
  assert.match(project.seedIdentity, /polished narrative identity/);
  assert.match(project.worldModel, /初始假设:用户更愿意批准可回滚的低风险实验/);
  assert.match(project.worldModel, /第一轮希望看到的信号:负责人批准可回滚实验方向闸/);
  assert.match(project.worldModel, /第一轮可观测指标:rollback_gate_approval_count >= 1/);
  assert.match(project.worldModel, /LLM补充:/);

  const opened = await schedulerTickProject(project.id);
  assert.equal(opened.action, "opened_direction_gate");
  const cycle = storage.listCycles(project.id).find((c) => c.idx === 1);
  assert.ok(cycle);
  const gate = storage.listGates(project.id).find((g) => g.cycleId === cycle.id && g.type === "direction");
  assert.ok(gate);
  const payload = JSON.parse(gate.payload);
  assert.match(payload.belief, /用户更愿意批准可回滚的低风险实验/);
  assert.match(payload.prediction, /负责人批准可回滚实验方向闸/);
  assert.doesNotMatch(payload.recommended, /一键发布/);
});

test("Project Setup edits keep project seed knowledge synchronized", async () => {
  const project = await createProjectFromOnboarding({
    name: "Project Setup Sync Product",
    oneLiner: "把团队复盘沉淀成可追责行动",
    targetUser: "需要复盘闭环的小团队",
    currentHypothesis: "负责人愿意批准更透明的行动建议",
    neverDo: "不自动通知客户",
    redlines: ["不得泄露客户隐私"],
    founderPreference: "宁可慢也要可审计",
    competitors: "手工会议纪要",
    feedbackSources: "表单和 GitHub Issues",
    weeklyHumanMinutes: 80,
    weeklyLlmBudgetCents: 90,
    firstClaimMetric: "approved_action_count",
    firstClaimOperator: ">=",
    firstClaimTarget: 1,
    firstSignal: "负责人愿意批准第一条行动建议",
  });

  const updatedIdentity = "身份:人工校准后的 Project Setup Sync Product\n目标用户:复盘负责人\n红线:不得自动外发";
  const updatedWorldModel = "初始假设:人工校准后的世界模型\n第一轮希望看到的信号:负责人批准校准后的行动";
  const updated = updateProjectConfig(project.id, {
    seedIdentity: updatedIdentity,
    worldModel: updatedWorldModel,
  });

  assert.ok(updated);
  assert.equal(updated.seedIdentity, updatedIdentity);
  assert.equal(updated.worldModel, updatedWorldModel);

  const knowledge = storage.listKnowledge(project.id);
  const identity = knowledge.find((item) => item.type === "identity" && item.title === "种子身份");
  const world = knowledge.find((item) => item.type === "world_model" && item.title === "初始世界模型");
  assert.ok(identity);
  assert.ok(world);
  assert.equal(identity.content, updatedIdentity);
  assert.equal(world.content, updatedWorldModel);
  assert.equal(identity.approvedBy, "owner");
  assert.equal(world.approvedBy, "owner");
  assert.match(identity.notes, /project setup 人工校准同步/);
  assert.match(world.notes, /project setup 人工校准同步/);
});

test("scheduler syncs feedback but waits until the sensor feedback window expires", async () => {
  const previousWindow = process.env.ALAYA_SENSOR_FEEDBACK_WINDOW_MS;
  process.env.ALAYA_SENSOR_FEEDBACK_WINDOW_MS = "600000";
  try {
    const projectId = "proj_window_333";
    createProject(projectId);
    upsertGithubSource(projectId, "acme", "alaya");

    const first = await schedulerTickProject(projectId);
    assert.equal(first.action, "opened_direction_gate");
    const cycle = storage.listCycles(projectId)[0];
    const directionGate = storage.listGates(projectId).find((g) => g.cycleId === cycle.id && g.type === "direction");
    assert.ok(directionGate);
    approveGate(directionGate.id, "approve_recommended");

    const fake = installFakeGithubFetch("Window feedback is unclear");
    try {
      const waiting = await schedulerTickProject(projectId);
      assert.equal(waiting.action, "waiting_feedback_window");
      assert.match(waiting.note, /synced feedback only/);
      assert.ok(fake.calls.some((url) => url.includes("/repos/acme/alaya/issues")));
      assert.equal(storage.getCycle(cycle.id)?.status, "running");
      assert.equal(storage.listPredictions(cycle.id).length, 0);
      assert.ok(storage.listFeedback(cycle.id).some((f) => f.id.includes("fb_github_")));

      process.env.ALAYA_SENSOR_FEEDBACK_WINDOW_MS = "1";
      await new Promise((resolve) => setTimeout(resolve, 5));
      const ran = await schedulerTickProject(projectId);
      assert.equal(ran.action, "ran_operational_stages");
      assert.equal(storage.getCycle(cycle.id)?.status, "closed");
      assert.equal(storage.listPredictions(cycle.id).length, 1);
    } finally {
      fake.restore();
    }
  } finally {
    if (previousWindow == null) delete process.env.ALAYA_SENSOR_FEEDBACK_WINDOW_MS;
    else process.env.ALAYA_SENSOR_FEEDBACK_WINDOW_MS = previousWindow;
  }
});

test("scheduler can compound through four flywheel cycles without duplicating gates or predictions", async () => {
  const projectId = "proj_four_888";
  createProject(projectId);

  for (let idx = 1; idx <= 4; idx++) {
    const opened = await schedulerTickProject(projectId);
    assert.equal(opened.action, "opened_direction_gate");

    const cycle = storage.listCycles(projectId).find((c) => c.idx === idx);
    assert.ok(cycle);
    const gate = storage.listGates(projectId).find((g) => g.cycleId === cycle.id && g.type === "direction" && g.blocking === 1);
    assert.ok(gate);
    approveGate(gate.id, "approve_recommended");

    const ran = await schedulerTickProject(projectId);
    assert.equal(ran.action, "ran_operational_stages");
    assert.equal(storage.getCycle(cycle.id)?.status, "closed");
    for (const proposalGate of storage.listGates(projectId).filter((g) => {
      if (g.cycleId !== cycle.id || g.status !== "pending" || g.type !== "meaning") return false;
      const payload = JSON.parse(g.payload);
      return payload.source === "distiller_proposal";
    })) {
      new HumanGateService(storage).approve(proposalGate.id, { actor: "human", via: "test" });
    }

    if (idx < 4) {
      const created = await schedulerTickProject(projectId);
      assert.equal(created.action, "created_next_cycle");
      assert.ok(storage.listCycles(projectId).some((c) => c.idx === idx + 1 && c.status === "planning"));
    }
  }

  const cycles = storage.listCycles(projectId);
  assert.equal(cycles.length, 4);
  assert.equal(cycles.every((c) => c.status === "closed"), true);

  for (const cycle of cycles) {
    const agents = new Set(storage.listAgentRuns(cycle.id).map((r) => r.agent));
    assert.deepEqual([...agents].sort(), ["builder", "distiller", "librarian", "orchestrator", "sensor"]);
  }

  const gateIds = storage.listGates(projectId).map((g) => g.id);
  assert.equal(new Set(gateIds).size, gateIds.length);

  const predictions = storage.listPredictionsByProject(projectId);
  assert.equal(predictions.length, 4);
  assert.equal(new Set(predictions.map((p) => p.id)).size, 4);

  const cycle3 = cycles.find((c) => c.idx === 3);
  const cycle4 = cycles.find((c) => c.idx === 4);
  assert.ok(cycle3);
  assert.ok(cycle4);

  const cycle3Prediction = predictions.find((p) => p.cycleId === cycle3.id);
  const cycle4Prediction = predictions.find((p) => p.cycleId === cycle4.id);
  assert.ok(cycle3Prediction);
  assert.ok(cycle4Prediction);
  assert.notEqual(cycle4Prediction.action, cycle3Prediction.action);
  assert.match(cycle4Prediction.id, /pred_c4_rollback_/);
  assert.match(cycle4Prediction.action, /回滚|审计/);

  const cycle4Gate = storage.listGates(projectId).find((g) => g.cycleId === cycle4.id && g.type === "direction");
  assert.ok(cycle4Gate);
  assert.match(cycle4Gate.id, /gate_dir_c4_rollback_/);
  assert.match(cycle4Gate.title, /可回滚执行闸/);
  const cycle4Payload = JSON.parse(cycle4Gate.payload);
  assert.ok(cycle4Payload.rollbackPlan);
  assert.ok(cycle4Payload.auditSummary);
  assert.equal(cycle4Payload.rollbackPlan.packageType, "rollback-ready change package");
  assert.deepEqual(cycle4Payload.rollbackPlan.modifiedObjects, [
    "high-risk action execution plan",
    "dry-run preview result",
    "release audit log",
  ]);
  assert.match(cycle4Payload.rollbackTrigger, /activation_rate < 0.45/);
  assert.equal(cycle4Payload.rollbackPlan.riskLevel, "high");
  assert.match(cycle4Payload.auditSummary.deltaFromCycle3, /第3轮解决看到将改什么/);

  const cycle4Task = storage.listTasks(cycle4.id).find((t) => t.agent === "builder");
  assert.ok(cycle4Task);
  const cycle4TaskSpec = JSON.parse(cycle4Task.spec);
  assert.ok(cycle4TaskSpec.rollbackReadyChangePackage);
  assert.ok(cycle4TaskSpec.auditSummary);
  assert.match(cycle4TaskSpec.rollbackReadyChangePackage.rollbackTrigger, /不可逆|不可追责|activation_rate/);

  const llmCalls = storage.listLlmCalls().filter((call) => cycles.some((cycle) => cycle.id === call.cycleId));
  assert.equal(llmCalls.length >= 20, true);

  const scenarioFeedback = storage.listFeedback(cycles[0].id);
  assert.equal(scenarioFeedback.every((f) => f.sourceType === "scenario"), true);
  assert.equal(scenarioFeedback.every((f) => f.sourceRef.length > 0), true);
  assert.equal(scenarioFeedback.every((f) => f.topicKey.length > 0), true);

  const knowledge = storage.listKnowledge(projectId);
  const cycle4Principle = knowledge.find((k) => k.createdByCycle === 4 && k.type === "principle");
  assert.ok(cycle4Principle);
  assert.match(cycle4Principle.title, /可回滚路径与审计摘要/);
  assert.match(cycle4Principle.content, /rollback-ready change package/);
  assert.match(cycle4Principle.content, /audit summary/);
  assert.equal(knowledge.some((k) => k.status === "strong"), true);

  const autonomous = await schedulerTickProject(projectId);
  assert.equal(autonomous.action, "created_next_cycle");
  assert.match(autonomous.note, /created next planning cycle/);
  assert.equal(storage.listCycles(projectId).length, 5);
  assert.ok(storage.listCycles(projectId).find((cycle) => cycle.idx === 5)?.goal);
});

test("flywheel plan and task spec consume LLM output while preserving audit guardrails", async () => {
  const projectId = "proj_llm_plan_999";
  createProject(projectId);
  const cycle = storage.listCycles(projectId)[0];
  const scenario = SCENARIO[0];

  const fakeLlm = async (input: any) => {
    if (input.agent === "orchestrator") {
      return {
        summary: "LLM selected a project-specific first cycle",
        goal: "LLM 目标: 先验证人工闸门是否降低重复决策",
        belief: "LLM belief: owner trust depends on visible gates",
        prediction: "LLM prediction: approving the first gate improves activation",
        action: "LLM action: build a gated review checklist",
        reasoning: "LLM reasoning: onboarding world model changed the default one-click publish plan",
        knowledgeRefs: ["kb_does_not_exist"],
      };
    }
    if (input.agent === "builder") {
      return {
        summary: "LLM task spec emitted",
        buildSuccess: false,
        diffSummary: "LLM diff: create gated review checklist task",
        testReport: "LLM test report: checklist scenario reviewed",
      };
    }
    if (input.agent === "distiller") {
      return {
        summary: "LLM distilled first-cycle knowledge",
        items: [{
          createdByCycle: 1,
          title: "LLM K1: operators need visible change boundaries",
          content: "LLM content: operators hesitate when automation cannot show the exact change boundary.",
          sourceRef: "llm:f1,f2",
          tags: ["llm_generated"],
          notes: "LLM candidate rationale should survive into notes.",
        }],
      };
    }
    return input.mockOutput;
  };

  const plan = await runOrchestrator(projectId, cycle.id, scenario, fakeLlm);
  assert.equal(plan.goal, "LLM 目标: 先验证人工闸门是否降低重复决策");
  assert.equal(plan.action, "LLM action: build a gated review checklist");
  assert.deepEqual(plan.refs, [], "nonexistent LLM knowledge refs must be filtered");

  const updatedCycle = storage.getCycle(cycle.id);
  assert.equal(updatedCycle?.goal, plan.goal);
  assert.match(updatedCycle?.reasoning ?? "", /onboarding world model changed/);

  const gate = storage.listGates(projectId).find((item) => item.cycleId === cycle.id && item.type === "direction");
  assert.ok(gate);
  const payload = JSON.parse(gate.payload);
  assert.equal(payload.recommended, plan.goal);
  assert.equal(payload.action, plan.action);
  assert.deepEqual(payload.knowledgeRefs, []);

  await runBuilder(cycle.id, scenario, plan.action, plan.refs, fakeLlm);
  const task = storage.listTasks(cycle.id).find((item) => item.agent === "builder");
  assert.ok(task);
  assert.equal(task.status, "done", "tool-reported build result remains authoritative");
  const spec = JSON.parse(task.spec);
  assert.equal(spec.action, plan.action);
  assert.equal(spec.diffSummary, "LLM diff: create gated review checklist task");
  assert.equal(spec.testReport, "LLM test report: checklist scenario reviewed");
  assert.equal(spec.toolReportedBuildSuccess, true);
  assert.equal(spec.llmReportedBuildSuccess, false);

  const { claimError } = evaluatePrediction(projectId, cycle.id, scenario, plan);
  const created = await runDistiller(projectId, cycle.id, scenario, claimError, plan.refs, fakeLlm);
  assert.equal(created.length, 1);
  const proposal = storage.getDistillerProposal(created[0]);
  assert.equal(proposal?.status, "gated");
  assert.equal(storage.listKnowledge(projectId).filter((item) => item.sourceRef === "llm:f1,f2").length, 0);
  const gateId = proposal?.gateId;
  assert.ok(gateId);
  new HumanGateService(storage).approve(gateId, { actor: "human", via: "test" });
  const knowledge = storage.getKnowledge(JSON.parse(proposal?.proposedContent ?? "{}").id);
  assert.ok(knowledge);
  assert.equal(knowledge.title, "LLM K1: operators need visible change boundaries");
  assert.equal(knowledge.content, "LLM content: operators hesitate when automation cannot show the exact change boundary.");
  assert.equal(knowledge.sourceRef, "llm:f1,f2");
  assert.equal(knowledge.notes, "LLM candidate rationale should survive into notes.");
  assert.deepEqual(JSON.parse(knowledge.tags).sort(), ["adoption", "llm_generated", "user_fear"]);
  assert.equal(knowledge.createdBy, "distiller_proposal");
  assert.equal(knowledge.status, "active");
});
