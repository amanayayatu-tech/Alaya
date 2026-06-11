import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

process.env.ALAYA_DB_PATH = join(mkdtempSync(join(tmpdir(), "alaya-principles-test-")), "test.db");
process.env.ALAYA_LLM_PROVIDER = "mock";

const testDir = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(testDir, "..");
const repoRoot = resolve(appRoot, "..");

const { computeCycleError } = await import("alaya-core/src/core/compute_error.ts");
const { classifyError } = await import("alaya-core/src/core/classify_error.ts");
const { applyEvidence } = await import("alaya-core/src/core/update_confidence.ts");
const { eligibleForHighRisk, transitionState } = await import("alaya-core/src/core/transition_state.ts");
const { storage, rawDb } = await import("../server/storage.ts");

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path, acc);
    else if (name.endsWith(".ts")) acc.push(path);
  }
  return acc;
}

function baseKnowledge(overrides: Record<string, unknown> = {}) {
  return {
    id: "kb_guard",
    projectId: "proj_guard",
    type: "principle",
    title: "高风险动作必须可预览",
    content: "高风险动作需要 preview, rollback and audit。",
    sourceType: "metric",
    sourceRef: "guard",
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
    tags: ["preview", "rollback", "audit"],
    notes: "",
    version: 1,
    ...overrides,
  } as any;
}

function dbKnowledge(id: string, overrides: Record<string, unknown> = {}) {
  return {
    ...baseKnowledge({
      id,
      tags: JSON.stringify(["preview", "rollback", "audit"]),
      semanticKey: "",
      supersededBy: null,
      ...overrides,
    }),
  };
}

test("bottom line 1: core pure functions are deterministic and do not write storage", () => {
  const claims = [{
    id: "claim_guard",
    type: "metric_threshold" as const,
    metric: "activation_rate",
    operator: ">=" as const,
    target: 0.3,
    observed: 0.12,
    scale: 0.3,
    weight: 3,
  }];
  const expectedError = computeCycleError(claims);
  for (let i = 0; i < 100; i += 1) assert.deepEqual(computeCycleError(claims), expectedError);

  const ctx = { perceptionFailure: false, executionFailure: false, humanFlaggedValueMismatch: false, isQualitative: false };
  for (let i = 0; i < 100; i += 1) assert.equal(classifyError(0.8, ctx), "model");

  const eventsA = [
    { kind: "prediction" as const, normalizedError: 0.2 },
    { kind: "human_approve" as const },
    { kind: "external_verify" as const },
  ];
  const eventsB = [...eventsA].reverse();
  const applyAll = (events: typeof eventsA) => events.reduce((item, event) => applyEvidence(item, event).next, baseKnowledge());
  assert.deepEqual(applyAll(eventsA), applyAll(eventsB));

  const before = storage.listEvents().length;
  transitionState(baseKnowledge({ evidenceAlpha: 8, evidenceBeta: 1, confidenceScore: 8 / 9, humanApprovedCount: 1 }), {
    currentCycle: 1,
    conflictsWithStrong: false,
    humanApprovedStrongPromotion: false,
  });
  assert.equal(storage.listEvents().length, before);
});

test("bottom line 2: active to strong is blocked without explicit human approval", () => {
  const candidate = baseKnowledge({
    status: "active",
    evidenceAlpha: 8,
    evidenceBeta: 1,
    confidenceScore: 8 / 9,
    humanApprovedCount: 1,
  });
  const blocked = transitionState(candidate, {
    currentCycle: 4,
    conflictsWithStrong: false,
    humanApprovedStrongPromotion: false,
  });
  assert.equal(blocked.nextStatus, "active");
  assert.equal(blocked.changed, false);
  assert.equal(blocked.requiresHuman, true);

  const approved = transitionState(candidate, {
    currentCycle: 4,
    conflictsWithStrong: false,
    humanApprovedStrongPromotion: true,
  });
  assert.equal(approved.nextStatus, "strong");
  assert.equal(approved.requiresHuman, true);
});

test("bottom line 3: storage writes create event_log records with actors and rawDb writes do not", () => {
  storage.createKnowledge(dbKnowledge("kb_guard_audit"));
  const before = storage.listEvents().length;
  const updated = storage.updateKnowledge("kb_guard_audit", { notes: "updated through storage", actor: "principles_guard" });
  assert.equal(updated?.notes, "updated through storage");
  const audit = storage.listEvents().find((event) => event.tableName === "knowledge_items" && event.actor === "principles_guard");
  assert.ok(audit, "storage update should write an audited event with actor");

  rawDb.prepare("UPDATE knowledge_items SET notes=? WHERE id=?").run("raw bypass", "kb_guard_audit");
  assert.equal(storage.listEvents().length, before + 1);
});

test("bottom line 4: polluted knowledge is excluded from high-risk evidence eligibility", () => {
  for (const status of ["quarantined", "conflict", "stale", "expired"]) {
    assert.equal(eligibleForHighRisk(baseKnowledge({ status })), false, `${status} should be excluded`);
  }
  assert.equal(eligibleForHighRisk(baseKnowledge({ status: "active" })), true);
  assert.equal(eligibleForHighRisk(baseKnowledge({ status: "strong" })), true);
});

test("bottom line 5: gray-zone feedback weakly accumulates and can trigger meaning gate", () => {
  const weakSupport = applyEvidence(baseKnowledge(), { kind: "prediction", normalizedError: 0.4 });
  assert.equal(weakSupport.grayZone, true);
  assert.equal(weakSupport.next.evidenceAlpha, 1.5);
  assert.equal(weakSupport.next.evidenceBeta, 1);

  const weakOppose = applyEvidence(baseKnowledge(), { kind: "prediction", normalizedError: 0.6 });
  assert.equal(weakOppose.grayZone, true);
  assert.equal(weakOppose.next.evidenceAlpha, 1);
  assert.equal(weakOppose.next.evidenceBeta, 1.5);

  for (let streak = 0; streak < 10; streak += 1) {
    const result = applyEvidence(baseKnowledge(), { kind: "prediction", normalizedError: 0.4 }, streak);
    assert.equal(result.suggestMeaningGate, streak >= 2);
  }
});

test("bottom line 6: business code does not import OpenAI or Anthropic SDKs directly", () => {
  const sdkImport = /\bfrom\s+["'](?:openai|anthropic|@anthropic-ai\/[^"']+)["']|\brequire\(\s*["'](?:openai|anthropic)["']\s*\)/;
  const files = [...walk(join(appRoot, "server")), ...walk(join(repoRoot, "alaya-core", "src"))];
  const offenders = files
    .filter((file) => !/(^|\/)(llm|provider)\.ts$/.test(file))
    .filter((file) => sdkImport.test(readFileSync(file, "utf8")));
  assert.deepEqual(offenders, []);

  const appLlm = readFileSync(join(appRoot, "server", "llm.ts"), "utf8");
  assert.equal(/export\s+.*(?:openai|anthropic)/i.test(appLlm), false);
});
